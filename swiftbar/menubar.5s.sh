#!/usr/bin/env bash

REPO_DIR="$(dirname "$0")/.."
source "$REPO_DIR/config.sh"

PID_FILE="$MEETINGS_BASE/recording.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "🔴 Recording"
else
  echo "⚪ Idle"
fi

echo "---"
echo "Toggle recording | bash=$REPO_DIR/scripts/toggle-recording.sh terminal=false refresh=false"