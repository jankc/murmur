# meeting-ai

Local meeting recorder, transcriber, and summarizer for macOS. Captures audio from an Aggregate Device with `ffmpeg`, transcribes with `whisply` (mlx-whisper + optional speaker diarization), and summarizes with a local LLM via `ollama`. A SwiftBar menu item controls recording and processing from the menubar, and a background **daemon** watches the recordings folder so a freshly-stopped meeting flows straight to summary without you lifting a finger.

Everything runs locally — no cloud, no third parties.

## Daemon (recommended)

The `daemon/` directory is a single long-lived [Bun](https://bun.sh) process that orchestrates the pipeline. It replaces the old `fswatch`-based `watch-recordings.sh` and adds:

- a **persistent job queue** (survives restarts),
- a **serial worker** — exactly one GPU job at a time,
- **soft/hard GPU-pause** so you can free the GPU for other work,
- **auto-defer while recording** — processing waits until a live meeting finishes,
- **whisply** transcription (mlx-whisper speed; speaker diarization when configured),
- a **localhost control API** consumed by SwiftBar and the CLI scripts.

Engines stay as subprocesses/HTTP (whisply, ollama, ffmpeg, terminal-notifier); Bun is the only added dependency. The recorder reuses the existing `record-meeting.sh`/`stop-meeting.sh` scripts, so the tuned ffmpeg `pan` filter is unchanged.

### Control API (`http://127.0.0.1:7461`)

| Method + path | Body | Effect |
|---|---|---|
| `GET /status` | — | JSON: recording?, pause mode, queue depth + items, current job |
| `POST /record/start` · `/record/stop` | — | start/stop recording (runs the bash scripts) |
| `POST /pause` | `{"mode":"soft"\|"hard"}` | soft = finish current job then idle; hard = abort current + requeue |
| `POST /resume` | — | resume processing |
| `POST /enqueue` | `{"wav":"<path\|basename>","force":true?}` | queue a recording (dedups; skips if already summarized unless `force`) |
| `GET /swiftbar` | — | pre-rendered SwiftBar plugin block |

### Run it

```sh
# Dev (foreground):
bun run daemon/main.ts

# Install as a LaunchAgent (RunAtLoad + KeepAlive):
cp launchd/com.jank.meeting-ai.daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jank.meeting-ai.daemon.plist
launchctl kickstart -k gui/$(id -u)/com.jank.meeting-ai.daemon
tail -f ~/Recordings/Meetings/logs/daemon.{out,err}.log
```

> **Migration:** if you previously installed the old watch agent, stop it first so the two don't double-process:
> `launchctl bootout gui/$(id -u)/com.jank.meeting-ai.watch`

The plist hard-codes the absolute path to `bun` (a mise install) and a `PATH` that resolves `bun`, `whisply`, `ffmpeg`, `ollama`, and `terminal-notifier`. If you reinstall bun, update `ProgramArguments` in the plist.

### Diarization (speaker labels) — opt-in

Off by default. To enable, set `DIARIZE=1` and `HF_TOKEN=...` in `config.sh`, then accept the pyannote model terms once on HuggingFace ([segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1)). Without a token the daemon logs a warning and transcribes without speaker labels (it never blocks).

## Layout

### Recording
- `scripts/record-meeting.sh [device-index]` — start an `ffmpeg` recording (writes `recording.pid`, `current-recording.txt`, `recording-started-at.txt` under `$MEETINGS_BASE`)
- `scripts/stop-meeting.sh` — stop the running recording
- `scripts/toggle-recording.sh` — start/stop wrapper used by SwiftBar (delegates to two `.app` launchers, see Setup step 6)
- `swiftbar/menubar.5s.sh` — SwiftBar plugin: shows recording state + toggle action

### Processing
- `daemon/` — the Bun orchestrator (see [Daemon](#daemon-recommended) above). The normal processing path.
- `scripts/process.sh [audio]` — thin client: enqueues the recording on the daemon. Falls back to inline transcribe+summarize (via the scripts below, using `mlx_whisper`) if the daemon is unreachable.
- `scripts/transcribe.sh [audio]` — manual one-shot transcription with `mlx_whisper` (the daemon uses `whisply`). Idempotent: skips if the `.txt` already exists. Argument is a path, basename, or omitted (newest recording).
- `scripts/summarize.sh [transcript]` — summarize one transcript. Preflights Ollama at `http://localhost:11434` and runs `open -a Ollama` if it's down, then waits. Handy for re-summarizing after editing `prompts/summary.md`.
- `scripts/process-latest.sh` — back-compat wrapper around `process.sh` (defaults to newest recording).
- `scripts/watch-recordings.sh` — **deprecated**, replaced by the daemon. Don't run it alongside the daemon.

### Config & assets
- `config.sh` — local config (gitignored); see `config.sh.example`
- `prompts/summary.md` — prompt used for the summary step (shared by the daemon and `summarize.sh`)
- `launchd/com.jank.meeting-ai.daemon.plist` — LaunchAgent for the daemon
- `launchd/com.jank.meeting-ai.watch.plist` — old LaunchAgent for the deprecated `watch-recordings.sh`

Recordings, transcripts, summaries, and runtime state live under `$MEETINGS_BASE` (default `~/Recordings/Meetings`), kept out of the repo on purpose.

## Setup

1. Install dependencies:
   ```sh
   brew install ffmpeg ollama terminal-notifier
   # Bun (daemon runtime) — via mise, or: curl -fsSL https://bun.sh/install | bash
   # whisply (daemon transcription engine, includes mlx-whisper on Apple Silicon):
   uv tool install whisply        # or: pipx install whisply
   pip install mlx-whisper        # only for the scripts/transcribe.sh inline fallback
   ```
   `terminal-notifier` is optional (notifications). `fswatch` is no longer needed — the daemon uses a native watcher.
2. Create an Aggregate Device in **Audio MIDI Setup** that mixes mic + system audio, and note its `avfoundation` index (`ffmpeg -f avfoundation -list_devices true -i ""`).
3. Pull a summary model:
   ```sh
   ollama pull qwen3:30b   # or whatever you set in config.sh
   ```
   Make sure Ollama is running — either install **Ollama.app** and set it to launch at login, or `brew services start ollama`. `summarize.sh` will try to start the app for you if it isn't responding.
4. Create `config.sh`:
   ```sh
   #!/usr/bin/env bash
   export MEETINGS_BASE="$HOME/Recordings/Meetings"
   export MODEL_SUMMARY="qwen3:30b"
   # Optional overrides:
   # export MODEL_WHISPER="mlx-community/whisper-large-v3-turbo"
   # export MAX_DURATION_SECONDS=7200
   ```
5. (Optional) Install [SwiftBar](https://swiftbar.app) and symlink `swiftbar/menubar.5s.sh` into your SwiftBar plugins folder.
6. (Optional) Build two Automator apps named **Meeting Recorder Start** and **Meeting Recorder Stop**, each containing a single **Run Shell Script** action:
   ```sh
   /Users/$USER/code/personal/meeting-ai/scripts/record-meeting.sh
   ```
   ```sh
   /Users/$USER/code/personal/meeting-ai/scripts/stop-meeting.sh
   ```
   Save them to `/Applications`. `toggle-recording.sh` `open`s these by name so the SwiftBar click survives macOS's stricter shell-from-menubar permissions.

## Usage

### Record
```sh
./scripts/record-meeting.sh [device-index]   # default 0
./scripts/stop-meeting.sh
```
Or click the SwiftBar menubar item.

### Process
```sh
./scripts/process.sh                                      # newest recording
./scripts/process.sh meeting-2026-04-27_14-32-15          # by basename
./scripts/process.sh /path/to/file.wav                    # by full path
./scripts/transcribe.sh <name>                            # transcript only
./scripts/summarize.sh <name>                             # re-summarize without re-transcribing (e.g. after editing prompts/summary.md)
```

Output goes to `$MEETINGS_BASE/transcripts/` and `$MEETINGS_BASE/summaries/`. Failures are appended to `$MEETINGS_BASE/logs/process-failures.log` with the exact command to retry.

### Auto-process new recordings

Run the [daemon](#daemon-recommended) — it watches `recordings/` and processes new `.wav` files automatically (once their size stabilizes, and deferring until any in-progress recording stops). After editing the plist, `bootout` then `bootstrap` again — `kickstart` alone won't re-read the file. Daemon stdout/stderr land in `$MEETINGS_BASE/logs/daemon.{out,err}.log`.

### Pause / resume processing

```sh
curl -s -X POST localhost:7461/pause  -d '{"mode":"soft"}'   # finish current job, then idle
curl -s -X POST localhost:7461/pause  -d '{"mode":"hard"}'   # abort current job + requeue (frees GPU now)
curl -s -X POST localhost:7461/resume
curl -s localhost:7461/status                                # queue depth, current job, pause state
```
Or use the SwiftBar menu.

## Notes

- Recording is hard-capped at `MAX_DURATION_SECONDS` (default 2h) so a forgotten session can't fill the disk.
- Audio is downmixed to mono 16 kHz PCM — small files, fine for Whisper.
- The `pan=` filter in `record-meeting.sh` is tuned for a specific Aggregate Device channel layout; adjust if your mic/system channels differ.
- Processing is idempotent. The daemon (and `process.sh`) skip transcription if `transcripts/<base>.txt` exists and summarization if `summaries/<base>.md` exists; a job stays queued until both succeed, so a crash mid-job replays cleanly.
- whisply writes a nested layout under its output dir; the daemon runs it into `transcripts/.whisply-work/<base>/` and normalizes the result to the flat `transcripts/<base>.txt` the rest of the pipeline expects.
- Daemon state lives in `$MEETINGS_BASE/state/` (`queue.json`, `pause.json`, `current.json`, `daemon.lock`) — inspectable and persistent across restarts.
- The daemon LaunchAgent's `EnvironmentVariables.PATH` must resolve `bun`, `whisply`, `ffmpeg`, `ollama`, and `terminal-notifier`. If you're on Intel Homebrew, a non-default prefix, or reinstall bun, edit the plist accordingly.
