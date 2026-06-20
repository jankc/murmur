#!/usr/bin/env bash
set -euo pipefail
# Idempotent first-run setup for murmur. Safe to re-run. See README → Install.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "==> murmur.toml"
if [ ! -f murmur.toml ]; then
  cp murmur.toml.example murmur.toml
  echo "    created murmur.toml from example — edit meetings_base / [summary].model before first use"
else
  echo "    exists"
fi

echo "==> ASR venv (mlx-whisper + pyannote.audio)"
# Honor a python set under [asr] in murmur.toml — resolve it via the CLI (the same loader the
# daemon uses) so setup agrees on the venv path; else doctor/ASR break after a "successful" setup.
eval "$(bun run "$REPO_DIR/src/cli.ts" print-env 2>/dev/null || true)"
VENV_PY="${MURMUR_PYTHON:-$HOME/.local/share/murmur/asr-venv/bin/python}"
VENV_DIR="$(dirname "$(dirname "$VENV_PY")")"
command -v uv >/dev/null 2>&1 || { echo "    ERROR: uv not found — brew install uv"; exit 1; }
[ -x "$VENV_PY" ] || uv venv --python 3.12 "$VENV_DIR"
uv pip install --python "$VENV_PY" mlx-whisper "pyannote.audio>=4.0"

echo "==> murmur CLI symlink (~/.local/bin/murmur)"
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO_DIR/src/cli.ts" "$HOME/.local/bin/murmur"

echo "==> capture helper (ownscribe backend)"
if command -v swiftc >/dev/null 2>&1; then
  bash "$REPO_DIR/capture/build.sh"
  cp "$REPO_DIR/capture/bin/ownscribe-audio" "$HOME/.local/bin/ownscribe-audio"
  echo "    built + installed ownscribe-audio"
else
  echo "    skipped (no swiftc — install Xcode CLT: xcode-select --install — for the ownscribe backend)"
fi

echo "==> daemon (LaunchAgent)"
"$HOME/.local/bin/murmur" daemon install

echo
echo "==> done. Verify with:  murmur doctor"
