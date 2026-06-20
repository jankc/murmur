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
- **Pinned commit:** see [`UPSTREAM`](UPSTREAM) — the single source of truth, updated by the sync tooling below
- **License:** MIT, © 2026 Pascal Berrang — see `LICENSE` (kept per the MIT terms)

`Sources/AudioCapture.swift` tracks upstream with **one local patch**: a `--max-duration N`
flag (a one-shot timer that fires the normal merge+exit), so a `murmur record` capture
self-caps like the ffmpeg backend without depending on the daemon — search the file for
`LOCAL PATCH`. The only change from upstream `swift/build.sh` is `BIN_DIR` → `capture/bin/`
(gitignored), so the artifact lands next to its source. Upstream's `Package.swift` is
**not** vendored: it under-links frameworks (only CoreAudio + AudioToolbox) and `swift build`
fails — `build.sh`'s direct `swiftc` call is the real, supported build path.

## Keeping in sync

[`UPSTREAM`](UPSTREAM) pins the exact commit this mirror is taken from. Two ways to update:

- **On demand (the updater):** `scripts/sync-capture.sh` fetches upstream and prints the
  diff; re-run with `--apply` to copy the new source, bump `UPSTREAM`, and rebuild. Pass a
  ref to target a specific branch/tag/commit (default: upstream `main`).
- **Notification (optional):** `.github/workflows/check-capture-upstream.yml` runs weekly
  and opens an issue when upstream moves past the pinned commit. Delete it if unwanted.

`LICENSE` tracks upstream verbatim. `Sources/AudioCapture.swift` carries the local
`--max-duration` patch and `build.sh` deviates on `BIN_DIR`, so after a sync **re-apply the
patch** (search `LOCAL PATCH`); `scripts/sync-capture.sh` warns about this on `--apply`. If
the patch is ever lost, `murmur record` fails loudly with `Unknown option: --max-duration`
rather than silently dropping the cap.

After any sync, redeploy the binary: `cp capture/bin/ownscribe-audio ~/.local/bin/`.

## Build

```sh
bash capture/build.sh                              # → capture/bin/ownscribe-audio
cp capture/bin/ownscribe-audio ~/.local/bin/       # the default OWNSCRIBE_BIN path
```

Requires the Xcode Command Line Tools (`xcode-select --install`) and macOS 14.2+.
First run prompts for Screen Recording (and, with `--mic`, Microphone) permission.
