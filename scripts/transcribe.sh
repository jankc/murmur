#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_DIR/config.sh"

BASE_DIR="$MEETINGS_BASE"
WHISPLY_BIN="${WHISPLY_BIN:-whisply}"
WHISPLY_MODEL="${WHISPLY_MODEL:-large-v3-turbo}"
WHISPLY_LANG="${WHISPLY_LANG:-cs}"
WHISPLY_DEVICE="${WHISPLY_DEVICE:-mlx}"
DIARIZE="${DIARIZE:-0}"

AUDIO="${1:-$(ls -t "$BASE_DIR"/recordings/*.wav | head -n 1)}"
[[ -f "$AUDIO" ]] || AUDIO="$BASE_DIR/recordings/$AUDIO.wav"
[[ -f "$AUDIO" ]] || { echo "Audio not found: ${1:-}" >&2; exit 1; }

NAME="$(basename "$AUDIO" .wav)"
TRANSCRIPT="$BASE_DIR/transcripts/$NAME.txt"
SCRATCH="$BASE_DIR/transcripts/.whisply-work/$NAME"

mkdir -p "$BASE_DIR/transcripts"

if [[ -f "$TRANSCRIPT" ]]; then
  echo "Transcript exists, skipping: $TRANSCRIPT" >&2
  echo "$TRANSCRIPT"
  exit 0
fi

# whisply renames its -f input in place and writes a nested output dir, so run it
# against a hardlinked copy in a scratch dir (keeps recordings/ pristine) and run it
# from $MEETINGS_BASE (whisply crashes on output dirs outside cwd). All chatter to
# stderr so stdout is just the final transcript path.
run_whisply() {
  local diarize="$1"
  rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
  ln "$AUDIO" "$SCRATCH/audio.wav" 2>/dev/null || cp "$AUDIO" "$SCRATCH/audio.wav"
  local args=(run -f "$SCRATCH/audio.wav" -o "$SCRATCH" -d "$WHISPLY_DEVICE" -m "$WHISPLY_MODEL" -l "$WHISPLY_LANG" -e txt)
  if [[ "$diarize" == "1" && -n "${HF_TOKEN:-}" ]]; then
    args+=(--annotate -hf "$HF_TOKEN")
  fi
  ( cd "$BASE_DIR" && "$WHISPLY_BIN" "${args[@]}" ) >&2
}

echo "Transcribing: $AUDIO" >&2
if ! run_whisply "$DIARIZE"; then
  if [[ "$DIARIZE" == "1" && -n "${HF_TOKEN:-}" ]]; then
    echo "Diarized run failed; retrying without diarization." >&2
    run_whisply 0
  else
    echo "whisply failed for $AUDIO" >&2
    exit 1
  fi
fi

# Normalize whisply's nested output to the flat transcripts/<name>.txt (prefer the
# speaker-annotated variant), matching what the daemon produces.
SRC="$(find "$SCRATCH" -name '*_annotated.txt' | head -1)"
[[ -n "$SRC" ]] || SRC="$(find "$SCRATCH" -name "*_${WHISPLY_LANG}.txt" | head -1)"
[[ -n "$SRC" ]] || SRC="$(find "$SCRATCH" -name '*.txt' | head -1)"

if [[ -n "$SRC" ]]; then
  cp "$SRC" "$TRANSCRIPT"
else
  echo "No transcript produced (no speech?) — writing empty transcript." >&2
  : > "$TRANSCRIPT"
fi

rm -rf "$SCRATCH"
echo "$TRANSCRIPT"
