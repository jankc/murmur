## Context

murmur records only when the user runs `murmur record` (CLI, the SwiftBar "Start recording" item,
or the "Meeting Recorder Start" Automator app). The user keeps forgetting to do this when a Teams
or Slack call starts, so meetings go unrecorded. There is no signal in the system that a meeting is
underway.

The pieces this design builds on already exist:
- A long-lived **daemon** (`src/daemon.ts`, `runDaemon`) installed as a LaunchAgent in the user's
  GUI session. It wires a watcher → queue → worker and a localhost control API, and has a clean
  start/shutdown path. A LaunchAgent (not a LaunchDaemon) can post user notifications.
- The **ownscribe** recording backend's vendored Swift helper (`capture/Sources/AudioCapture.swift`
  → `ownscribe-audio`), which already uses CoreAudio to resolve `kAudioHardwarePropertyDefaultInputDevice`,
  enumerate devices, and list running apps via `NSWorkspace`. It dispatches subcommands
  (`capture`, `request-mic`, `list-apps`, `list-devices`) from `main()` and carries three documented
  `LOCAL PATCH`es over upstream.
- `recorder.start()` (idempotent — returns "already recording" if live), `notify()` (best-effort
  `terminal-notifier`), and `renderSwiftBar()` (renders purely from on-disk state, every 5s).

The signal to use is the microphone going live. Research (OverSight, MicCheck, Apple's TAOMM Ch.12)
confirms that observing the CoreAudio property `kAudioDevicePropertyDeviceIsRunningSomewhere` on the
default input device is permission-free (no Microphone TCC grant, no prompt, no orange indicator —
you observe device run-state, you do not capture) and fires for **any** app that opens the mic. That
makes it a single universal "a call started" wake-up signal with no per-app integration.

That coarse signal can't say *which* app opened the mic — but on macOS 14.4+ (the user is on 26.5,
well past that) a second permission-free CoreAudio API can: enumerate
`kAudioHardwarePropertyProcessObjectList` and read each process object's
`kAudioProcessPropertyIsRunningInput` + `kAudioProcessPropertyBundleID`. Verified against Apple's
docs and the insidegui/AudioCap reference: **reading** the process list and run-state needs no TCC,
no entitlement, and no usage-description — only *creating a process tap* (capturing a process's
audio, which we never do) is gated. So we get exact, permission-free attribution of the mic owner by
bundle id. This is what lets a meeting-app allowlist (and a dictation-app ignore-list) be *exact*
rather than the weak "is some meeting app running" proxy.

## Goals / Non-Goals

**Goals:**
- Notice when a meeting starts (the app *holding the mic* is a known meeting app) and nudge the
  user with a **one-click** "record this?" prompt; ignoring it does nothing.
- **Attribute the mic to the owning app by bundle id**, so the allowlist is exact and dictation
  apps (VoiceInk, etc.) are reliably ignored — even when a meeting app is idling in the background.
- Reuse what exists: the detector lives in the Swift helper murmur already builds and signs; the
  watcher lives in the daemon; the nudge reuses `notify()`; the menubar reuses SwiftBar.
- Strictly opt-in (`[autorecord].mode` defaults to `off`) so existing behavior is unchanged until
  enabled.
- Keep false positives cheap and rare: exact mic-owner allowlist + optional ignore-list + debounce
  + already-recording + cooldown guards; and the worst case is one dismissible notification.

**Non-Goals:**
- **Auto-record** (start without a click). Deferred — the user chose notify-only for now. The
  `mode` enum leaves room to add `auto` later without a redesign.
- Calendar/EventKit integration (misses ad-hoc huddles; needs Calendar permission + link parsing).
- Teams/Slack/cloud APIs (Azure app registration / OAuth — far too heavy for a local solo tool).
- Capturing/tapping a process's audio for attribution — we only *read* run-state (permission-free);
  we never create a process tap (which would need TCC + a usage-description).
- Camera-in-use detection (CoreMediaIO) — a possible future complement (see Risks), not in v1.
- A two-button `[Record] [Dismiss]` prompt via `alerter` — avoided to not add a dependency;
  click-to-record on the existing `terminal-notifier` is enough.
- ffmpeg-backend support — detection requires the ownscribe Swift helper.

## Decisions

**1. Wake on `kAudioDevicePropertyDeviceIsRunningSomewhere`, in the existing Swift helper.**
Add a `watch-mic` subcommand to `AudioCapture.swift`. It resolves the default input device, registers
an `AudioObjectAddPropertyListener` for that property (global scope), and also listens on
`kAudioHardwarePropertyDefaultInputDevice` to re-target when the default device changes. The CoreAudio
callback only signals *that* state changed, so on each callback the helper re-queries the property to
learn whether the mic is now live. It runs a `CFRunLoop` and exits cleanly on SIGINT/SIGTERM.
*Why here:* the helper is already CoreAudio-native, already built and code-signed by murmur, and shells
out cleanly to the daemon — no new dependency, no new build path, no fragile log-scraping.
*Alternative (TypeScript/shell polling):* rejected — there is no clean CLI for this property; the only
non-Swift route is unified-log parsing, which is exactly the fragile, private-framework path OverSight
needs and which we explicitly avoid.

**2. Attribute the mic owner by bundle id (permission-free), and emit it on the edge.** On a mic-on
edge, the helper enumerates `kAudioHardwarePropertyProcessObjectList` and collects the bundle ids of
the process objects whose `kAudioProcessPropertyIsRunningInput` is true — i.e. the apps that actually
hold the mic right now. It prints `mic on <bundleid,bundleid,…>` (the live input owners) and
`mic off` (line-buffered, flushed). *Why this over "is a meeting app running" (NSWorkspace):* Teams and
Slack run in the background all day, so a running-app check would fire a false nudge every time the
user dictates with a meeting app merely open. Matching the *mic owner* makes both the allowlist and the
ignore-list **exact** — VoiceInk holding the mic is `com.…voiceink`, never a meeting app, so it's
ignored regardless of what else is running. This is verified permission-free on macOS 14.4+ (reads
only; we never create a tap). *Listener caveat:* per-process `IsRunningInput` listeners are known not
to fire on macOS, so we deliberately do **not** listen on it — we use the reliable device-property edge
(decision 1) as the wake-up and read the process list synchronously on that edge. *Fallback:* if the
process list is empty/unavailable on the edge (timing), the helper may briefly re-read; if still empty
it emits `mic on` with no owners and the daemon treats it as "unknown owner → do not nudge" (fail
closed, never a false nudge). *Decision (allow/ignore) lives in the daemon (TS),* not the helper — see
decision 3 — so the helper stays a dumb sensor and the policy is unit-tested.

**3. The daemon owns the watcher; classification + guards live in `src/meetwatch.ts` (TypeScript).** A
new module spawns `ownscribe-audio watch-mic`, reads stdout line-by-line, classifies the emitted
mic-owner bundle ids against the configured allowlist and ignore-list, and decides whether to nudge.
Default allowlist: `com.microsoft.teams2` (Teams), `com.tinyspeck.slackmacgap` (Slack), `us.zoom.xos`
(Zoom). Classification rule: nudge only if at least one mic owner is in the allowlist **and** none of
the owners is in the ignore-list; otherwise stay silent. Matching is **prefix-aware** (an owner matches
a list entry exactly or as a dot-delimited helper sub-process), because Electron/WebView meeting apps
open the mic from a helper — verified: a Teams call's mic owner is `com.microsoft.teams2.modulehost`,
not `com.microsoft.teams2`. Keep
the helper dumb (emit edges) and the *policy* in TS where it's testable:
- **Debounce:** on a mic-on (meeting) edge, wait `debounce_seconds` and confirm the mic is still on
  (re-check via the most recent edge state) before nudging — filters notification dings / quick
  dictation blips.
- **Already-recording guard:** skip if `recorder.isRecording()`.
- **Cooldown:** skip if a recording stopped within `cooldown_seconds` (so ending a meeting and the mic
  lingering, or a quick re-trigger, doesn't immediately re-prompt).
- **One nudge per call:** don't re-nudge until a mic-off edge has been seen (re-arm on mic-off).
The watcher is started from `runDaemon()` only when `mode !== "off"` and `recordBackend === "ownscribe"`,
and torn down in the existing `shutdown()` alongside the worker/watcher/server. A spawn/stream error is
logged and the watcher is not retried in a tight loop (bounded restart), never crashing the daemon —
mirroring the existing "never let a subsystem error take down processing" stance.

**4. One-click via `terminal-notifier -execute`.** terminal-notifier removed action buttons in v2.0.0,
so the affordance is *click the notification body* → run a command. Extend `notify()` with an optional
`execute` argument; the meeting nudge passes `-execute "<murmur-cli> record"` (the resolved CLI path,
same one SwiftBar/daemon already know). `notify()` stays best-effort and never throws. *Why not
`alerter`:* a nicer two-button prompt, but a new brew dependency for marginal UX; click-to-record is
genuinely one click. The `mode` enum can gain a future `auto` that calls `recorder.start()` directly
instead of notifying.

**5. Menubar mirrors a `meeting-detected` state flag.** The watcher writes a tiny flag file under
`state/` (e.g. `meeting.json`: `{ detectedAt, active }`) on the debounced meeting edge, and clears it on
mic-off, on record start, and on stop. `offlineSnapshot()`/`renderSwiftBar()` read it (SwiftBar already
renders purely from on-disk state every 5s): when set and idle, show a prominent "● Meeting detected —
Start recording" item and tint the icon. *Why a flag file, not a SwiftBar-side live query:* SwiftBar is
deliberately daemon-independent and renders from disk; a flag file fits that model and avoids spawning
the helper from every 5s tick. When the daemon is down, detection simply doesn't run (acceptable —
detection is inherently a daemon feature).

**6. Config: a new `[autorecord]` table, default off.** Keys: `mode` (`off` | `notify`, default
`off`), `apps` (allowlist of meeting-app bundle ids; default `["com.microsoft.teams2",
"com.tinyspeck.slackmacgap", "us.zoom.xos"]`), `ignore_apps` (denylist of bundle ids that must never
nudge even if also somehow allowlisted — e.g. dictation tools; default `[]` since non-allowlisted apps
are already ignored), `debounce_seconds` (default `4`), `cooldown_seconds` (default `30`). Wire through
`KEYS`, `tomlToRawEnv`, the resolved `Config`, and `configAsEnv` (so `print-env`/the launchd env carry
them). Each array is encoded for the flat env layer as a delimited string (consistent with the existing
string-only env mapping). *Why default off:* opt-in keeps the change inert for existing setups until
the user enables it. *Why an ignore-list at all when the allowlist already excludes everything else:* a
belt-and-suspenders escape hatch, and headroom for a future `auto` mode where "ignore" must hard-veto.

**7. Doctor check, warn-level.** Add a `health.ts` check: when `mode !== "off"`, verify the backend is
`ownscribe` and the helper advertises `watch-mic` (cheap probe). Warn (don't error) if not — detection
is optional and must never block the pipeline. Shared by `murmur doctor` and the daemon self-check, per
the existing pattern.

**8. `watch-mic` is a documented LOCAL PATCH.** The file already tracks three local patches over
upstream ownscribe. Add `watch-mic` as a fourth, marked with `LOCAL PATCH`, and note it in
`capture/README.md` and the sync tooling's re-apply checklist so a future upstream sync doesn't silently
drop detection.

## Risks / Trade-offs

- **False positives.** Largely *designed out* by attributing the mic owner: dictation apps (VoiceInk,
  etc.) and any non-meeting app are ignored by bundle id, even with Teams/Slack idling in the
  background — the loophole a "running-app" check would have had. Residual case: a *meeting app itself*
  opening the mic for something that isn't a call (rare). → Debounce + already-recording + cooldown,
  and `mode` defaults to `notify` (a dismissible banner), so the worst case is one ignored
  notification. Accepted.
- **`IsRunningInput` = IO-open, not non-zero audio.** A meeting app holding the mic *muted* still reads
  as in-use. → Irrelevant: we classify by *which* app holds the mic, not whether it's speaking; "Teams
  has the mic open" is exactly the "you're in a call" signal we want.
- **`IsRunningInput` property listeners don't fire (macOS bug).** → We don't listen on it; the
  device-level `…DeviceIsRunningSomewhere` edge is the wake-up and we read the process list
  synchronously on that edge (decision 2). Unknown/empty owner on the edge fails closed (no nudge).
- **Per-process attribution needs macOS 14.4+.** → The user is on 26.5; well within range. If ever run
  on older macOS, the helper omits owners and the daemon fails closed (no nudge) — degraded, not wrong.
- **Bluetooth-mic detection gap.** The coarse `…DeviceIsRunningSomewhere` wake-up can under-report for
  some Bluetooth mics; treated as folklore (no single authoritative bug) but worth testing. → The user
  records on the built-in mic / speakers, so unlikely to bite; documented. Future mitigation: a
  camera-in-use listener (CoreMediaIO, same permission-free technique) as a complementary wake-up —
  out of scope for v1.
- **Notifications don't appear / don't persist.** A LaunchAgent in the GUI session *can* post (a
  LaunchDaemon couldn't), and terminal-notifier must be authorized in System Settings → Notifications.
  For the reminder to stay on screen rather than auto-dismiss, the user should set terminal-notifier to
  **Alerts** (not Banners). → Documented as one-time setup in the README; the existing `notify()` is
  already best-effort so a swallowed notification never breaks anything.
- **Helper patch lost on upstream sync.** → Marked `LOCAL PATCH` + README + sync re-apply checklist
  (same protection the existing three patches have). If lost, `watch-mic` simply isn't recognized →
  the doctor check warns and detection no-ops; it fails safe, not silently-wrong.
- **Watcher process dies / floods stdout.** → Bounded restart with backoff and error logging; never a
  tight respawn loop; the daemon's processing is unaffected by a dead watcher.
- **Stale `meeting-detected` flag (daemon crash mid-meeting).** → The flag carries `detectedAt`;
  SwiftBar/snapshot treat a flag older than a small TTL as cleared, and record/stop always clear it, so
  a crash can't leave a permanently "meeting detected" menubar.
- **ownscribe-only.** ffmpeg-backend users get no detection. → Acceptable (ownscribe is the
  recommended backend) and surfaced by the doctor check.

## Migration Plan

Purely additive and opt-in. No data migration. `[autorecord].mode` defaults to `off`, so after this
change ships nothing happens until the user (a) rebuilds the helper to get `watch-mic`
(`bash capture/build.sh && cp capture/bin/ownscribe-audio ~/.local/bin/`), (b) sets
`[autorecord].mode = "notify"` in `murmur.toml`, and (c) `murmur daemon restart`. Rollback is a code
revert plus dropping the `[autorecord]` block; the new `state/meeting.json` flag is inert without the
reader, and the old helper binary keeps working for recording (it just won't know `watch-mic`).

## Open Questions

- **Debounce/cooldown defaults** (4s / 30s) are first guesses — tune from real use; they're config, so
  no code change to adjust.
- **Bundle id of the dictation tools to pre-seed in `ignore_apps`?** VoiceInk's bundle id (and any
  others the user is trialing) — capture them via `ownscribe-audio watch-mic` output during a
  dictation session and document them as commented examples. Not required (non-allowlisted apps are
  already ignored), purely convenience.
- **Should the nudge also offer a one-click "don't ask again for this app/today"?** Out of scope for
  v1 (terminal-notifier has no buttons); revisit only if false positives prove annoying in practice.
- **Re-arm policy** — re-nudge only after a mic-off edge (chosen) vs. after a fixed interval. Mic-off
  re-arm is simplest and matches "one call = at most one nudge"; revisit if a single call cycles the
  mic.
