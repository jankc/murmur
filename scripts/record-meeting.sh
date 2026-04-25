#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/../config.sh"

BASE_DIR="$MEETINGS_BASE"
DEVICE_INDEX="${1:-0}"

OUT_DIR="$BASE_DIR/recordings"
LOG_DIR="$BASE_DIR/logs"
PID_FILE="$BASE_DIR/recording.pid"
CURRENT_FILE="$BASE_DIR/current-recording.txt"

mkdir -p "$OUT_DIR" "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  echo "Recording already running. PID: $(cat "$PID_FILE")"
  exit 1
fi

TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
OUT_FILE="$OUT_DIR/meeting-$TIMESTAMP.wav"
LOG_FILE="$LOG_DIR/meeting-$TIMESTAMP.log"

echo "Recording from Aggregate Device index: $DEVICE_INDEX"
echo "Output: $OUT_FILE"

MAX_DURATION_SECONDS="${MAX_DURATION_SECONDS:-7200}" # 2 hodiny

osascript -e 'display notification "Meeting recording started" with title "Recording" sound name "Glass"'

  # -filter_complex "pan=mono|c0=0.8*c0+0.7*c2,alimiter" \
ffmpeg -f avfoundation -i ":$DEVICE_INDEX" \
  -filter_complex "pan=mono|c0=0.35*c0+0.35*c1+0.7*c2,alimiter" \
  -ac 1 \
  -ar 16000 \
  -c:a pcm_s16le \
  -t "$MAX_DURATION_SECONDS" \
  "$OUT_FILE" \
  > "$LOG_FILE" 2>&1 &

echo $! > "$PID_FILE"
echo "$OUT_FILE" > "$CURRENT_FILE"
echo "$(date)" > "$BASE_DIR/recording-started-at.txt"

echo "Recording started. PID: $(cat "$PID_FILE")"