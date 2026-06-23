#!/usr/bin/env bash
set -euo pipefail

# Vendored from ownscribe (see README.md in this directory). Two local deviations from
# upstream swift/build.sh:
#   1. BIN_DIR: build into capture/bin/ (gitignored) instead of a repo-root bin/, to keep
#      the artifact alongside its source.
#   2. [LOCAL PATCH] Embed Info.plist (NSMicrophoneUsageDescription) into the binary via
#      -sectcreate, then re-sign ad-hoc. Without an embedded usage string macOS cannot show
#      a Microphone permission prompt for this CLI, so a launcher that lacks the grant (e.g.
#      the SwiftBar menubar) silently records a SILENT mic. The string makes the request
#      promptable so the launching app can be granted. See capture/Info.plist.
# The swiftc invocation's frameworks are otherwise byte-for-byte upstream.

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
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SCRIPT_DIR/Info.plist" \
    "$SCRIPT_DIR/Sources/AudioCapture.swift"

# Re-seal ad-hoc so the signature covers the embedded __info_plist section (TCC reads the
# usage string from it and requires a valid signature). [LOCAL PATCH — see header.]
codesign --force --sign - "$BIN_DIR/ownscribe-audio"

echo "Built: $BIN_DIR/ownscribe-audio"
