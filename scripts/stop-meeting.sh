#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/../config.sh"

BASE_DIR="$MEETINGS_BASE"
PID_FILE="$BASE_DIR/recording.pid"
CURRENT_FILE="$BASE_DIR/current-recording.txt"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No recording is running."
  exit 0
fi

PID="$(cat "$PID_FILE")"

echo "Stopping recording PID $PID..."
kill -INT "$PID"

sleep 1
rm -f "$PID_FILE"

echo "Recording stopped."

if [[ -f "$CURRENT_FILE" ]]; then
  echo "Last recording:"
  cat "$CURRENT_FILE"
fi

rm -f "$BASE_DIR/recording-started-at.txt"
osascript -e 'display notification "Meeting recording stopped" with title "Recording" sound name "Glass"'