// `murmur import` engine: a pure producer that feeds external recordings into the pipeline.
// For each configured source it diffs the on-disk files against a ledger, materialises only the
// new ones, and atomically drops meeting-<stamp>.<ext> into inbox/ — keeping the source's own
// format (m4a/mp3/…). Imports are NOT transcoded: re-encoding already-compressed audio to FLAC
// just bloats it, and the pipeline (whisper + pyannote) reads any format. Only murmur's own
// captures are FLAC. From inbox/ the existing watcher/queue/worker take over unchanged; this
// touches only inbox/, its scratch dir, and the ledger — never the queue, worker, daemon, failed/.
//
// Crash/dedup safety has two layers: the ledger (keyed by stable-id + size) skips re-work,
// and a locate() backstop skips anything already in inbox/processed/failed — so a lost ledger
// or a mid-run crash can never double-import, only re-discover.
import { mkdirSync, rmSync } from "node:fs";
import { copyFile, rename } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./state.ts";
import { acquirePidLock, releasePidLock } from "./lock.ts";
import { loadSources, enumerate } from "./sources.ts";
import { ensureLocal } from "./materialize.ts";
import { isRecordingFile } from "./paths.ts";
import { locate } from "./recordings.ts";
import { log } from "./log.ts";

interface LedgerEntry {
  size: number;
  basename: string;
  importedAt: number;
}
interface Ledger {
  version: 1;
  items: Record<string, LedgerEntry>;
}

export interface SourceSummary {
  name: string;
  scanned: number;
  imported: number;
  failed: number;
}
export interface ImportSummary {
  sources: SourceSummary[];
  /** True when another `murmur import` already held the lock — this run did nothing. */
  skipped?: boolean;
}

/** A candidate is new (worth importing) when the ledger has never seen its id, or has seen it
 *  at a different size. Pure — unit-tested. */
export function isNew(ledger: Ledger, id: string, size: number): boolean {
  const e = ledger.items[id];
  return !e || e.size !== size;
}

async function loadLedger(cfg: Config): Promise<Ledger> {
  const l = await readJson<Ledger>(cfg.paths.importLedger, { version: 1, items: {} });
  return { version: 1, items: l?.items ?? {} }; // tolerate a hand-edited / older shape
}

export async function runImport(cfg: Config): Promise<ImportSummary> {
  const sources = loadSources(cfg);
  if (sources.length === 0) {
    log.info("import", "no enabled sources (see murmur.toml [[sources]]) — nothing to do");
    return { sources: [] };
  }

  // One import at a time. A hand-run `murmur import` and the launchd tick share the ledger and
  // the import scratch dir, so overlapping runs would clobber each other; if another run holds
  // the lock it's already doing the work, so skip — the next tick catches anything new. The
  // caller reports the skip; we just signal it.
  if (!acquirePidLock(cfg.paths.importLock)) {
    return { sources: [], skipped: true };
  }
  try {
    return await importSources(cfg, sources);
  } finally {
    releasePidLock(cfg.paths.importLock);
  }
}

/** The actual feed — always called while holding the import lock: scan each source, copy new
 *  files into inbox/, and persist the ledger once at the end. */
async function importSources(cfg: Config, sources: ReturnType<typeof loadSources>): Promise<ImportSummary> {
  mkdirSync(cfg.paths.inboxDir, { recursive: true });
  mkdirSync(cfg.paths.importTmpDir, { recursive: true });

  const ledger = await loadLedger(cfg);
  const summaries: SourceSummary[] = [];

  for (const src of sources) {
    const candidates = await enumerate(src);
    let imported = 0;
    let failed = 0;

    for (const c of candidates) {
      if (!isNew(ledger, c.id, c.size)) continue; // already imported (ledger hit)

      // Backstop: already somewhere in its lifecycle (inbox/processed/failed)? Record and skip
      // so a lost ledger or a re-run never re-imports an existing recording.
      if (await locate(cfg, c.basename)) {
        ledger.items[c.id] = { size: c.size, basename: c.basename, importedAt: Date.now() };
        continue;
      }

      // Reject an unsupported extension up front (before downloading or ledgering): the watcher
      // would never enqueue it, so importing it would silently strand the file in inbox/. Count it
      // as failed and leave it un-ledgered so it's visible and retried once the ext is whitelisted.
      const ext = extname(c.srcPath).toLowerCase();
      const name = `${c.basename}${ext}`;
      if (!isRecordingFile(name)) {
        log.warn("import", `${c.id}: "${ext || "no extension"}" isn't a supported audio format (add it to KNOWN_AUDIO_EXTS) — skipped`);
        failed++;
        continue;
      }

      // External failures (download) stay here — never reach murmur's failed/. Leave the item
      // un-ledgered so the next run retries it.
      if (!(await ensureLocal(c.srcPath, c.storage))) {
        failed++;
        continue;
      }

      // Copy the source verbatim (no transcode), keeping its extension. Copy to scratch first,
      // then atomic-rename into inbox/ (same filesystem) so the watcher never sees a partial file.
      const tmp = join(cfg.paths.importTmpDir, name);
      rmSync(tmp, { force: true });
      try {
        await copyFile(c.srcPath, tmp);
      } catch (err) {
        log.error("import", `could not copy ${c.id}: ${String(err)}`);
        rmSync(tmp, { force: true });
        failed++;
        continue;
      }
      try {
        await rename(tmp, join(cfg.paths.inboxDir, name));
      } catch (err) {
        log.error("import", `could not finalize ${c.basename}: ${String(err)}`);
        rmSync(tmp, { force: true });
        failed++;
        continue;
      }
      ledger.items[c.id] = { size: c.size, basename: c.basename, importedAt: Date.now() };
      imported++;
      log.info("import", `imported ${c.id} → inbox/${name}`);
    }

    summaries.push({ name: src.name, scanned: candidates.length, imported, failed });
  }

  // Persist once at the end. Safe: anything imported-but-unledgered (mid-run crash) is caught
  // by the locate() backstop on the next run.
  await writeJsonAtomic(cfg.paths.importLedger, ledger);
  return { sources: summaries };
}
