# murmur

Local meeting recorder, transcriber, and summarizer for macOS. Captures system audio **and** your mic (recommended backend: [`ownscribe`](#recording-backends) — a ScreenCaptureKit tap on the default output, so it never reroutes audio or disables the volume keys), transcribes with `mlx-whisper` (+ optional `pyannote` speaker diarization), and summarizes with a local LLM via `ollama`. Everything runs locally — no cloud, no third parties.

One stack: a single [Bun](https://bun.sh)/TypeScript codebase in `src/` provides both the **`murmur` CLI** (manual control) and a long-lived **daemon** (automatic, GPU-pause-aware processing). They share the same modules, so every step has one implementation.

```
record (system + mic) ─▶ .partial/ ─(complete, →FLAC)─▶ inbox/*.flac ─▶ asr (mlx-whisper + diarize) ─▶ ollama ─▶ summaries/*.md ─▶ Obsidian
   └ daemon: watches inbox · serial queue · GPU-pause · auto-defers while a recording is live
     on success the recording moves ─▶ recordings/processed/<YYYY-MM>/   (failure ─▶ recordings/failed/)
```

**A recording's folder is its state.** An in-progress recording stays in `recordings/.partial/` (not watched, raw PCM WAV — maximally crash-salvageable), so it never triggers the pipeline or clutters the inbox. When recording ends the capture is transcoded to canonical **FLAC** (lossless, ~half the size of WAV) and atomically moved into `recordings/inbox/` — the only folder the daemon watches. Once fully processed (transcribed → summarized → archived) it's **moved** to `recordings/processed/<YYYY-MM>/`, so it's never re-examined — no growing "already done?" rescans. A non-retryable failure moves it to `recordings/failed/` (so a poison file doesn't retry every restart) and logs a `murmur reprocess` re-run command to `logs/process-failures.log`.

## Install

> Fast path: after the prerequisites below, `bash scripts/setup.sh` runs the whole install (ASR venv, CLI symlink, capture build, daemon) idempotently; then `murmur doctor` verifies it.

```sh
brew install ffmpeg ollama uv terminal-notifier    # terminal-notifier optional (notifications)
# Bun — via mise, or: curl -fsSL https://bun.sh/install | bash
# uv  — via mise/brew (above), or: curl -fsSL https://astral.sh/uv/install.sh | sh   (drives the ASR venv)
ollama pull gemma3:12b                              # any Ollama chat model; set it as [summary].model
```
> The `*-mlx` tags in `murmur.toml.example` (e.g. `gemma4:26b-mlx`) are **custom local MLX builds**, not on the Ollama registry — create them with `ollama create`, or just use any standard pullable model.
`ffmpeg`, `ollama` + a pulled model, `bun`, and `uv` are required; `terminal-notifier` is optional. Building the `ownscribe` recording helper (below) also needs the **Xcode Command Line Tools** (`xcode-select --install`).

The ASR engine (transcription + optional diarization) runs in one Python venv with both
`mlx-whisper` and `pyannote.audio` 4 — `asr/asr.py` calls them directly:
```sh
uv venv --python 3.12 ~/.local/share/murmur/asr-venv
uv pip install --python ~/.local/share/murmur/asr-venv/bin/python mlx-whisper "pyannote.audio>=4.0"
```

Put `murmur` on your PATH (the CLI is an executable Bun script — no build/install step):
```sh
ln -s "$PWD/src/cli.ts" ~/.local/bin/murmur
```

Set up audio capture (see [Recording backends](#recording-backends) for the trade-offs):
- **`ownscribe`** (recommended) — build the Swift helper (steps under [Recording backends](#recording-backends)); needs no BlackHole or Aggregate Device, and keeps the volume keys working.
- **`ffmpeg`** (default) — install BlackHole and create an **Aggregate Device** (mic + system audio) in *Audio MIDI Setup*, then note its avfoundation index for `[recording].device_index`:
  ```sh
  brew install blackhole-2ch
  ffmpeg -f avfoundation -list_devices true -i ""
  ```

## Configure

`murmur.toml` (gitignored; copy `murmur.toml.example`) is the single config file — both daemon settings and `murmur import` sources. Only `meetings_base` + `[summary].model` are required:
```toml
meetings_base = "~/Recordings/Meetings"

[summary]
model = "gemma3:12b"        # any Ollama chat model (the *-mlx tags are custom local builds)

[asr]
diarize = true              # speaker labels (see Diarization below)
hf_token = "hf_xxx"         # required for diarization

[recording]
backend = "ownscribe"       # recommended (see Recording backends); omit for the ffmpeg default
# device_index = "1"        # ffmpeg backend only: avfoundation index of your Aggregate Device
```
Paths may start with `~/`. Defaults for everything else live in `src/config.ts` (port 7461, ASR model `mlx-community/whisper-large-v3-turbo`, language `auto`-detect, `max_duration_seconds = 7200`, …).

> Precedence is **env > `murmur.toml` > defaults** — any value can be overridden by an environment variable (e.g. set in the launchd plist). `murmur.toml` is gitignored, so the `hf_token` lives there fine; if you'd rather not store it, leave it unset and export `HF_TOKEN` into the daemon's environment instead.

## Usage — the `murmur` CLI

```sh
murmur record [--device N]   # start recording (system audio + your mic; --device sets the ffmpeg Aggregate Device index)
murmur stop                  # stop recording
murmur process [audio]       # transcribe + summarize (newest, or by path/basename)
murmur import                # pull new recordings from external sources (murmur.toml [[sources]]) into inbox/
murmur reprocess <name>      # re-run the pipeline for one recording (incl. one in recordings/failed/)
murmur retry-failed          # re-enqueue everything in recordings/failed/
murmur transcribe [audio]    # transcribe only → prints transcript path
murmur summarize <name>      # summarize a transcript → prints summary path
murmur status [--json] [--watch [secs]]  # recording / pause / queue / failures (--json for tools; --watch for a live view, default 2s)
murmur pause [hard]          # pause processing (soft = finish current; hard = abort + requeue)
murmur resume
murmur doctor                # verify setup (venv, ffmpeg, ollama+model, ownscribe, …)
murmur logs [-f]             # tail the daemon logs (-f to follow)
murmur daemon <sub>          # run | start | stop | restart | install — manage the LaunchAgent
```

Outputs land in `$MEETINGS_BASE/{transcripts,summaries}/`. Stateful commands (`record`/`stop`/`process`/`pause`/`resume`/`status`) use the daemon when it's running, and act directly when it isn't; `transcribe`/`summarize` always run inline. A recording's **location is its state** — processing always runs and overwrites prior outputs, so **to reprocess a recording run `murmur reprocess <name>`** (it resolves the recording wherever it sits — `inbox/`, `failed/`, or `processed/`); `murmur retry-failed` re-runs everything in `recordings/failed/`.

## The daemon (automatic processing)

The daemon watches `recordings/inbox/` and runs each new recording — a FLAC capture, or any imported/dropped-in audio file (m4a, mp3, wav, …) — through the pipeline automatically — once the file stops growing, and **deferring while a recording is in progress** (keeps the GPU free during live meetings). It holds a **persistent queue** (one GPU job at a time, survives restarts) and supports **soft/hard pause** to free the GPU on demand. Done recordings move to `processed/<YYYY-MM>/` (see [folder = state](#murmur) above).

Run it always-on via the LaunchAgent:
```sh
murmur daemon install        # copy the plist into ~/Library/LaunchAgents/ and start it
murmur daemon restart        # after editing murmur.toml or the plist (bootout + bootstrap)
murmur daemon stop           # ( / start )
murmur logs -f               # tail the daemon logs (out + err)
```
`murmur daemon restart` re-reads an edited plist (`kickstart` alone wouldn't). The daemon's log location is derived from `MEETINGS_BASE` by `launchd/run-daemon.sh` (via `murmur print-env`), so relocating the base needs only a `murmur.toml` edit + `murmur daemon restart`. The plist still hard-codes machine-specific paths — the `bun` mise install in `PATH`, the repo's `run-daemon.sh`, and the `WorkingDirectory` — so **on a new machine (or a different username/repo location) edit those**, and update the `bun` path whenever you reinstall bun.

### Control API (`http://127.0.0.1:7461`)

The CLI and SwiftBar talk to this; you can too. Mutating routes (everything but `GET /status`) require a `Content-Type: application/json` header and reject any request carrying an `Origin` — a CSRF guard so a web page can't trigger recording over loopback. `curl` works with `-H 'content-type: application/json'`.

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

Set `backend` under `[recording]` in `murmur.toml`:

**`ownscribe`** (recommended) — one helper captures system audio (ScreenCaptureKit) **and** your mic, then merges them **host-time-aligned** on stop. No BlackHole, no aggregate, no output routing → **the macOS volume keys keep working**; and because the two streams are time-synced, the mic's unavoidable speaker bleed reads as "emphasized voice," not an echo. Best for capturing both sides on speakers.

Build the helper once (the Swift source is vendored in [`capture/`](capture/), from [ownscribe](https://github.com/paberr/ownscribe), MIT, macOS 14.2+; needs the Xcode Command Line Tools, `xcode-select --install`; first run prompts for Screen Recording permission):
```sh
bash capture/build.sh && cp capture/bin/ownscribe-audio ~/.local/bin/ownscribe-audio
```
```toml
[recording]
backend = "ownscribe"
# ownscribe_bin = "~/.local/bin/ownscribe-audio"   # default
```

**`ffmpeg`** (default; no-build fallback) — records one avfoundation **Aggregate Device** (mic + system audio via BlackHole) through the `pan=` downmix. One hardware clock, so it's perfectly synced — but routing system audio requires a BlackHole multi-output as the system output, which **disables the volume keys**, and a meeting app grabbing the mic can starve the aggregate. Tune with `[recording].device_index` / `pan_filter`. Use it only if you'd rather not build the Swift helper; `ownscribe` is better for recording on speakers.

## Diarization (speaker labels) — opt-in

Set `diarize = true` and provide `hf_token` under `[asr]` in `murmur.toml`. Transcripts then carry `[SPEAKER_xx]` labels + timestamps, produced by [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (pyannote.audio 4) in the same `asr/asr.py` helper that does the transcription: mlx-whisper emits the chunks, community-1 emits the speaker turns, and murmur merges them by timestamp — grouping consecutive same-speaker chunks. It tracks whole turns instead of flip-flopping mid-sentence on a mono meeting mix.

The model is gated: accept the [community-1](https://hf.co/pyannote/speaker-diarization-community-1) conditions on HuggingFace once, then:
```toml
[asr]
diarize = true
hf_token = "hf_xxx"
# num_speakers = 3     # optional hint when you know the headcount (0 = auto)
```
The ASR venv (set up in **Install**) already has `pyannote.audio` — no separate environment. If diarization fails (missing token, gated model, MPS issue), the run degrades to a plain transcript rather than losing the meeting.

## Obsidian vault archiving (optional)

Set `root` (and optionally `folder`, default `Murmur`) under `[vault]` in `murmur.toml` and each finished summary is **copied** into your vault, organized by month:

```
<vault root>/Murmur/2026-06/2026-06-18 16-21-05 <generated title>.md
```

The originals in `$MEETINGS_BASE/summaries` stay the source of truth — the vault is a derived view (summaries only; transcripts aren't copied). Each note gets a short title — produced as the summary's own first heading, so archiving needs no extra model call (older, title-less summaries fall back to a dedicated title call). The title is also used in the filename (`:`→`-` for macOS/Obsidian safety), alongside YAML frontmatter:

```yaml
---
title: "Workflow nahrávání meetingů"
date: 2026-06-18
time: "16:21"
source: "meeting-2026-06-18_16-21-05.flac"
duration: "1:13:25"
speakers: 2            # only when diarized
tags: [meeting, murmur]
---
```

Archiving replaces any prior note for the same recording (matched on the `YYYY-MM-DD HH-MM-SS` prefix — second precision, so two recordings that start in the same minute stay distinct), so reprocessing refreshes the vault without leaving duplicates, and it's best-effort — a vault/iCloud hiccup is logged but never fails the local job. Leave `[vault].root` empty to disable.

## Notes

- Recording is hard-capped at `max_duration_seconds` (default 2h). Capture is mono 16 kHz PCM, archived as mono 16 kHz **FLAC** (lossless, ~half the size). Imported recordings (`murmur import` / dropped into `inbox/`) are kept in their original format — already-compressed audio (m4a, mp3, …) isn't re-encoded.
- **ffmpeg backend:** recording downmixes the 3-channel Aggregate Device to mono with a `pan=` filter (default in `src/config.ts`): `c0+c1` = BlackHole 2ch (system audio — the other participants), `c2` = the microphone (your voice). If your Aggregate Device orders its sub-devices differently, set `[recording].pan_filter` in `murmur.toml` — a wrong channel map is the usual reason a capture comes out mute or lopsided.
- On `stop`, murmur measures the finished recording's level and warns (notification + log) if it's effectively silent. Usual causes: a routing slip (e.g. system output not on the BlackHole multi-output on the `ffmpeg` backend) or a muted/grabbed mic. Threshold: `[recording].silence_db` (default `-80` dBFS).
- The `asr/asr.py` helper reads the recording read-only and prints its result (transcript chunks + speaker turns) as JSON on stdout, so murmur writes straight to the flat `transcripts/<base>.txt`. Your recordings are never mutated.
- Each pipeline stage streams to its own log under `logs/`: recording → `meeting-<ts>.log`, asr → `asr-<base>.log` (the helper's stderr — model load + progress + a failure's tail; stdout carries the JSON payload murmur parses), and an ollama failure → `summary-<base>.log` (the failing response body). The daemon's own stdout/stderr go to `daemon.{out,err}.log` (`murmur logs`).
- Summaries use `temperature: 0` for reliable, deterministic instruction-following.
- Daemon state lives in `$MEETINGS_BASE/state/` (`queue.json`, `pause.json`, `current.json`, `recording.json`, `daemon.lock`) — inspectable, persistent across restarts. Failures are logged to `$MEETINGS_BASE/logs/process-failures.log`.
- `murmur.toml` is the one config file (parsed by Bun's native TOML loader); `launchd/run-daemon.sh` is the only shell script — it just resolves the log path via `murmur print-env` before `exec`ing the daemon. All logic is TypeScript in `src/`.

## Development

Pure TypeScript run directly by Bun — no build step. From `src/`:
```sh
bun run typecheck   # tsc --noEmit (strict)
bun test            # unit tests for the pure logic (stamp/title/word parsing, queue)
```
