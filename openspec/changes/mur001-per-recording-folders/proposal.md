## Why

Every artifact for one recording is scattered across separate top-level directories and linked
only by filename: the audio lives in `recordings/inbox` → `recordings/processed/<YYYY-MM>` →
`recordings/failed`, the transcript in `transcripts/<base>.txt`, the summary in
`summaries/<base>.md`, and the per-job ASR log in `logs/asr-<base>.log`. Inspecting or cleaning up
one recording means hopping across four trees, and the only link between the pieces is a fragile
shared basename. Consolidating each recording's artifacts into a single folder makes the data
self-describing and is the natural home for the upcoming per-recording summary context (mur002).

## What Changes

- **BREAKING (on-disk layout):** each recording becomes a **folder named by its basename** holding
  role-named files — `recording.<ext>`, `transcript.txt`, `summary.md`, `asr.log` (and, via mur002,
  `context.md`). The standalone `transcripts/` and `summaries/` top-level dirs are removed.
- The **folder is the unit that moves** through the lifecycle, preserving today's "location is
  state" model: `recordings/inbox/<base>/` → `recordings/processed/<YYYY-MM>/<base>/` →
  `recordings/failed/<base>/`.
- `locate`, `move`, and `resolveWav` (`src/recordings.ts`) become **folder-based** — `move()`
  relocates the whole folder atomically and stays idempotent when already in its terminal home.
- The **watcher** detects a complete recording inside a new `inbox/<base>/` folder instead of a bare
  audio file; the **recorder** and **import** produce `inbox/<base>/recording.<ext>`; the **worker**,
  **asr**, **ollama**, **archive**, and **purge** read/write folder-relative paths (and the per-job
  ASR log moves into the folder as `asr.log`).
- A new **one-time, idempotent migration** moves existing scattered artifacts into per-recording
  folders so current data is not orphaned, exposed as `murmur migrate` (and run once on daemon boot).
- Docs (`README.md`, `murmur.toml.example`) describe the new layout.

## Capabilities

### New Capabilities
- `recording-storage`: the per-recording folder layout, the folder-as-state lifecycle
  (`inbox` → `processed/<YYYY-MM>` → `failed`), and folder-based `locate`/`move`/`resolveWav` —
  including how the recorder, import, watcher, and pipeline produce and consume the folder.
- `recording-migration`: a safe, idempotent, re-runnable migration from the legacy scattered layout
  to per-recording folders, with a dry-run and a guarantee it never orphans or destroys data.

### Modified Capabilities
<!-- None — openspec/specs/ has no existing specs; this change establishes the first ones. -->

## Impact

- **Core data model:** `src/paths.ts` (path helpers become folder-relative and resolve a recording's
  current lifecycle folder), `src/recordings.ts` (`locate`/`move`/`resolveWav`).
- **Producers:** `src/recorder.ts` (`.partial` staging → `inbox/<base>/recording.flac`),
  `src/import.ts` (copy into `inbox/<base>/recording.<ext>`, keep ledger + `locate` dedup),
  `src/watcher.ts` (detect a stable recording inside a new folder).
- **Pipeline:** `src/worker.ts`, `src/engines/asr.ts` (writes `asr.log` + `transcript.txt` in-folder),
  `src/engines/ollama.ts`, `src/archive.ts` (vault note keyed by title is out of scope),
  `src/purge.ts` (remove the whole folder), `src/queue.ts`/`src/jobstate.ts`/`src/status.ts`
  (`QueueItem` keeps `basename` as key; `wavPath` points into the folder).
- **New surface:** a `murmur migrate` CLI command + a one-shot migration on daemon boot.
- **Tests & docs:** tests touching paths/recordings/watcher/queue updated; new coverage for
  folder-based `locate`/`move` and the migration; `README.md` + `murmur.toml.example` updated.
- **Out of scope:** the Obsidian vault note path (keyed by title, unchanged); the serial-worker
  contract must not change.

## Dependencies

- **Order:** 1 of 2
- **Depends on:** none
- **Blocks:** `mur002-summary-context` (its `context.md` lives in the per-recording folder this change
  introduces)
- **Status:** proposed
