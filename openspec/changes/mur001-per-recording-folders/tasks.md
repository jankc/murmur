## 1. Path model (`src/paths.ts`)

- [ ] 1.1 Add an `ARTIFACTS` map of in-folder filenames (`recording` builder taking the ext,
      `transcript.txt`, `summary.md`, `asr.log`) and a `recordingFolder(lifecycleDir, base)` helper;
      keep `paths.ts` pure (no fs).
- [ ] 1.2 Remove the `transcripts/`/`summaries/` top-level dirs and the `transcript(base)`/
      `summary(base)`/`inboxWav`/`partialWav` helpers (or repoint them to folder-relative builders);
      update the `Paths` interface and `buildPaths`.
- [ ] 1.3 Update any callers that referenced the removed helpers to derive in-folder paths from
      `dirname(recordingFile)` + `ARTIFACTS`.

## 2. Folder-based locate / move / resolve (`src/recordings.ts`)

- [ ] 2.1 Rewrite `locate(base)` to find the `<base>/` folder across `inbox`, `failed`, and
      `processed/<YYYY-MM>` (glob), returning the folder dir.
- [ ] 2.2 Rewrite `resolveWav` to return the `recording.<ext>` inside the located folder (preserve
      absolute-path and cwd-relative input handling).
- [ ] 2.3 Rewrite `move(base, to)` to relocate the whole folder atomically (rename), keep the
      `src === dest` idempotent no-op, and fall back to copy+unlink on `EXDEV`.

## 3. Producers (`src/recorder.ts`, `src/import.ts`)

- [ ] 3.1 Recorder: stage `.partial/<base>/recording.flac`, finalize there, then atomically rename
      the folder into `inbox/<base>/`; make `start()` return the `base`.
- [ ] 3.2 Update `record` CLI case to use the returned `base`.
- [ ] 3.3 Import: build `.import-tmp/<base>/recording.<ext>` and atomically rename the folder into
      `inbox/`; keep the ledger + `locate()` dedup backstop intact.

## 4. Watcher (`src/watcher.ts`)

- [ ] 4.1 Watch `inbox/` for new recording **folders** and enqueue on a complete folder (atomic
      publish = ready); keep a size-stability fallback on the inner `recording.<ext>` for
      hand-dropped folders.
- [ ] 4.2 Update the boot reconcile to enumerate `inbox/*/` folders instead of files.

## 5. Pipeline (`src/worker.ts`, `src/engines/asr.ts`, `src/engines/ollama.ts`, `src/archive.ts`)

- [ ] 5.1 Worker: derive transcript/summary paths from the recording folder; `move(base, …)` moves
      the folder; confirm the serial-worker contract is unchanged.
- [ ] 5.2 ASR: read `recording.<ext>`, write `transcript.txt` and the per-job `asr.log` inside the
      folder (silence-trim temps still in os tmpdir).
- [ ] 5.3 Ollama: read `transcript.txt`, write `summary.md`, and write per-job error capture into
      the folder.
- [ ] 5.4 Archive: read `summary.md` + `transcript.txt` from the folder (vault note path unchanged).

## 6. Cleanup & status (`src/purge.ts`, `src/status.ts`, `src/queue.ts`, `src/jobstate.ts`)

- [ ] 6.1 Purge: enumerate recording folders and remove the whole `<base>/` folder for flagged
      recordings.
- [ ] 6.2 Status: count `failed/*/` folders (and any folder-based counts) instead of files.
- [ ] 6.3 Confirm `QueueItem.wavPath` points at the in-folder `recording.<ext>`; `basename` stays the
      key; reconcile the persisted queue from `inbox/*/` on boot.

## 7. Migration (`murmur migrate` + daemon boot)

- [ ] 7.1 Pure planner: enumerate legacy artifacts (audio in lifecycle dirs, `transcripts/<base>.txt`,
      `summaries/<base>.md`, `logs/asr-<base>.log`) and emit a move plan into per-recording folders,
      preserving each recording's lifecycle dir.
- [ ] 7.2 Applier: execute the plan idempotently (skip already-foldered), rename-only, refuse to
      overwrite a differing destination, never create empty transcript/summary files, report conflicts.
- [ ] 7.3 Add `murmur migrate` CLI: dry-run by default, `--apply` to execute; refuse/coordinate when a
      daemon holds the lock.
- [ ] 7.4 Run the migration once on daemon boot (guarded by legacy detection) before the worker loop.

## 8. Docs & tests

- [ ] 8.1 Update `README.md` and `murmur.toml.example` to describe the per-recording folder layout and
      `murmur migrate`.
- [ ] 8.2 Update existing tests touching paths/recordings/watcher/queue to the folder model.
- [ ] 8.3 Add tests: folder-based `locate`/`move` (incl. idempotent no-op), the migration planner
      (idempotent, no-orphan, conflict-safe), and watcher folder detection.
- [ ] 8.4 Verify end-to-end: `bun test` green; `murmur migrate` dry-run then `--apply` on the existing
      tree; round-trip a recording through `record` → daemon `process` → `reprocess`, and
      `murmur summarize`/`transcribe`, confirming all resolve folder paths.
