#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$SCRIPT_DIR/.."
source "$REPO_DIR/config.sh"

BASE_DIR="$MEETINGS_BASE"
PORT="${MEETING_AI_PORT:-7461}"

AUDIO="${1:-$(ls -t "$BASE_DIR"/recordings/*.wav | head -n 1)}"
[[ -f "$AUDIO" ]] || AUDIO="$BASE_DIR/recordings/$AUDIO.wav"
[[ -f "$AUDIO" ]] || { echo "Audio not found: ${1:-}" >&2; exit 1; }

NAME="$(basename "$AUDIO" .wav)"

# Prefer the daemon: it owns the GPU-pause-aware serial queue (and uses whisply +
# diarization). Fall back to inline processing only if the daemon isn't reachable.
if RESP="$(curl -fsS -X POST "http://127.0.0.1:$PORT/enqueue" \
            -H 'content-type: application/json' \
            -d "{\"wav\":\"$AUDIO\"}" 2>/dev/null)"; then
  echo "Enqueued via daemon: $RESP"
  exit 0
fi

echo "Daemon not reachable on :$PORT — processing inline (whisply + ollama)."

FAILURE_LOG="$BASE_DIR/logs/process-failures.log"
mkdir -p "$BASE_DIR/logs"

notify() {
  command -v terminal-notifier >/dev/null && \
    terminal-notifier -title "Meeting AI" -message "$1" -sound default >/dev/null 2>&1 || true
}

log_failure() {
  local stage="$1" code="$2" ts
  ts="$(date +"%Y-%m-%d %H:%M:%S")"
  echo "[$ts] $NAME — $stage failed (exit $code). Re-run: $SCRIPT_DIR/process.sh \"$AUDIO\"" >> "$FAILURE_LOG"
  echo "Failure logged to $FAILURE_LOG" >&2
  notify "$stage failed for $NAME — see logs/process-failures.log"
}

TRANSCRIPT="$("$SCRIPT_DIR/transcribe.sh" "$AUDIO" | tail -n 1)" || {
  code=$?; log_failure "transcribe" "$code"; exit "$code";
}

SUMMARY="$("$SCRIPT_DIR/summarize.sh" "$TRANSCRIPT" | tail -n 1)" || {
  code=$?; log_failure "summarize" "$code"; exit "$code";
}

echo "Done:"
echo "  transcript: $TRANSCRIPT"
echo "  summary:    $SUMMARY"

notify "Summary ready: $NAME"
