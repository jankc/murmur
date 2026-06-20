#!/usr/bin/env bash
set -euo pipefail

# Vendored from ownscribe (see README.md in this directory). The only change from
# upstream swift/build.sh is BIN_DIR: we build into capture/bin/ (gitignored) instead
# of a repo-root bin/, to keep the build artifact alongside its source. The swiftc
# invocation and linked frameworks are byte-for-byte upstream.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"

mkdir -p "$BIN_DIR"

echo "Building ownscribe-audio..."
swiftc \
    -O \
    -o "$BIN_DIR/ownscribe-audio" \
    -framework ScreenCaptureKit \
    -framework CoreMedia \
    -framework AVFAudio \
    -framework AppKit \
    -framework CoreGraphics \
    -framework CoreAudio \
    -framework AudioToolbox \
    "$SCRIPT_DIR/Sources/AudioCapture.swift"

echo "Built: $BIN_DIR/ownscribe-audio"
