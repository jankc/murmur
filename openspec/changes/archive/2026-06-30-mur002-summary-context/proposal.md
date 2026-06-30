## Why

Summaries are generated purely from the transcript, but the user often knows things the transcript
can't convey — who each `SPEAKER_NN` is, what the meeting is about, project acronyms — that would
make a markedly better summary. There is no way to supply that. This change lets the user attach
free-form context to a recording from the CLI and have it injected at the summary step.

## What Changes

- Add a `--context` flag (alias `-c`) to `record`, `process`, `reprocess`, `transcribe`, and
  `summarize`. One flag, three input methods by value convention:
  - `--context "text"` — inline literal
  - `--context @path` — read from a file
  - `--context -` — read stdin until EOF (on a TTY, prompt first: the interactive "ask me, I type,
    Ctrl-D" mode; also supports piping)
- Persist the resolved text **per recording** as `context.md` inside the recording's folder (the
  folder introduced by `mur001-per-recording-folders`). Because it is persisted and keyed to the
  recording, a later `reprocess`/`summarize` reuses it without re-specifying.
- Inject context **only at the summary step**: `summarize()` reads `context.md` and, when non-empty,
  adds a delimited `--- KONTEXT OD UŽIVATELE ---` section between the type prompt and the transcript
  (mirroring how the transcript is already injected). Triage and transcription are untouched.
- Add a short instruction to `prompts/base.md` describing the optional context section (use it for
  accuracy; do not echo it verbatim or treat it as transcript; never invent beyond it).
- Fix CLI arg parsing so a `--context` value before the positional isn't mistaken for the positional.

## Capabilities

### New Capabilities
- `summary-context`: capturing optional per-recording context from the CLI (inline / file / stdin),
  persisting it as `context.md` in the recording folder, and injecting it into the summary prompt
  only — including that `record` (whose summary happens later in the daemon) persists it for that
  recording, and that `transcribe` persists it for a later summary even though it produces none.

### Modified Capabilities
<!-- None as a delta spec: this change adds context.md to the folder layout defined by mur001's
     recording-storage capability, but that spec is created by mur001 and not yet in
     openspec/specs/. The interaction is captured under Impact / Dependencies instead. -->

## Impact

- `src/engines/ollama.ts`: `summarize()` reads the optional `context.md` and assembles the prompt via
  a (testable, pure) helper that appends the context section only when non-empty; log when applied.
- `prompts/base.md`: a short instruction about the optional context section.
- `src/cli.ts`: a shared `resolveContext()` (literal / `@file` / `-` stdin) + `saveContext(base)`
  helper, wired into the five commands once each command's target `base` is known; a `positional()`
  fix so value-taking flags don't get mis-parsed.
- `prompts`/triage and transcription: explicitly **unchanged** (context is summary-only).
- Tests: a unit test for the prompt-assembly helper (context present vs absent); an end-to-end check
  that `--context` improves a regenerated summary.
- Depends on `mur001`'s per-recording folder for the `context.md` home and on `mur001`'s folder-aware
  `purge` to remove it with the recording.

## Dependencies

- **Order:** 2 of 2
- **Depends on:** `mur001-per-recording-folders` (provides the per-recording folder where `context.md`
  lives; without it this change would need a throwaway `context/<base>.md` store)
- **Blocks:** none
- **Status:** proposed — blocked until `mur001` is implemented
