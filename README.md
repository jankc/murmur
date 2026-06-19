# murmur

Local meeting recorder, transcriber, and summarizer for macOS. Records an Aggregate Device with `ffmpeg`, transcribes with `whisply` (mlx-whisper + optional speaker diarization), and summarizes with a local LLM via `ollama`. Everything runs locally — no cloud, no third parties.

One stack: a single [Bun](https://bun.sh)/TypeScript codebase in `src/` provides both the **`murmur` CLI** (manual control) and a long-lived **daemon** (automatic, GPU-pause-aware processing). They share the same modules, so every step has one implementation.

```
record (ffmpeg) ─▶ .partial/ ─(complete)─▶ inbox/*.wav ─▶ whisply (mlx + diarize) ─▶ ollama ─▶ summaries/*.md ─▶ Obsidian
                                            └ daemon: watch inbox · serial queue · GPU-pause · auto-defer
                       on success the wav moves ─▶ recordings/processed/<YYYY-MM>/   (failure ─▶ recordings/failed/)
```

**A recording's folder is its state.** ffmpeg writes into `recordings/.partial/` (not watched), so an in-progress recording never triggers the pipeline or clutters the inbox. When recording ends the finished `.wav` is moved into `recordings/inbox/` — the only folder the daemon watches. Once fully processed (transcribed → summarized → archived) it's **moved** to `recordings/processed/<YYYY-MM>/`, so it's never re-examined — no growing "already done?" rescans. A non-retryable failure moves it to `recordings/failed/` (so a poison file doesn't retry every restart) and logs a `murmur process` re-run command to `logs/process-failures.log`.

## Install

```sh
brew install ffmpeg ollama terminal-notifier      # terminal-notifier optional (notifications)
# Bun — via mise, or: curl -fsSL https://bun.sh/install | bash
uv tool install whisply                            # transcription engine (bundles mlx-whisper on Apple Silicon)
ollama pull gemma4:26b-mlx                          # or whatever you set as MODEL_SUMMARY
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
export MODEL_SUMMARY="gemma4:26b-mlx"
export RECORD_DEVICE_INDEX=1        # avfoundation index of your Aggregate Device
export DIARIZE=1                    # speaker labels (see Diarization below)
# HF_TOKEN for diarization — set directly, or source a secrets manager, e.g.:
[ -f "$HOME/.zsh/env/.secrets-cache" ] && source "$HOME/.zsh/env/.secrets-cache"
```
Defaults for everything else live in `src/config.ts` (port 7461, whisply model `large-v3-turbo`, language `auto`-detect, device `mlx`, `MAX_DURATION_SECONDS=7200`, …).

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

Outputs land in `$MEETINGS_BASE/{transcripts,summaries}/`. Stateful commands (`record`/`stop`/`process`/`pause`/`resume`/`status`) use the daemon when it's running, and act directly when it isn't; `transcribe`/`summarize` always run inline. A recording's **location is its state** — processing always runs and overwrites prior outputs, so **to reprocess a recording just move its `.wav` from `recordings/processed/<YYYY-MM>/` back into `recordings/inbox/`** (no need to delete the transcript/summary first).

## The daemon (automatic processing)

The daemon watches `recordings/inbox/` and runs each new `.wav` through the pipeline automatically — once the file stops growing, and **deferring while a recording is in progress** (keeps the GPU free during live meetings). It holds a **persistent queue** (one GPU job at a time, survives restarts) and supports **soft/hard pause** to free the GPU on demand. Done recordings move to `processed/<YYYY-MM>/` (see [folder = state](#murmur) above).

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
| `POST /enqueue` | `{"wav":"<path\|basename>"}` | queue a recording for (re)processing (dedups only against what's already queued) |

## SwiftBar (optional menubar)

```sh
ln -s "$PWD/swiftbar/murmur.5s.sh" "$HOME/Library/Application Support/SwiftBar/Plugins/murmur.5s.sh"
```
(If a stale `murmur.5s.sh` dir/file is already there, `rm -rf` it first.) Shows `🔴` recording / `⚪` idle / `⏸` paused plus the queue depth, with menu actions (start/stop recording, pause/resume). The plugin just calls `murmur swiftbar`, which renders from on-disk state and **works whether or not the daemon is running** — so it reflects a `murmur record` you started directly. Menu clicks run `murmur` too, so they also work in both modes.

## Recording backends

Set `RECORD_BACKEND` in `config.sh`:

**`ownscribe`** (recommended) — one helper captures system audio (ScreenCaptureKit) **and** your mic, then merges them **host-time-aligned** on stop. No BlackHole, no aggregate, no output routing → **the macOS volume keys keep working**; and because the two streams are time-synced, the mic's unavoidable speaker bleed reads as "emphasized voice," not an echo. Best for capturing both sides on speakers.

Build the helper once ([ownscribe-audio](https://github.com/paberr/ownscribe), MIT, macOS 14.2+; first run prompts for Screen Recording permission):
```sh
git clone https://github.com/paberr/ownscribe && cd ownscribe/swift
bash build.sh && cp ../bin/ownscribe-audio ~/.local/bin/ownscribe-audio
```
```sh
export RECORD_BACKEND=ownscribe
# export OWNSCRIBE_BIN="$HOME/.local/bin/ownscribe-audio"   # default
```

**`ffmpeg`** (default) — records one avfoundation **Aggregate Device** (mic + system audio via BlackHole) through the `pan=` downmix. One hardware clock, so it's perfectly synced — but routing system audio requires a BlackHole multi-output as the system output, which **disables the volume keys**, and a meeting app grabbing the mic can starve the aggregate. Tune with `RECORD_DEVICE_INDEX` / `RECORD_PAN_FILTER`.

**`audiotee`** — like `ownscribe`, but the system tap ([AudioTee](https://github.com/makeusabrew/audiotee)) and the mic are two *independent* processes mixed on stop; without host-time alignment the mic's speaker bleed can echo on speakers. Kept as an option (fine on headphones) — prefer `ownscribe`. Build: `swift build -c release` in the AudioTee repo (pin `56ac954`) → `~/.local/bin/audiotee`; then `RECORD_BACKEND=audiotee` + `RECORD_MIC_DEVICE`.

## Diarization (speaker labels) — opt-in

Set `DIARIZE=1` and provide `HF_TOKEN` in `config.sh`. Transcripts then carry `[SPEAKER_xx]` labels + timestamps. Two backends (`DIARIZE_BACKEND`):

**`community1`** (recommended) — [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (pyannote.audio 4). whisply transcribes only; a small helper (`diarize/diarize.py`) produces the speaker turns and murmur merges them by timestamp, grouping consecutive same-speaker chunks. Far better turn attribution than 3.1 — it tracks whole turns instead of flip-flopping mid-sentence on a mono meeting mix. Needs a one-time setup (its own venv, since whisply pins the older pyannote):
```sh
uv venv --python 3.12 ~/.local/share/murmur/diarize-venv
uv pip install --python ~/.local/share/murmur/diarize-venv/bin/python "pyannote.audio>=4.0"
```
Accept the [community-1](https://hf.co/pyannote/speaker-diarization-community-1) conditions on HuggingFace once, then:
```sh
export DIARIZE=1
export DIARIZE_BACKEND=community1
# export DIARIZE_NUM_SPEAKERS=3     # optional hint when you know the headcount (0 = auto)
# export DIARIZE_PYTHON="$HOME/.local/share/murmur/diarize-venv/bin/python"   # default
```
If diarization fails (missing venv/token, gated model), the run degrades to a plain transcript rather than losing the meeting.

**`whisply`** (default) — diarization inline via whisply's bundled pyannote 3.1. No extra setup, but lower-quality attribution; accept the [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) + [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) conditions on HuggingFace. A failed diarized run retries without diarization.

## Obsidian vault archiving (optional)

Set `OBSIDIAN_VAULT` (and optionally `VAULT_FOLDER`, default `Murmur`) in `config.sh` and each finished summary is **copied** into your vault, organized by month:

```
<OBSIDIAN_VAULT>/Murmur/2026-06/2026-06-18 16-21 <generated title>.md
```

The originals in `~/Recordings/Meetings/summaries` stay the source of truth — the vault is a derived view (summaries only; transcripts aren't copied). Each note gets a short title — produced as the summary's own first heading, so archiving needs no extra model call (older, title-less summaries fall back to a dedicated title call). The title is also used in the filename (`:`→`-` for macOS/Obsidian safety), alongside YAML frontmatter:

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

Archiving replaces any prior note for the same recording (matched on the `YYYY-MM-DD HH-MM` prefix), so reprocessing refreshes the vault without leaving duplicates, and it's best-effort — a vault/iCloud hiccup is logged but never fails the local job. Leave `OBSIDIAN_VAULT` empty to disable.

## Notes

- Recording is hard-capped at `MAX_DURATION_SECONDS` (default 2h). Audio is mono 16 kHz PCM.
- **ffmpeg backend:** recording downmixes the 3-channel Aggregate Device to mono with a `pan=` filter (default in `src/config.ts`): `c0+c1` = BlackHole 2ch (system audio — the other participants), `c2` = the microphone (your voice). If your Aggregate Device orders its sub-devices differently, set `RECORD_PAN_FILTER` in `config.sh` — a wrong channel map is the usual reason a capture comes out mute or lopsided.
- On `stop`, murmur measures the recording's level and warns (notification + log) if it's effectively silent — per-track for the `audiotee` backend (system vs mic), whole-file for `ffmpeg`. Usual causes: a routing slip (system output not on the BlackHole multi-output) or a muted/grabbed mic. Threshold: `RECORD_SILENCE_DB` (default `-80` dBFS).
- whisply renames its input and writes a nested output dir, so murmur runs it against a hardlinked copy in `transcripts/.whisply-work/<base>/` and normalizes the result to the flat `transcripts/<base>.txt`. Your recordings are never mutated.
- Each pipeline stage streams to its own log under `logs/`: ffmpeg → `meeting-<ts>.log`, audiotee → `<base>.audiotee.log`, whisply → `whisply-<base>.log` (both stdout+stderr, so a failure's tail is preserved and a chatty child can never stall on a full pipe buffer).
- Summaries use `temperature: 0` for reliable, deterministic instruction-following.
- Daemon state lives in `$MEETINGS_BASE/state/` (`queue.json`, `pause.json`, `current.json`, `recording.json`, `daemon.lock`) — inspectable, persistent across restarts. Failures are logged to `$MEETINGS_BASE/logs/process-failures.log`.
- `config.sh` is the only shell file — it's just environment configuration (and a convenient hook for sourcing secrets). All logic is TypeScript in `src/`.

## Development

Pure TypeScript run directly by Bun — no build step. From `src/`:
```sh
bun run typecheck   # tsc --noEmit (strict)
bun test            # unit tests for the pure logic (stamp/title/word parsing, queue)
```
