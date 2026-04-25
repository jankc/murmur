#!/usr/bin/env bash

source "$(dirname "$0")/../config.sh"

BASE_DIR="$MEETINGS_BASE"
PID_FILE="$BASE_DIR/recording.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  /usr/bin/open -a "Meeting Recorder Stop"
else
  /usr/bin/open -a "Meeting Recorder Start"
fi

sleep 1.5
/usr/bin/osascript -e 'tell application "SwiftBar" to refresh all' >/dev/null 2>&1 || true