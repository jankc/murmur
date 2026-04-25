#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(dirname "$0")/.."
source "$REPO_DIR/config.sh"

BASE_DIR="$MEETINGS_BASE"
MODEL_WHISPER="mlx-community/whisper-large-v3-turbo"
MODEL_SUMMARY="${MODEL_SUMMARY:-qwen3.6:27b}"

AUDIO="$(ls -t "$BASE_DIR"/recordings/*.wav | head -n 1)"
NAME="$(basename "$AUDIO" .wav)"

PROMPT_FILE="$REPO_DIR/prompts/summary.md"
TRANSCRIPT="$BASE_DIR/transcripts/$NAME.txt"
SUMMARY="$BASE_DIR/summaries/$NAME.md"

mkdir -p "$BASE_DIR/transcripts" "$BASE_DIR/summaries"

echo "Transcribing: $AUDIO"

mlx_whisper "$AUDIO" \
  --model "$MODEL_WHISPER" \
  --output-dir "$BASE_DIR/transcripts" \
  --output-format txt

echo "Summarizing: $TRANSCRIPT"

(
  cat "$PROMPT_FILE"
  echo ""
  echo "--- TRANSCRIPT ---"
  cat "$TRANSCRIPT"
  echo ""
  echo "--- END ---"
) | ollama run --think=false --nowordwrap "$MODEL_SUMMARY" > "$SUMMARY"

echo "Done:"
echo "$SUMMARY"