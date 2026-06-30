## Context

murmur stores a recording's artifacts in four separate trees keyed by a shared basename: audio in
`recordings/{inbox,processed/<YYYY-MM>,failed}`, `transcripts/<base>.txt`, `summaries/<base>.md`,
and `logs/asr-<base>.log`. Two invariants make the current design work and must be preserved:

- **Location is state.** `src/recordings.ts` (`locate`/`move`/`resolveWav`) and the worker treat the
  parent lifecycle dir (`inbox` → `processed/<month>` → `failed`) as the recording's status. There is
  no status field; the folder's home *is* the status.
- **Atomic publish.** Producers never expose a half-written recording to the watcher: the recorder
  builds in `.partial/` and the importer in `.import-tmp/`, then `rename()` the finished file into
  `inbox/`. `src/paths.ts` is pure (no fs); all filesystem probing lives in `recordings.ts`.

This change groups each recording's artifacts into one folder named by its basename, keeping both
invariants. It is the storage foundation that mur002 (per-recording summary context) builds on.

## Goals / Non-Goals

**Goals:**
- One folder per recording (`<base>/`) holding `recording.<ext>`, `transcript.txt`, `summary.md`,
  `asr.log`; the folder is the unit that moves through the lifecycle.
- Folder-based `locate`/`move`/`resolveWav`, preserving idempotent `move` and import dedup.
- A safe, idempotent **one-time** conversion of existing data (tooling removed afterward — solo app).
- Keep `src/paths.ts` pure and the serial-worker contract unchanged.

**Non-Goals:**
- The Obsidian vault note (keyed by title) — unchanged.
- Global daemon logs (`daemon.out/err`, `import.*`, `process-failures.log`) — stay in `logs/`.
- Any change to transcription/summarization behavior, the queue's ordering, or the control API.

## Decisions

### 1. The recording folder is identified by `dirname(recording file)`; `paths.ts` stays pure
Artifact filenames become **constants relative to a recording folder** (`recording.<ext>`,
`transcript.txt`, `summary.md`, `asr.log`). Rather than have `paths.ts` resolve *where* a folder
currently lives (which needs fs access), the pipeline derives in-folder paths from the recording
file it is already handed: `folderDir = dirname(job.wavPath)`, `transcript = join(folderDir,
"transcript.txt")`, etc. `paths.ts` exposes the lifecycle dirs + a small `ARTIFACTS` map and helpers
like `recordingFolder(lifecycleDir, base)`; `recordings.ts` keeps all fs probing.
*Alternative considered:* make `paths.transcript(base)` async and self-resolve via `locate()` —
rejected because it pushes fs I/O into the pure path layer and changes every call site's signature.

### 2. Producers build the folder in a staging dir, then atomically rename it into `inbox/`
The recorder assembles `.partial/<base>/recording.flac` (and finalizes there) and the importer
assembles `.import-tmp/<base>/recording.<ext>`, then each `rename()`s the **folder** into `inbox/`.
Because the staging dirs sit under `recordingsDir` (same filesystem), the directory rename is atomic.
This means **a folder appearing in `inbox/` is, by construction, complete** — the watcher needs no
per-file size polling for our own producers.
*Alternative considered:* write directly into `inbox/<base>/` and rely on size-stability — rejected
as racier and a regression from today's atomic-publish guarantee.

### 3. Watcher enqueues on a complete `inbox/<base>/` folder
The watcher switches from "stable audio file at the inbox root" to "a recording folder under
`inbox/`". For atomically-published folders it enqueues immediately; as a defensive fallback for a
folder that appears incrementally (e.g. a user hand-drops one), it keeps a size-stability check on
the inner `recording.<ext>` before enqueuing. The reconcile-on-boot pass enumerates `inbox/*/`
folders instead of files.

### 4. `move` relocates the whole folder; `locate`/`resolveWav` target the folder
`move(base, to)` computes the destination folder (`processed/<YYYY-MM>/<base>/` or `failed/<base>/`)
and renames the whole directory, preserving the existing `src === dest` no-op for idempotency.
`locate(base)` globs `inbox/<base>/`, `failed/<base>/`, `processed/*/<base>/`; `resolveWav` returns
the `recording.<ext>` inside the located folder. Import dedup (`ledger` + `locate` backstop) is
unchanged in behavior.

### 5. Per-recording engine logs move into the folder; global logs stay put
The ASR per-job log becomes `<folder>/asr.log` (and ollama's per-job error capture writes into the
same folder), so a recording's diagnostics travel with it. `murmur logs` (daemon/import/failures)
is unaffected.

### 6. Migration is a one-time operation, performed then removed (not a retained feature)
This is a single-user app with one data store, so converting the legacy layout is a **one-time
bootstrap**, not ongoing behavior worth carrying in the codebase. A throwaway planner enumerated
legacy artifacts into a move plan (`<src> → <folder>/<role>`) and an applier executed it —
**idempotent** (skips already-foldered recordings), **non-destructive** (rename-only; refuses to
overwrite a differing destination; reports conflicts), and **never orphans** (migrates whatever files
a recording has, and leaves audioless transcripts/summaries in place rather than guessing a lifecycle
dir). It was run with a dry-run preview, applied against a backed-up store (verified; idempotent
re-run a no-op), and then **all migration code was removed** — no `murmur migrate` command, no daemon
boot hook. The boot watcher reconcile already rebuilds the queue from `inbox/*/`, so no migration-time
queue handling is retained either.
*Alternative considered:* keep `murmur migrate` + an auto-run-on-boot hook permanently — rejected as
dead weight for a one-shot need in a solo app (the user explicitly preferred migrate-once-then-remove).

## Risks / Trade-offs

- **Watcher regression / races** → Lean on atomic folder-rename publish (Decision 2) so completeness
  is structural; keep a size-stability fallback only for hand-dropped folders. Add watcher tests.
- **Migration on real user data** → Was dry-run-previewed, idempotent, rename-only, no overwrites,
  no deletes, run against a backed-up `MEETINGS_BASE` (98 files, verified; re-run a no-op). Tooling
  removed afterward, so this risk does not recur.
- **Migration vs a running daemon** → The (old-code) daemon was stopped before the one-time apply, so
  nothing raced the conversion.
- **Cross-device rename (EXDEV)** if `MEETINGS_BASE` ever spans filesystems → staging dirs are under
  `recordingsDir` (same fs); fall back to copy+unlink if `rename` reports `EXDEV`.
- **Breaking on-disk layout** → there is no external consumer of `transcripts/`/`summaries/` beyond
  this app and the vault archive (out of scope); the migration converts existing data in place.

## Migration Plan

1. Land code in dependency order: `paths.ts` → `recordings.ts` → producers (`recorder`, `import`) →
   `watcher` → pipeline (`worker`, `asr`, `ollama`, `archive`) → `purge`/`status` → docs/tests.
2. One-time data conversion (done, then tooling removed): stop the daemon, back up `MEETINGS_BASE`,
   dry-run preview, apply the throwaway migration, verify (idempotent re-run a no-op), then delete the
   migration module/CLI/boot-hook.
3. Deploy: merge this folder-only branch and start the daemon on the already-converted store.
4. Rollback: the conversion only renamed files; recoverable from the backup at
   `~/murmur-premigrate-backup-2026-06-23` if ever needed.

## Resolved Questions

- `asr.log` lives **in the recording folder** (diagnostics travel with the recording), not in `logs/`.
- Migration is a **one-time manual operation, not retained** — no daemon auto-apply, no `murmur
  migrate` command (single-user app; the conversion runs exactly once).
- Path call sites were **hard-cut** to the folder model (no back-compat shims) — it's all in-repo.
