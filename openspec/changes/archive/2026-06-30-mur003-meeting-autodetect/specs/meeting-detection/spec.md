## ADDED Requirements

### Requirement: Detect the microphone going live

The system SHALL detect when a meeting has started by observing the system default input device's
running state — the CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` property — which
becomes true whenever any process opens the microphone. Observation MUST be permission-free: it
MUST NOT require the Microphone (TCC) grant, MUST NOT trigger a permission prompt, and MUST NOT
itself activate the microphone. Detection MUST be app-agnostic at the signal level (it fires for
Teams, Slack, Zoom, Meet, FaceTime, or any other app that opens the mic). The watcher SHALL
re-target the input device if the system default input device changes while it is running.

#### Scenario: Mic activation is detected
- **WHEN** any application opens the default input device while the watcher is running
- **THEN** the watcher observes the device entering the running state and reports a mic-on event

#### Scenario: Mic deactivation is detected
- **WHEN** the application that held the input device releases it
- **THEN** the watcher observes the device leaving the running state and reports a mic-off event

#### Scenario: Observation does not require or trigger mic permission
- **WHEN** the watcher starts observing the input device
- **THEN** no microphone permission prompt is shown and no microphone-in-use indicator is activated
  by the watcher

#### Scenario: Default input device change is followed
- **WHEN** the system default input device changes (e.g. a headset is connected) while the watcher
  is running
- **THEN** the watcher observes the new default input device for subsequent activations

### Requirement: Attribute the microphone to the owning app

On a mic-on event the system SHALL determine which application(s) currently hold the microphone, by
bundle identifier, using a permission-free reading of the CoreAudio process-object list (no audio
capture, no TCC prompt). A mic-on event SHALL be treated as a meeting only when at least one mic owner
is in the configured meeting **allowlist** (`[autorecord].apps`, default Microsoft Teams, Slack, Zoom)
**and** none of the mic owners is in the configured **ignore-list** (`[autorecord].ignore_apps`). When
the mic owner cannot be determined, the system MUST fail closed (no nudge). Both lists MUST be
configurable. This attribution MUST NOT rely on whether an app is merely running — only on which app
actually holds the microphone.

#### Scenario: Mic owned by an allowlisted meeting app
- **WHEN** the microphone goes live and the app holding it (e.g. Microsoft Teams) is in the allowlist
- **THEN** the event is treated as a meeting and the user is nudged

#### Scenario: Dictation app ignored despite a meeting app running in the background
- **WHEN** a dictation app (e.g. VoiceInk) holds the microphone while a meeting app (e.g. Teams) is
  running but does not hold the microphone
- **THEN** no nudge is shown, because the mic owner is not an allowlisted meeting app

#### Scenario: Ignore-list vetoes a nudge
- **WHEN** a mic owner is in `[autorecord].ignore_apps`
- **THEN** no nudge is shown even if another listed condition would otherwise qualify

#### Scenario: Unknown mic owner fails closed
- **WHEN** the microphone goes live but the owning app cannot be determined
- **THEN** no nudge is shown

#### Scenario: Allowlist and ignore-list are configurable
- **WHEN** the user sets `[autorecord].apps` and/or `[autorecord].ignore_apps` in `murmur.toml`
- **THEN** only mic owners in the allowlist (and not in the ignore-list) qualify a mic-on event as a
  meeting

### Requirement: Daemon-owned watcher with anti-spam guards

When meeting detection is enabled, the daemon SHALL own the watcher for the lifetime of the daemon:
it MUST start the watcher at daemon startup and tear it down on shutdown. The daemon MUST apply
guards so a meeting is nudged at most once per call and brief microphone blips are ignored: it MUST
debounce a mic-on event by a configurable interval (`[autorecord].debounce_seconds`) before nudging,
MUST NOT nudge while a recording is already in progress, and MUST suppress nudges for a configurable
cooldown (`[autorecord].cooldown_seconds`) after a recording stops. The watcher MUST NOT crash the
daemon: a watcher process error MUST be logged and recovered from without taking down processing.

#### Scenario: Brief mic blip does not nudge
- **WHEN** the microphone goes live and then off again within the debounce interval
- **THEN** no nudge is shown

#### Scenario: No nudge while already recording
- **WHEN** the microphone goes live (with a meeting app running) but murmur is already recording
- **THEN** no nudge is shown

#### Scenario: Cooldown after stopping
- **WHEN** a recording has just been stopped and the microphone is still (or again) live within the
  cooldown window
- **THEN** no nudge is shown until the cooldown elapses

#### Scenario: Watcher lifecycle follows the daemon
- **WHEN** the daemon shuts down
- **THEN** the watcher process is terminated as part of the shutdown sequence

### Requirement: One-click record nudge

The system SHALL, when a meeting is detected (subject to the guards above) and detection mode is
`notify`, present a notification that lets the user start recording with a single click. Clicking
the notification MUST start a recording (equivalent to `murmur record`); ignoring or dismissing it
MUST do nothing. The notification MUST NOT start a recording on its own — recording begins only on
the user's click.

#### Scenario: Notification offers one-click record
- **WHEN** a meeting is detected in `notify` mode
- **THEN** a notification is shown whose click starts a recording

#### Scenario: Ignoring the nudge records nothing
- **WHEN** the user does not interact with the meeting notification
- **THEN** no recording is started

#### Scenario: Clicking the nudge starts recording
- **WHEN** the user clicks the meeting notification
- **THEN** a recording is started

### Requirement: Menubar reflects a detected meeting

While a meeting has been detected and murmur is idle (not recording), the menubar (SwiftBar) SHALL
present a prominent one-click "Start recording" affordance and indicate the detected state. The
indication MUST clear once a recording starts, the recording is stopped, or the microphone goes off.
The menubar MUST continue to render its existing idle/recording/paused states.

#### Scenario: Detected meeting shows a menubar action
- **WHEN** a meeting has been detected and murmur is idle
- **THEN** the menubar shows a one-click "Start recording" item and a detected-meeting indication

#### Scenario: Indication clears when recording starts
- **WHEN** the user starts recording from the menubar (or the notification)
- **THEN** the detected-meeting indication clears and the menubar shows the recording state

#### Scenario: Indication clears when the mic goes off
- **WHEN** the microphone goes off without a recording having been started
- **THEN** the detected-meeting indication clears

### Requirement: Detection is opt-in and configurable

Meeting detection SHALL be controlled by `[autorecord].mode` and default to `off`, so the behavior
is strictly opt-in and unchanged for existing users until enabled. Supported modes MUST include
`off` (no detection) and `notify` (detect and nudge). Configuration MUST follow the project's
`env > murmur.toml > defaults` precedence and be reportable via `murmur print-env`. When mode is
`off`, the watcher MUST NOT run.

#### Scenario: Default is off
- **WHEN** `[autorecord]` is not configured
- **THEN** no watcher runs and no meeting nudges occur

#### Scenario: Enabling notify mode
- **WHEN** the user sets `[autorecord].mode = "notify"` and restarts the daemon
- **THEN** the daemon runs the watcher and nudges on detected meetings

#### Scenario: Configuration is reported
- **WHEN** the user runs `murmur print-env`
- **THEN** the resolved `[autorecord]` settings appear among the exported configuration

### Requirement: Detection requires the ownscribe backend

Meeting detection SHALL depend on the ownscribe Swift capture helper (which provides the
`watch-mic` capability). When detection is enabled but unavailable — the backend is not `ownscribe`,
or the helper lacks the `watch-mic` subcommand — the system MUST NOT fail the daemon or the
pipeline; it MUST degrade by not running detection and MUST surface the condition through the health
check shared by `murmur doctor` and the daemon self-check (at warn level, not error).

#### Scenario: Non-ownscribe backend with detection enabled
- **WHEN** `[autorecord].mode = "notify"` but the recording backend is `ffmpeg`
- **THEN** detection does not run and `murmur doctor` reports a warning explaining detection needs
  the ownscribe backend

#### Scenario: Helper missing the watch-mic subcommand
- **WHEN** detection is enabled and the ownscribe backend is selected but the installed helper does
  not support `watch-mic`
- **THEN** detection does not run, the daemon keeps processing normally, and the health check warns
