#!/usr/bin/env bash
set -euo pipefail

# DEPRECATED: superseded by the Bun daemon (daemon/main.ts), which adds a persistent
# queue, GPU-pause, auto-defer-while-recording, and whisply transcription. Do NOT run
# this and the daemon at the same time (they would double-process). See README → Daemon.
echo "WARNING: watch-recordings.sh is deprecated — use the meeting-ai daemon instead." >&2

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../config.sh"

BASE_DIR="$MEETINGS_BASE"
WATCH_DIR="$BASE_DIR/recordings"
mkdir -p "$WATCH_DIR"

command -v fswatch >/dev/null || { echo "fswatch not installed. brew install fswatch" >&2; exit 1; }

echo "Watching $WATCH_DIR for new .wav files..."

fswatch -0 --event Created --event Renamed "$WATCH_DIR" | while IFS= read -r -d '' path; do
  [[ "$path" == *.wav ]] || continue
  # Wait until ffmpeg has released the file (size stable for 2s).
  prev=-1
  while :; do
    cur="$(stat -f%z "$path" 2>/dev/null || echo 0)"
    [[ "$cur" -gt 0 && "$cur" == "$prev" ]] && break
    prev="$cur"
    sleep 2
  done
  echo "New recording: $path"
  "$SCRIPT_DIR/process.sh" "$path" || echo "process.sh failed for $path (see logs/process-failures.log)" >&2
done
