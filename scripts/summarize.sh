#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(dirname "$0")/.."
source "$REPO_DIR/config.sh"

BASE_DIR="$MEETINGS_BASE"
MODEL_SUMMARY="${MODEL_SUMMARY:-qwen3:30b}"
PROMPT_FILE="${PROMPT_FILE:-$REPO_DIR/prompts/summary.md}"

ARG="${1:-$(ls -t "$BASE_DIR"/transcripts/*.txt | head -n 1)}"
if [[ -f "$ARG" ]]; then
  TRANSCRIPT="$ARG"
else
  TRANSCRIPT="$BASE_DIR/transcripts/${ARG%.txt}.txt"
fi
[[ -f "$TRANSCRIPT" ]] || { echo "Transcript not found: $ARG" >&2; exit 1; }

NAME="$(basename "$TRANSCRIPT" .txt)"
SUMMARY="$BASE_DIR/summaries/$NAME.md"

mkdir -p "$BASE_DIR/summaries"

if ! curl -sf http://localhost:11434/api/tags >/dev/null; then
  echo "Starting Ollama..."
  open -a Ollama
  until curl -sf http://localhost:11434/api/tags >/dev/null; do sleep 1; done
fi

echo "Summarizing: $TRANSCRIPT"

(
  cat "$PROMPT_FILE"
  echo ""
  echo "--- TRANSCRIPT ---"
  cat "$TRANSCRIPT"
  echo ""
  echo "--- END ---"
) | ollama run --think=false --nowordwrap "$MODEL_SUMMARY" > "$SUMMARY"

echo "$SUMMARY"
