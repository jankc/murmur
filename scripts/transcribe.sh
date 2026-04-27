#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(dirname "$0")/.."
source "$REPO_DIR/config.sh"

BASE_DIR="$MEETINGS_BASE"
MODEL_WHISPER="${MODEL_WHISPER:-mlx-community/whisper-large-v3-turbo}"

AUDIO="${1:-$(ls -t "$BASE_DIR"/recordings/*.wav | head -n 1)}"
[[ -f "$AUDIO" ]] || AUDIO="$BASE_DIR/recordings/$AUDIO.wav"
[[ -f "$AUDIO" ]] || { echo "Audio not found: $1" >&2; exit 1; }

NAME="$(basename "$AUDIO" .wav)"
TRANSCRIPT="$BASE_DIR/transcripts/$NAME.txt"

mkdir -p "$BASE_DIR/transcripts"

if [[ -f "$TRANSCRIPT" ]]; then
  echo "Transcript exists, skipping: $TRANSCRIPT"
else
  echo "Transcribing: $AUDIO"
  mlx_whisper "$AUDIO" \
    --model "$MODEL_WHISPER" \
    --output-dir "$BASE_DIR/transcripts" \
    --output-format txt
fi

echo "$TRANSCRIPT"
