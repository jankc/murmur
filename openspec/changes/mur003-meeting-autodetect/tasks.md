## 1. Detection in the Swift helper (`watch-mic`)

- [x] 1.1 In `capture/Sources/AudioCapture.swift`, add a `watch-mic` subcommand to `main()`'s dispatch and to the usage text, marked with a `LOCAL PATCH` comment (it is patch #4 over upstream).
- [x] 1.2 Resolve the default input device and register an `AudioObjectAddPropertyListener` for `kAudioDevicePropertyDeviceIsRunningSomewhere` (global scope, main element). On each callback, re-query the property and print `mic on` / `mic off` to stdout, line-buffered and flushed.
- [x] 1.3 Also register a listener on `kAudioHardwarePropertyDefaultInputDevice`; on change, move the running-state listener to the new default device (handle device hot-swap).
- [x] 1.4 On a mic-on edge, attribute the mic owner(s): enumerate `kAudioHardwarePropertyProcessObjectList`, read each process object's `kAudioProcessPropertyIsRunningInput` and (where true) `kAudioProcessPropertyBundleID`, and emit `mic on <bundleid,bundleid,…>`; emit `mic off` on the falling edge so the daemon can re-arm. Reads only — no process tap (permission-free). If the list is momentarily empty, re-read once; if still empty, emit `mic on` with no owners (daemon fails closed). Do NOT add a property listener on `IsRunningInput` (those don't fire) — read it synchronously on the device-property edge.
- [x] 1.5 Run a `CFRunLoop`; install SIGINT/SIGTERM handlers that stop the run loop and exit cleanly (so the daemon can terminate it on shutdown).
- [x] 1.6 Verify observation + attribution need no Microphone/audio-capture grant: confirm `watch-mic` runs, reports edges, and lists mic-owner bundle ids without triggering any TCC prompt and without lighting the mic indicator (reads only; no tap).
- [x] 1.7 Update `capture/README.md` (LOCAL PATCH list) and the `scripts/sync-capture.sh` re-apply checklist to include `watch-mic`.
- [x] 1.8 Rebuild and deploy the helper (`bash capture/build.sh && cp capture/bin/ownscribe-audio ~/.local/bin/`); sanity-check `ownscribe-audio watch-mic` by joining a Teams/Slack call (expect `mic on com.microsoft.teams2`) and by running a VoiceInk dictation (expect `mic on <voiceink-bundle-id>` — note the id for `ignore_apps` docs).

## 2. Configuration (`[autorecord]`)

- [x] 2.1 Add `[autorecord]` keys to `src/config.ts`: `mode` (`off` | `notify`, default `off`), `apps` (allowlist bundle ids, default `["com.microsoft.teams2","com.tinyspeck.slackmacgap","us.zoom.xos"]`), `ignore_apps` (denylist bundle ids, default `[]`), `debounce_seconds` (default `4`), `cooldown_seconds` (default `30`). Add them to `KEYS`, `tomlToRawEnv` (encode each array as a delimited string for the flat env layer), the resolved `Config` interface, and `loadConfig`.
- [x] 2.2 Add the same keys to `configAsEnv` so `murmur print-env` / the launchd env carry them; round-trip `apps`/`ignore_apps` through the delimiter.
- [x] 2.3 Add an `[autorecord]` block (commented, default-off, with the allowlist and a commented `ignore_apps` example) to `murmur.toml.example`.

## 3. Daemon-owned watcher (`src/meetwatch.ts`)

- [x] 3.1 Create `src/meetwatch.ts`: a `MeetingWatcher` that spawns `ownscribe-audio watch-mic`, reads stdout line-by-line, and tracks the latest mic on/off edge plus the emitted mic-owner bundle ids.
- [x] 3.2 Implement classification + nudge policy (kept here so it is testable): treat an edge as a meeting only when a mic owner is in `apps` AND none is in `ignore_apps` (unknown/empty owner → fail closed, no nudge); debounce by `debounce_seconds` and confirm still-on before nudging; skip when `recorder.isRecording()`; skip within `cooldown_seconds` of the last stop; re-arm only on a mic-off edge (at most one nudge per call).
- [x] 3.3 On a confirmed meeting edge, fire the nudge via `notify()` with the click-action (see 4.x) and write the `meeting-detected` state flag (see 5.x). Clear the flag on mic-off.
- [x] 3.4 Make it crash-safe: a spawn/stream error is logged and the watcher restarts with bounded backoff (no tight respawn loop); it must never crash the daemon.
- [x] 3.5 In `src/daemon.ts` `runDaemon()`, start the watcher only when `cfg.autorecord.mode !== "off"` and `cfg.recordBackend === "ownscribe"`; add it to the `shutdown()` teardown alongside worker/watcher/server.
- [x] 3.6 Track the last-stop timestamp for the cooldown (e.g. update it when a recording stops) so cooldown is enforced across record/stop cycles.

## 4. One-click notification

- [x] 4.1 Extend `src/notify.ts` to accept an optional click-action and pass `-execute <command>` to `terminal-notifier` when provided; keep it best-effort (never throws).
- [x] 4.2 The meeting nudge calls `notify(cfg, "Mic is live — record this meeting?", { execute: "<resolved murmur cli> record" })`, resolving the CLI path the same way SwiftBar/daemon already do.
- [x] 4.3 Confirm clicking the notification starts a recording and ignoring it does nothing.

## 5. Menubar (SwiftBar) mirror

- [x] 5.1 Add a `meeting-detected` state flag (e.g. `state/meeting.json` with `{ detectedAt, active }`) and a small read/write/clear helper; add its path to `src/paths.ts`.
- [x] 5.2 Surface the flag in `offlineSnapshot()` / `StatusSnapshot` (with a TTL so a stale flag from a daemon crash reads as cleared).
- [x] 5.3 In `src/swiftbar.ts`, when the flag is active and murmur is idle, render a prominent "● Meeting detected — Start recording" item and tint the icon; otherwise render as today.
- [x] 5.4 Clear the flag on record start, on stop, and on mic-off (wire into `recorder.start()`/`stop()` or the watcher as appropriate so the menubar can't get stuck).

## 6. Doctor / health check

- [x] 6.1 In `src/health.ts`, add a warn-level check: when `cfg.autorecord.mode !== "off"`, verify `recordBackend === "ownscribe"` and that the installed helper advertises `watch-mic` (cheap probe); warn (never error) with a clear remedy when not. Shared by `murmur doctor` and the daemon self-check.

## 7. Tests

- [x] 7.1 Unit-test the classification + nudge policy in `src/meetwatch.ts` (pure where possible): owner in allowlist → meeting; owner not allowlisted (e.g. VoiceInk) with Teams also an owner-or-not → no nudge; owner in ignore-list → no nudge; unknown/empty owner → no nudge (fail closed); debounced blip → no nudge; already-recording → no nudge; within cooldown → no nudge; re-arm only after mic-off.
- [x] 7.2 Unit-test `notify()` click-action assembly: with an `execute` option the spawned argv includes `-execute <command>`; without it, it doesn't.
- [x] 7.3 Unit-test the `meeting-detected` flag helper: set/clear and TTL-expiry behavior.
- [x] 7.4 `bun run typecheck` and `bun test` pass.

## 8. Docs

- [x] 8.1 Document `[autorecord]` in `README.md`: what it does (notify + one-click record when the app *holding the mic* is an allowlisted meeting app), the `apps` allowlist + `ignore_apps` denylist (with how to find a dictation app's bundle id via `watch-mic`), how to enable (rebuild helper → set `mode = "notify"` → `murmur daemon restart`), the ownscribe-only + macOS 14.4+ requirement, the one-time "set terminal-notifier to Alerts" note, and the known Bluetooth-mic gap.
- [x] 8.2 Note the new `watch-mic` subcommand and the menubar "Meeting detected" affordance where the SwiftBar and CLI surfaces are described.
