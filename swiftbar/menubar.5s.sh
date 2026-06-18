#!/usr/bin/env bash
# SwiftBar plugin. The daemon renders the whole menu block at GET /swiftbar, so this
# is mostly a curl. If the daemon is offline, fall back to the recording.pid check.

REPO_DIR="$(dirname "$0")/.."
source "$REPO_DIR/config.sh"
PORT="${MEETING_AI_PORT:-7461}"

OUT="$(curl -fsS "http://127.0.0.1:$PORT/swiftbar" 2>/dev/null || true)"
if [[ -n "$OUT" ]]; then
  echo "$OUT"
  exit 0
fi

# --- daemon offline fallback ---
PID_FILE="$MEETINGS_BASE/recording.pid"
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "🔴"
else
  echo "⚪"
fi
echo "---"
echo "Meeting AI daemon offline | color=red"
echo "Toggle recording | bash=$REPO_DIR/scripts/toggle-recording.sh terminal=false refresh=true"
