# murmur

Local meeting recorder, transcriber, and summarizer for macOS. Records an Aggregate Device with `ffmpeg`, transcribes with `whisply` (mlx-whisper + optional speaker diarization), and summarizes with a local LLM via `ollama`. Everything runs locally — no cloud, no third parties.

One stack: a single [Bun](https://bun.sh)/TypeScript codebase in `src/` provides both the **`murmur` CLI** (manual control) and a long-lived **daemon** (automatic, GPU-pause-aware processing). They share the same modules, so every step has one implementation.

```
record (ffmpeg) ─▶ recordings/*.wav ─▶ whisply (mlx + diarize) ─▶ ollama ─▶ summaries/*.md
                                        └ daemon: watch · serial queue · GPU-pause · auto-defer-while-recording
```

## Install

```sh
brew install ffmpeg ollama terminal-notifier      # terminal-notifier optional (notifications)
# Bun — via mise, or: curl -fsSL https://bun.sh/install | bash
uv tool install whisply                            # transcription engine (bundles mlx-whisper on Apple Silicon)
ollama pull qwen3.6:27b-mlx                         # or whatever you set as MODEL_SUMMARY
```

Put `murmur` on your PATH (the CLI is an executable Bun script — no build/install step):
```sh
ln -s "$PWD/src/cli.ts" ~/.local/bin/murmur
```

Create an **Aggregate Device** (mic + system audio, e.g. via BlackHole) in *Audio MIDI Setup* and note its avfoundation audio index:
```sh
ffmpeg -f avfoundation -list_devices true -i ""
```

## Configure

`config.sh` (gitignored; see `config.sh.example`) is sourced for configuration. Only the first two are required:
```sh
export MEETINGS_BASE="$HOME/Recordings/Meetings"
export MODEL_SUMMARY="qwen3.6:27b-mlx"
export RECORD_DEVICE_INDEX=1        # avfoundation index of your Aggregate Device
export DIARIZE=1                    # speaker labels (see Diarization below)
# HF_TOKEN for diarization — set directly, or source a secrets manager, e.g.:
[ -f "$HOME/.zsh/env/.secrets-cache" ] && source "$HOME/.zsh/env/.secrets-cache"
```
Defaults for everything else live in `src/config.ts` (port 7461, whisply model `large-v3-turbo`, language `cs`, device `mlx`, `MAX_DURATION_SECONDS=7200`, …).

## Usage — the `murmur` CLI

```sh
murmur record [--device N]   # start recording the Aggregate Device
murmur stop                  # stop recording
murmur process [audio]       # transcribe + summarize (newest, or by path/basename)
murmur transcribe [audio]    # transcribe only → prints transcript path
murmur summarize <name>      # summarize a transcript → prints summary path
murmur status                # recording / pause / queue state (JSON)
murmur pause [hard]          # pause processing (soft = finish current; hard = abort + requeue)
murmur resume
murmur daemon                # run the orchestrator daemon in the foreground
```

Outputs land in `$MEETINGS_BASE/{transcripts,summaries}/`. Stateful commands (`record`/`stop`/`process`/`pause`/`resume`/`status`) use the daemon when it's running, and act directly when it isn't; `transcribe`/`summarize` always run inline. Processing is idempotent — transcription is skipped if `transcripts/<base>.txt` exists and summarization if `summaries/<base>.md` exists.

## The daemon (automatic processing)

The daemon watches `recordings/` and runs each new `.wav` through the pipeline automatically — once the file stops growing, and **deferring while a recording is in progress** (keeps the GPU free during live meetings). It holds a **persistent queue** (one GPU job at a time, survives restarts) and supports **soft/hard pause** to free the GPU on demand.

Run it always-on via the LaunchAgent:
```sh
cp launchd/com.jank.meeting-ai.daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jank.meeting-ai.daemon.plist
launchctl kickstart -k gui/$(id -u)/com.jank.meeting-ai.daemon
tail -f ~/Recordings/Meetings/logs/daemon.{out,err}.log
```
After editing the plist, `bootout` then `bootstrap` again (`kickstart` alone won't re-read it). The plist hard-codes the absolute `bun` path (a mise install) and a `PATH` that resolves `bun`/`whisply`/`ffmpeg`/`ollama`/`terminal-notifier` — update it if you reinstall bun.

> If you ran an older `fswatch` watch agent, stop it so the two don't double-process:
> `launchctl bootout gui/$(id -u)/com.jank.meeting-ai.watch`

### Control API (`http://127.0.0.1:7461`)

The CLI and SwiftBar talk to this; you can too.

| Method + path | Body | Effect |
|---|---|---|
| `GET /status` | — | recording?, pause mode, queue depth + items, current job |
| `POST /record/start` · `/record/stop` | — | start/stop recording |
| `POST /pause` | `{"mode":"soft"\|"hard"}` | soft = finish current then idle; hard = abort + requeue |
| `POST /resume` | — | resume processing |
| `POST /enqueue` | `{"wav":"<path\|basename>","force":true?}` | queue a recording (dedups; skips if already summarized unless `force`) |

## SwiftBar (optional menubar)

```sh
ln -s "$PWD/swiftbar/murmur.5s.sh" "$HOME/Library/Application Support/SwiftBar/Plugins/murmur.5s.sh"
```
(If a stale `murmur.5s.sh` dir/file is already there, `rm -rf` it first.) Shows `🔴` recording / `⚪` idle / `⏸` paused plus the queue depth, with menu actions (start/stop recording, pause/resume). The plugin just calls `murmur swiftbar`, which renders from on-disk state and **works whether or not the daemon is running** — so it reflects a `murmur record` you started directly. Menu clicks run `murmur` too, so they also work in both modes.

## Diarization (speaker labels) — opt-in

Set `DIARIZE=1` and provide `HF_TOKEN` in `config.sh`, and accept the pyannote model conditions once on HuggingFace ([segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)). Transcripts then carry `[SPEAKER_xx]` labels + timestamps. If a diarized run fails (missing token, gated model), it automatically retries without diarization so you still get a transcript.

## Obsidian vault archiving (optional)

Set `OBSIDIAN_VAULT` (and optionally `VAULT_FOLDER`, default `Murmur`) in `config.sh` and each finished summary is **copied** into your vault, organized by month:

```
<OBSIDIAN_VAULT>/Murmur/2026-06/2026-06-18 16-21 <generated title>.md
```

The originals in `~/Recordings/Meetings/summaries` stay the source of truth — the vault is a derived view (summaries only; transcripts aren't copied). Each note gets a short LLM-generated title (also used in the filename, `:`→`-` for macOS/Obsidian safety) and YAML frontmatter:

```yaml
---
title: "Workflow nahrávání meetingů"
date: 2026-06-18
time: "16:21"
source: "meeting-2026-06-18_16-21-05.wav"
duration: "1:13:25"
speakers: 2            # only when diarized
tags: [meeting, murmur]
---
```

Archiving is idempotent (skips if a note with the same `YYYY-MM-DD HH-MM` prefix exists) and best-effort — a vault/iCloud hiccup is logged but never fails the local job. Leave `OBSIDIAN_VAULT` empty to disable.

## Notes

- Recording is hard-capped at `MAX_DURATION_SECONDS` (default 2h). Audio is mono 16 kHz PCM.
- The `pan=` filter in `src/recorder.ts` is tuned for a specific Aggregate Device channel layout (mic on c0/c1, system on c2); adjust if yours differs.
- whisply renames its input and writes a nested output dir, so murmur runs it against a hardlinked copy in `transcripts/.whisply-work/<base>/` and normalizes the result to the flat `transcripts/<base>.txt`. Your recordings are never mutated.
- Summaries use `temperature: 0` for reliable, deterministic instruction-following.
- Daemon state lives in `$MEETINGS_BASE/state/` (`queue.json`, `pause.json`, `current.json`, `daemon.lock`) — inspectable, persistent across restarts. Failures are logged to `$MEETINGS_BASE/logs/process-failures.log`.
- `config.sh` is the only shell file — it's just environment configuration (and a convenient hook for sourcing secrets). All logic is TypeScript in `src/`.
