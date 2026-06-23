## ADDED Requirements

### Requirement: Migrate legacy scattered artifacts into per-recording folders

The system SHALL provide a migration that converts the legacy layout (audio in
`recordings/{inbox,processed/<YYYY-MM>,failed}`, transcript in `transcripts/<base>.txt`, summary in
`summaries/<base>.md`, ASR log in `logs/asr-<base>.log`) into per-recording folders. For each
recording, the migration MUST create a `<base>/` folder in the recording's current lifecycle
directory and move its audio to `recording.<ext>`, its transcript to `transcript.txt`, its summary
to `summary.md`, and its ASR log to `asr.log`. The recording's lifecycle directory (inbox /
processed-month / failed) MUST be preserved.

#### Scenario: A processed recording with all artifacts is folded into a folder
- **WHEN** the migration runs and finds `processed/2026-06/meeting-X.flac`,
  `transcripts/meeting-X.txt`, and `summaries/meeting-X.md`
- **THEN** it produces `processed/2026-06/meeting-X/` containing `recording.flac`, `transcript.txt`,
  and `summary.md`
- **AND** the original scattered files no longer exist

### Requirement: Migration is idempotent and re-runnable

The migration SHALL be safe to run multiple times. Re-running it after a complete or partial
migration MUST converge to the same result without error and MUST NOT duplicate, nest, or corrupt
already-migrated folders.

#### Scenario: Re-running after a complete migration is a no-op
- **WHEN** the migration runs a second time on an already-migrated tree
- **THEN** it reports nothing to do and changes no files

#### Scenario: A partial migration is completed on the next run
- **WHEN** a previous run moved the audio into `<base>/` but was interrupted before the transcript
- **THEN** a subsequent run moves the remaining `transcripts/<base>.txt` into `<base>/transcript.txt`
  without disturbing the already-moved audio

### Requirement: Migration never orphans or destroys data

The migration MUST NOT lose or overwrite data. A recording that lacks a transcript or summary (e.g.
still pending, or failed) MUST still be migrated correctly with only the files it has. The
migration MUST refuse to overwrite an existing destination file and MUST leave a recording untouched
(and report it) rather than guess when its artifacts are ambiguous.

#### Scenario: A recording with no transcript yet is still migrated
- **WHEN** the migration finds `inbox/meeting-Y.flac` with no transcript or summary
- **THEN** it produces `inbox/meeting-Y/recording.flac` and creates no empty transcript/summary files

#### Scenario: A conflicting destination is not overwritten
- **WHEN** a destination file already exists and differs from the source
- **THEN** the migration leaves both in place and reports the conflict instead of overwriting

### Requirement: Migration offers a dry run and an explicit apply

The migration SHALL default to a dry run that reports exactly what it would move, and only mutate
the filesystem when explicitly applied. It MUST be invocable as a `murmur migrate` CLI command and
MUST run once automatically on daemon boot so a daemon never operates on a mixed-layout tree.

#### Scenario: Dry run reports without changing anything
- **WHEN** `murmur migrate` is run without `--apply`
- **THEN** it prints the planned moves and changes no files

#### Scenario: Apply performs the migration
- **WHEN** `murmur migrate --apply` is run
- **THEN** it performs the planned moves and reports a summary

#### Scenario: Daemon boot migrates a legacy tree once
- **WHEN** the daemon starts and detects legacy scattered artifacts
- **THEN** it runs the migration once before processing so all subsequent work uses folders
