# meeting-ai

Local meeting recorder, transcriber, and summarizer for macOS. Captures audio from an Aggregate Device with `ffmpeg`, transcribes with `mlx_whisper`, and summarizes with a local LLM via `ollama`. A SwiftBar menu item toggles recording from the menubar, and an optional LaunchAgent watches the recordings folder so a freshly-stopped meeting flows straight to summary without you lifting a finger.

Everything runs locally — no cloud, no third parties.

## Layout

### Recording
- `scripts/record-meeting.sh [device-index]` — start an `ffmpeg` recording (writes `recording.pid`, `current-recording.txt`, `recording-started-at.txt` under `$MEETINGS_BASE`)
- `scripts/stop-meeting.sh` — stop the running recording
- `scripts/toggle-recording.sh` — start/stop wrapper used by SwiftBar (delegates to two `.app` launchers, see Setup step 6)
- `swiftbar/menubar.5s.sh` — SwiftBar plugin: shows recording state + toggle action

### Processing
- `scripts/transcribe.sh [audio]` — transcribe one recording. Idempotent: skips whisper if the `.txt` already exists. Argument is a path, basename (`meeting-2026-04-27_14-32-15`), or omitted (newest recording).
- `scripts/summarize.sh [transcript]` — summarize one transcript. Preflights Ollama at `http://localhost:11434` and runs `open -a Ollama` if it's down, then waits.
- `scripts/process.sh [audio]` — orchestrator: transcribe + summarize. Logs failures to `$MEETINGS_BASE/logs/process-failures.log` with a ready-to-paste re-run command, and pings `terminal-notifier` (if installed) on success and failure.
- `scripts/process-latest.sh` — back-compat wrapper around `process.sh` (defaults to newest recording).
- `scripts/watch-recordings.sh` — `fswatch` loop: watches `recordings/` and runs `process.sh` on new `.wav` files once their size has stabilized (so it doesn't fire mid-`ffmpeg`).

### Config & assets
- `config.sh` — local config (gitignored)
- `prompts/summary.md` — prompt used for the summary step
- `launchd/com.jank.meeting-ai.watch.plist` — LaunchAgent for `watch-recordings.sh`

Recordings, transcripts, summaries, and runtime state live under `$MEETINGS_BASE` (default `~/Recordings/Meetings`), kept out of the repo on purpose.

## Setup

1. Install dependencies:
   ```sh
   brew install ffmpeg ollama fswatch terminal-notifier
   pip install mlx-whisper
   ```
   `fswatch` and `terminal-notifier` are only needed if you use `watch-recordings.sh`.
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
```sh
./scripts/watch-recordings.sh
```
Run it in a terminal tab, or install it as a LaunchAgent so it survives reboots:
```sh
cp launchd/com.jank.meeting-ai.watch.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jank.meeting-ai.watch.plist
launchctl enable gui/$(id -u)/com.jank.meeting-ai.watch
launchctl kickstart -k gui/$(id -u)/com.jank.meeting-ai.watch   # start now
```
Restart or stop it:
```sh
launchctl kickstart -k gui/$(id -u)/com.jank.meeting-ai.watch   # restart (e.g. after editing watch-recordings.sh)
launchctl bootout    gui/$(id -u)/com.jank.meeting-ai.watch     # stop and unload
```
After editing the plist, `bootout` then `bootstrap` again — `kickstart` alone won't re-read the file. Agent stdout/stderr land in `$MEETINGS_BASE/logs/watch.{out,err}.log`.

## Notes

- Recording is hard-capped at `MAX_DURATION_SECONDS` (default 2h) so a forgotten session can't fill the disk.
- Audio is downmixed to mono 16 kHz PCM — small files, fine for Whisper.
- The `pan=` filter in `record-meeting.sh` is tuned for a specific Aggregate Device channel layout; adjust if your mic/system channels differ.
- The processing scripts are idempotent. Re-running `process.sh` after a partial failure (e.g. Ollama wasn't running) only re-does the missing step.
- The LaunchAgent's `EnvironmentVariables.PATH` includes `/opt/homebrew/bin` so `fswatch`, `terminal-notifier`, and `ollama` resolve. If you're on Intel Homebrew or a non-default prefix, edit the plist accordingly.
