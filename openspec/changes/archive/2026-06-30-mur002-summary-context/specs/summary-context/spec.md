## ADDED Requirements

### Requirement: Supply summary context from the CLI

The system SHALL accept optional free-form context for a recording via a `--context` flag (alias
`-c`) on the `record`, `process`, `reprocess`, `transcribe`, and `summarize` commands. One flag MUST
support three input methods, selected by its value: a literal string, `@<path>` to read the
contents of a file, or `-` to read stdin until EOF (printing a prompt first when stdin is a TTY, so
it doubles as an interactive "type it, then Ctrl-D" mode and as a pipe target). The context MUST
apply to the recording the command resolves.

#### Scenario: Inline literal context
- **WHEN** the user runs `murmur summarize <base> --context "SPEAKER_00 = Petr; téma: AI governance"`
- **THEN** that text is captured as the recording's context

#### Scenario: Context from a file
- **WHEN** the user runs a supported command with `--context @notes.md`
- **THEN** the contents of `notes.md` are captured as the recording's context

#### Scenario: Interactive / piped context via stdin
- **WHEN** the user runs a supported command with `--context -`
- **THEN** the system reads stdin until EOF (prompting first on a TTY) and captures it as the
  recording's context

### Requirement: Persist context per recording

Provided context SHALL be persisted with the recording (as `context.md` in the recording's folder)
so it is durable and travels with the recording. Empty or whitespace-only input MUST be a no-op: no
file is written and any existing context is left untouched. Removal of a recording (e.g. `murmur
purge`) MUST remove its context along with the recording's other artifacts.

#### Scenario: Context is stored with the recording
- **WHEN** context is supplied for `<base>`
- **THEN** it is saved as `<base>/context.md` in the recording's folder

#### Scenario: Empty context input is a no-op
- **WHEN** the resolved context is empty or only whitespace
- **THEN** no context file is written and any existing `context.md` is unchanged

### Requirement: Inject context into the summary step only

When a recording has non-empty context, the summarizer SHALL include it in the summary prompt as a
clearly delimited section preceding the transcript, instructing the model to use it for accuracy
(speaker identities, topics, acronyms) without treating it as transcript content or inventing beyond
it. Context MUST NOT influence transcription, nor the triage/classification step that selects the
summary type and language.

#### Scenario: Present context is injected into the summary prompt
- **WHEN** a recording with non-empty `context.md` is summarized
- **THEN** the summary prompt contains a delimited context section before the transcript
- **AND** the run logs that user context was applied

#### Scenario: Absent context leaves the prompt unchanged
- **WHEN** a recording has no context
- **THEN** the summary prompt contains no context section (no empty delimiters)

#### Scenario: Context does not affect transcription or triage
- **WHEN** context is present
- **THEN** the transcript and the triage type/language decision are identical to a run without
  context

### Requirement: Stored context is reused across re-runs

A later `summarize` or `reprocess` SHALL reuse a recording's stored context without the user
re-specifying `--context`, since context is persisted with the recording. Supplying `--context`
again MUST replace the stored context for that recording.

#### Scenario: Reprocess reuses stored context
- **WHEN** `murmur reprocess <base>` is run after context was previously supplied for `<base>`
- **THEN** the regenerated summary uses the stored context, with no `--context` flag needed

#### Scenario: New context replaces the stored one
- **WHEN** a command is run with `--context` for a recording that already has stored context
- **THEN** the stored context is replaced with the newly supplied value

### Requirement: Deferred-summary commands persist context for later

For commands that do not produce a summary in the same run, context SHALL still be captured for the
recording's eventual summary. `record` MUST persist context for the recording it starts (whose
summary happens later in the daemon). `transcribe` MUST persist context for a later summary even
though it produces no summary itself.

#### Scenario: Context given at record time is used by the daemon's summary
- **WHEN** the user runs `murmur record --context "…"` and the daemon later processes that recording
- **THEN** the daemon's summary uses the context captured at record time

#### Scenario: Context given at transcribe time is used by a later summarize
- **WHEN** the user runs `murmur transcribe <base> --context "…"` (which writes no summary) and later
  runs `murmur summarize <base>`
- **THEN** the summary uses the context captured at transcribe time
