# meeting-ai

Local meeting recorder, transcriber, and summarizer for macOS. Captures audio from an Aggregate Device with `ffmpeg`, transcribes with `mlx_whisper`, and summarizes with a local LLM via `ollama`. A SwiftBar menu item toggles recording from the menubar.

Everything runs locally — no cloud, no third parties.

## Layout

- `scripts/record-meeting.sh` — start an `ffmpeg` recording (writes `recording.pid`, `current-recording.txt`, `recording-started-at.txt` under `$MEETINGS_BASE`)
- `scripts/stop-meeting.sh` — stop the running recording
- `scripts/toggle-recording.sh` — start/stop wrapper used by SwiftBar (delegates to two `.app` launchers below)
- `scripts/process-latest.sh` — transcribe + summarize the most recent recording
- `swiftbar/menubar.5s.sh` — SwiftBar plugin: shows recording state + toggle action
- `prompts/summary.md` — prompt used for the summary step
- `config.sh` — local config (gitignored)

Recordings, transcripts, summaries, and runtime state live under `$MEETINGS_BASE` (default `~/Recordings/Meetings`), kept out of the repo on purpose.

## Setup

1. Install dependencies:
   ```sh
   brew install ffmpeg ollama
   pip install mlx-whisper
   ```
2. Create an Aggregate Device in **Audio MIDI Setup** that mixes mic + system audio, and note its `avfoundation` index (`ffmpeg -f avfoundation -list_devices true -i ""`).
3. Pull a summary model:
   ```sh
   ollama pull qwen3:30b   # or whatever you set in config.sh
   ```
4. Create `config.sh`:
   ```sh
   #!/usr/bin/env bash
   export MEETINGS_BASE="$HOME/Recordings/Meetings"
   export MODEL_SUMMARY="qwen3:30b"
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

Start/stop manually:
```sh
./scripts/record-meeting.sh [device-index]   # default 0
./scripts/stop-meeting.sh
```

Or click the SwiftBar menubar item.

After stopping, generate transcript + summary for the latest recording:
```sh
./scripts/process-latest.sh
```

Output goes to `$MEETINGS_BASE/transcripts/` and `$MEETINGS_BASE/summaries/`.

## Notes

- Recording is hard-capped at `MAX_DURATION_SECONDS` (default 2h) so a forgotten session can't fill the disk.
- Audio is downmixed to mono 16 kHz PCM — small files, fine for Whisper.
- The `pan=` filter in `record-meeting.sh` is tuned for a specific Aggregate Device channel layout; adjust if your mic/system channels differ.
