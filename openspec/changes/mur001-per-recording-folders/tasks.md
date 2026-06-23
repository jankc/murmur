## 1. Path model (`src/paths.ts`)

- [x] 1.1 Add an `ARTIFACTS` map of in-folder filenames (`recording` builder taking the ext,
      `transcript.txt`, `summary.md`, `asr.log`) and a `recordingFolder(lifecycleDir, base)` helper;
      keep `paths.ts` pure (no fs).
- [x] 1.2 Remove the `transcripts/`/`summaries/` top-level dirs and the `transcript(base)`/
      `summary(base)`/`inboxWav`/`partialWav` helpers (or repoint them to folder-relative builders);
      update the `Paths` interface and `buildPaths`.
- [x] 1.3 Update any callers that referenced the removed helpers to derive in-folder paths from
      `dirname(recordingFile)` + `ARTIFACTS`.

## 2. Folder-based locate / move / resolve (`src/recordings.ts`)

- [x] 2.1 Rewrite `locate(base)` to find the `<base>/` folder across `inbox`, `failed`, and
      `processed/<YYYY-MM>` (glob), returning the folder dir.
- [x] 2.2 Rewrite `resolveWav` to return the `recording.<ext>` inside the located folder (preserve
      absolute-path and cwd-relative input handling).
- [x] 2.3 Rewrite `move(base, to)` to relocate the whole folder atomically (rename), keep the
      `src === dest` idempotent no-op, and fall back to copy+unlink on `EXDEV`.

## 3. Producers (`src/recorder.ts`, `src/import.ts`)

- [x] 3.1 Recorder: stage `.partial/<base>/recording.flac`, finalize there, then atomically rename
      the folder into `inbox/<base>/`; make `start()` return the `base`.
- [x] 3.2 Update `record` CLI case to use the returned `base`.
- [x] 3.3 Import: build `.import-tmp/<base>/recording.<ext>` and atomically rename the folder into
      `inbox/`; keep the ledger + `locate()` dedup backstop intact.

## 4. Watcher (`src/watcher.ts`)

- [x] 4.1 Watch `inbox/` for new recording **folders** and enqueue on a complete folder (atomic
      publish = ready); keep a size-stability fallback on the inner `recording.<ext>` for
      hand-dropped folders.
- [x] 4.2 Update the boot reconcile to enumerate `inbox/*/` folders instead of files.

## 5. Pipeline (`src/worker.ts`, `src/engines/asr.ts`, `src/engines/ollama.ts`, `src/archive.ts`)

- [x] 5.1 Worker: derive transcript/summary paths from the recording folder; `move(base, …)` moves
      the folder; confirm the serial-worker contract is unchanged.
- [x] 5.2 ASR: read `recording.<ext>`, write `transcript.txt` and the per-job `asr.log` inside the
      folder (silence-trim temps still in os tmpdir).
- [x] 5.3 Ollama: read `transcript.txt`, write `summary.md`, and write per-job error capture into
      the folder.
- [x] 5.4 Archive: read `summary.md` + `transcript.txt` from the folder (vault note path unchanged).

## 6. Cleanup & status (`src/purge.ts`, `src/status.ts`, `src/queue.ts`, `src/jobstate.ts`)

- [x] 6.1 Purge: enumerate recording folders and remove the whole `<base>/` folder for flagged
      recordings.
- [x] 6.2 Status: count `failed/*/` folders (and any folder-based counts) instead of files.
- [x] 6.3 Confirm `QueueItem.wavPath` points at the in-folder `recording.<ext>`; `basename` stays the
      key; reconcile the persisted queue from `inbox/*/` on boot.

## 7. One-time migration of existing data (performed, then removed)

This is a single-user app with one data store, so the legacy→folder conversion was done as a
**one-time operation** rather than retained as a permanent feature. A throwaway planner+applier was
written (idempotent, rename-only, conflict-safe), the existing `MEETINGS_BASE` was backed up and
converted (98 files → per-recording folders; verified, idempotent re-run a no-op), and **all
migration code was then removed** — no `murmur migrate` command, no daemon boot hook, no
`recording-migration` spec retained.

- [x] 7.1 One-time conversion executed and verified on the live `MEETINGS_BASE` (backup taken first).
- [x] 7.2 All migration scaffolding removed afterward: `src/migrate.ts` + test, the `murmur migrate`
      CLI command, and the daemon boot migration hook. Leftover audioless orphans (transcripts/
      summaries with no recording) were left in place for manual cleanup.

## 8. Docs & tests

- [x] 8.1 Update `README.md` and `murmur.toml.example` to describe the per-recording folder layout.
- [x] 8.2 Update existing tests touching paths/recordings/watcher/queue to the folder model.
- [x] 8.3 Add tests: folder-based `locate`/`move` (incl. idempotent no-op) and watcher folder
      detection. (Migration planner tests were written, used to validate the one-time conversion,
      then removed with the migration tooling.)
- [x] 8.4 Verify end-to-end: `bun test` green; the one-time conversion was dry-run-previewed then
      applied + verified on the live tree (idempotent re-run a no-op); `locate`/`resolveWav` confirmed
      to resolve the migrated folders.
