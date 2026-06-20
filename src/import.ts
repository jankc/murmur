// `murmur import` engine: a pure producer that feeds external recordings into the pipeline.
// For each configured source it diffs the on-disk files against a ledger, materialises +
// transcodes only the new ones, and atomically drops meeting-<stamp>.flac into inbox/. From
// there the existing watcher/queue/worker take over unchanged. It touches only inbox/, its
// scratch dir, and the ledger — never the queue, worker, daemon, or failed/.
//
// Crash/dedup safety has two layers: the ledger (keyed by stable-id + size) skips re-work,
// and a locate() backstop skips anything already in inbox/processed/failed — so a lost ledger
// or a mid-run crash can never double-import, only re-discover.
import { mkdirSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./state.ts";
import { loadSources, enumerate } from "./sources.ts";
import { ensureLocal } from "./materialize.ts";
import { transcodeToFlac16k } from "./transcode.ts";
import { CANONICAL_AUDIO_EXT } from "./paths.ts";
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
    log.info("import", "no enabled sources (see sources.json) — nothing to do");
    return { sources: [] };
  }
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

      // External failures (download/transcode) stay here — never reach murmur's failed/. Leave
      // the item un-ledgered so the next run retries it.
      if (!(await ensureLocal(c.srcPath, c.storage))) {
        failed++;
        continue;
      }

      const tmp = join(cfg.paths.importTmpDir, `${c.basename}${CANONICAL_AUDIO_EXT}`);
      if (!(await transcodeToFlac16k(cfg, c.srcPath, tmp))) {
        rmSync(tmp, { force: true });
        failed++;
        continue;
      }

      // Atomic rename into inbox/ (same filesystem) — the watcher never sees a partial file.
      try {
        await rename(tmp, cfg.paths.inboxWav(c.basename));
      } catch (err) {
        log.error("import", `could not finalize ${c.basename}: ${String(err)}`);
        rmSync(tmp, { force: true });
        failed++;
        continue;
      }
      ledger.items[c.id] = { size: c.size, basename: c.basename, importedAt: Date.now() };
      imported++;
      log.info("import", `imported ${c.id} → inbox/${c.basename}${CANONICAL_AUDIO_EXT}`);
    }

    summaries.push({ name: src.name, scanned: candidates.length, imported, failed });
  }

  // Persist once at the end. Safe: anything imported-but-unledgered (mid-run crash) is caught
  // by the locate() backstop on the next run.
  await writeJsonAtomic(cfg.paths.importLedger, ledger);
  return { sources: summaries };
}
