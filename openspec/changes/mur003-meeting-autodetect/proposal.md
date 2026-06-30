## Why

Recordings only happen when the user remembers to run `murmur record` — and the user keeps
forgetting to start it when a Teams or Slack meeting begins, losing the recording entirely. There
is no signal today that a meeting has started. This change makes murmur notice when a call goes
live and nudge the user with a one-click "record this?" prompt, so starting a recording becomes a
single click instead of a thing to remember.

## What Changes

- **Detect "the mic just went live."** Add a `watch-mic` subcommand to the vendored Swift capture
  helper (`capture/Sources/AudioCapture.swift` → `ownscribe-audio`). It observes the CoreAudio
  property `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device — a
  permission-free, system-wide signal that fires whenever **any** app opens the microphone (Teams,
  Slack huddles, Zoom, Meet, FaceTime). It prints `mic on` / `mic off` lines to stdout and runs a
  run loop until signalled. This is the only meeting signal needed: one property covers every app,
  with no per-app integration, no calendar, and no cloud APIs.
- **Only nudge for real meetings — match the app that actually holds the mic.** On a mic-on edge the
  helper reads the permission-free CoreAudio process-object list
  (`kAudioHardwarePropertyProcessObjectList` + `kAudioProcessPropertyIsRunningInput` +
  `kAudioProcessPropertyBundleID`, macOS 14.4+) to get the bundle id(s) of the apps holding the mic,
  and emits them. The daemon nudges only when a mic owner is in the meeting **allowlist** (default
  Teams/Slack/Zoom) and none is in an optional **ignore-list** (e.g. dictation tools). This is exact:
  dictation apps like VoiceInk are ignored by their bundle id even when Teams/Slack are merely running
  in the background — closing the false-positive loophole a "which apps are running" check would have.
- **Daemon owns the watcher.** The long-lived daemon (a LaunchAgent in the user's GUI session)
  spawns `watch-mic`, debounces brief blips, and suppresses the nudge when already recording or
  within a short cooldown after the last stop. A new `src/meetwatch.ts` module; only started when
  detection is enabled and the backend is `ownscribe`.
- **One-click record via notification.** On a confirmed meeting edge the daemon fires a
  `terminal-notifier` notification — "Mic is live — record this meeting?" — whose **click** runs
  `murmur record` (the `-execute` hook; terminal-notifier dropped action buttons in v2.0.0, so
  click-to-execute is the affordance). Clicking records; ignoring it does nothing.
- **Menubar mirror.** The daemon writes a small `meeting-detected` state flag; SwiftBar (which
  already polls every 5s) reflects it as a prominent "● Meeting detected — Start recording" item
  plus an icon tint when the mic is live and murmur is idle. It clears on record/stop or mic-off.
- **Config + doctor.** A new `[autorecord]` table (`mode = off | notify`, default **off**; `apps`
  allowlist; `ignore_apps` denylist; `debounce_seconds`; `cooldown_seconds`), wired through `src/config.ts`
  (env > toml > default) and `configAsEnv`/`print-env`. A warn-level `murmur doctor` check that
  surfaces when detection is configured but unavailable (e.g. non-`ownscribe` backend, or the
  helper lacks the `watch-mic` subcommand).

## Capabilities

### New Capabilities
- `meeting-detection`: detecting that a meeting has started by observing the system microphone going
  live (permission-free CoreAudio) and attributing the mic owner by bundle id (permission-free
  process-object API), gated by a meeting-app allowlist + optional ignore-list; the daemon-owned
  watcher with debounce / already-recording / cooldown guards; and the one-click "record this
  meeting?" nudge surfaced via a click-to-record notification and a SwiftBar menubar item. Covers
  the `[autorecord]` configuration (including the default-off opt-in) and the doctor check.

### Modified Capabilities
<!-- None as a delta spec. This change consumes existing behavior (the daemon lifecycle, the
     ownscribe helper, recorder.start(), notify(), and SwiftBar rendering) but does not change any
     requirement those carry. The recording-storage capability is unaffected: a nudge-initiated
     recording is an ordinary `murmur record`. The interaction is captured under Impact /
     Dependencies. -->

## Impact

- `capture/Sources/AudioCapture.swift`: new `watch-mic` subcommand (device-property wake-up listener
  + permission-free process-object mic-owner attribution + run loop), added as a documented
  `LOCAL PATCH` so it survives upstream syncs; `capture/README.md` notes the patch.
- `src/meetwatch.ts` (new): spawns `ownscribe-audio watch-mic`, reads the emitted mic-owner bundle
  ids, classifies them against the allowlist/ignore-list, applies debounce + already-recording +
  cooldown guards, and triggers the nudge; writes the `meeting-detected` state flag.
- `src/daemon.ts`: start/stop the meeting watcher in `runDaemon()` when enabled and backend is
  `ownscribe`; tear it down in the shutdown path alongside the other subsystems.
- `src/notify.ts`: extend to support an optional click-action (`-execute`) so the notification can
  launch `murmur record`.
- `src/swiftbar.ts` / `src/status.ts`: surface the `meeting-detected` flag as a menubar item +
  icon tint, cleared on record/stop/mic-off.
- `src/config.ts`: new `[autorecord]` keys (mode/apps/debounce/cooldown) in the KEYS mapping,
  `tomlToRawEnv`, defaults, and `configAsEnv`.
- `src/health.ts`: a warn-level detection-availability check (shared by `doctor` + daemon
  self-check).
- `murmur.toml.example` / `README.md`: document `[autorecord]`, the one-time setup (set
  terminal-notifier to "Alerts" so the reminder persists), and the ownscribe-only requirement.
- State: a new `meeting-detected` flag under `$MEETINGS_BASE/state/` (inspectable, transient).
- Tests: unit tests for the debounce/guard logic (pure where possible) and the notify
  click-action assembly.

## Dependencies

- **Order:** 3 of 3
- **Depends on:** the daemon (control/lifecycle), the `ownscribe` recording backend + its Swift
  helper, `recorder.start()`, `notify()`, and SwiftBar rendering — all already shipped. No
  unshipped change blocks this. Builds alongside `mur001-per-recording-folders` and
  `mur002-summary-context` (both archived) without depending on their specs.
- **Blocks:** none.
- **Status:** proposed.
