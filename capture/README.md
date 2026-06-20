# capture/ — vendored audio-capture helper

This is the macOS audio-capture helper for the `ownscribe` recording backend, vendored
into murmur so the recorder no longer depends on cloning and building an external repo.

It builds the `ownscribe-audio` binary: one process that captures system audio
(ScreenCaptureKit) **and** the mic (AVFAudio) and, on SIGINT, merges them
host-time-aligned into a single 24 kHz mono-float WAV. No output routing, so the macOS
volume keys keep working. `src/recorder.ts` (`startOwnscribe`) spawns it as:

```
ownscribe-audio capture -o <file>.oa.wav --mic --capture-mode-all
```

and stops it with SIGINT, then ffmpeg-transcodes the result to 16 kHz s16le.

## Provenance

- **Upstream:** https://github.com/paberr/ownscribe (the `swift/` subproject)
- **Commit:** `5a5d501f700f82d10175a6caa36d72267769f7ec` (2026-06-02)
- **License:** MIT, © 2026 Pascal Berrang — see `LICENSE` (kept per the MIT terms)

`Sources/AudioCapture.swift` is byte-for-byte upstream. The only change from upstream
`swift/build.sh` is `BIN_DIR` → `capture/bin/` (gitignored), so the artifact lands next
to its source instead of in a repo-root `bin/`. Upstream's `Package.swift` is **not**
vendored: it under-links frameworks (only CoreAudio + AudioToolbox) and `swift build`
fails — `build.sh`'s direct `swiftc` call is the real, supported build path.

To re-sync with a newer upstream, diff `Sources/AudioCapture.swift` against
`swift/Sources/AudioCapture.swift` at the new commit and update the hash above.

## Build

```sh
bash capture/build.sh                              # → capture/bin/ownscribe-audio
cp capture/bin/ownscribe-audio ~/.local/bin/       # the default OWNSCRIBE_BIN path
```

Requires the Xcode Command Line Tools (`xcode-select --install`) and macOS 14.2+.
First run prompts for Screen Recording (and, with `--mic`, Microphone) permission.
