#!/usr/bin/env bash
set -euo pipefail

# Vendored from ownscribe (see README.md in this directory). Two local deviations from
# upstream swift/build.sh:
#   1. BIN_DIR: build into capture/bin/ (gitignored) instead of a repo-root bin/, to keep
#      the artifact alongside its source.
#   2. [LOCAL PATCH] Embed Info.plist (NSMicrophoneUsageDescription) into the binary via
#      -sectcreate, then code-sign. Without an embedded usage string macOS cannot show a
#      Microphone permission prompt for this CLI; combined with the self-disclaim in
#      AudioCapture.swift, the binary requests mic/screen access as ITS OWN responsible process
#      and holds its own grants (independent of the launcher, e.g. the SwiftBar menubar). We sign
#      with a STABLE self-signed identity when one is present so the binary's code identity — and
#      therefore those TCC grants — survive rebuilds; otherwise we fall back to ad-hoc (grants
#      reset on every rebuild). See capture/Info.plist and capture/README.md.
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

# Re-seal so the signature covers the embedded __info_plist section (TCC reads the usage string
# from it and requires a valid signature). Prefer a stable self-signed identity so the binary's
# Microphone + Screen Recording grants persist across rebuilds; ad-hoc otherwise. [LOCAL PATCH.]
CODESIGN_IDENTITY="${OWNSCRIBE_CODESIGN_IDENTITY:-murmur-ownscribe-codesign}"
if security find-identity -p codesigning 2>/dev/null | grep -q "$CODESIGN_IDENTITY"; then
  echo "Signing with stable identity: $CODESIGN_IDENTITY"
  codesign --force --sign "$CODESIGN_IDENTITY" --identifier com.jank.murmur.ownscribe-audio "$BIN_DIR/ownscribe-audio"
else
  echo "Stable identity '$CODESIGN_IDENTITY' not found — ad-hoc signing (TCC grants reset on each rebuild)"
  codesign --force --sign - "$BIN_DIR/ownscribe-audio"
fi

echo "Built: $BIN_DIR/ownscribe-audio"
