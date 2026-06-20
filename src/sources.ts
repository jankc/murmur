// External recording sources for `murmur import`. A source's specifics are config (data),
// not code: the generic "folder" adapter is fully driven by root + glob + a timestamp regex +
// a storage backend, which covers Just Press Record and most synced-folder cases. A future
// app that hides its data in a DB (e.g. Voice Memos) would add its own `type` + enumerate()
// here — the import engine, materialiser, and ledger stay unchanged.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Storage } from "./materialize.ts";
import { readMurmurToml, expandHome } from "./tomlconfig.ts";
import { parseStamp } from "./stamp.ts";
import { log } from "./log.ts";

export interface FolderSource {
  name: string; // stable label; also the ledger-id namespace
  type: "folder";
  root: string; // home-expanded absolute path
  glob: string; // relative to root, e.g. "*/*.m4a"
  storage: Storage; // how to materialise bytes before reading
  // The capture regex over the file's path-relative-to-root, with exactly 6 groups in order
  // year, month, day, hour, minute, second. For JPR: "<YYYY-MM-DD>/<HH-MM-SS>.m4a".
  timestamp: { from: "path"; pattern: string };
  enabled?: boolean;
}

/** A file discovered in a source, ready for the engine. `id` is the stable dedup key; `size`
 *  comes from stat (works on dataless iCloud files, so enumeration downloads nothing). */
export interface Candidate {
  id: string; // `<sourceName>/<relpath>`
  srcPath: string; // absolute path to the source file
  size: number;
  basename: string; // murmur basename, e.g. meeting-2026-04-22_21-55-30
  storage: Storage;
}

/** Build a murmur basename from a path that matches a 6-group (Y M D H Mi S) timestamp regex.
 *  Returns null if the pattern doesn't match or yields a malformed stamp. Pure — unit-tested. */
export function basenameFromRelpath(relpath: string, pattern: string): string | null {
  let m: RegExpExecArray | null;
  try {
    m = new RegExp(pattern).exec(relpath);
  } catch {
    return null; // a bad pattern in config shouldn't crash the run
  }
  if (!m || m.length < 7) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const base = `meeting-${y}-${mo}-${d}_${hh}-${mm}-${ss}`;
  return parseStamp(base) ? base : null; // validate the assembled stamp is well-formed
}

/** The raw `sources` array from murmur.toml's `[[sources]]` (Bun parses TOML tables into plain
 *  objects, matching the FolderSource shape). No murmur.toml or no [[sources]] → import is simply
 *  unconfigured (no sources). */
function readRawSources(cfg: Config): Array<Partial<FolderSource>> {
  const toml = readMurmurToml(cfg.repoDir);
  const raw = (toml as { sources?: unknown } | null)?.sources;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    log.warn("import", `murmur.toml: "sources" is not an array of tables`);
    return [];
  }
  return raw as Array<Partial<FolderSource>>;
}

/** Read and validate the configured sources (murmur.toml `[[sources]]`). Returns enabled sources
 *  only; a malformed entry is logged and skipped rather than fatal. */
export function loadSources(cfg: Config): FolderSource[] {
  const out: FolderSource[] = [];
  for (const s of readRawSources(cfg)) {
    if (s.enabled === false) continue;
    if (s.type !== "folder") {
      log.warn("import", `source "${s.name ?? "?"}": unknown type "${s.type}" — skipped`);
      continue;
    }
    if (!s.name || !s.root || !s.glob || !s.timestamp?.pattern) {
      log.warn("import", `source "${s.name ?? "?"}": missing name/root/glob/timestamp — skipped`);
      continue;
    }
    out.push({
      name: s.name,
      type: "folder",
      root: expandHome(s.root),
      glob: s.glob,
      storage: s.storage === "icloud" ? "icloud" : "none",
      timestamp: { from: "path", pattern: s.timestamp.pattern },
    });
  }
  return out;
}

/** List the candidate recordings in a source. Stats each file (no download) for its size and
 *  derives the murmur basename from its path; files whose path carries no parseable timestamp
 *  are logged and skipped. */
export async function enumerate(src: FolderSource): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (!existsSync(src.root)) {
    log.warn("import", `source "${src.name}": root not found: ${src.root}`);
    return out;
  }
  for await (const rel of new Bun.Glob(src.glob).scan({ cwd: src.root, onlyFiles: true })) {
    const base = basenameFromRelpath(rel, src.timestamp.pattern);
    if (!base) {
      log.warn("import", `source "${src.name}": no timestamp in "${rel}" — skipped`);
      continue;
    }
    const srcPath = join(src.root, rel);
    let size: number;
    try {
      size = statSync(srcPath).size;
    } catch {
      continue; // vanished between scan and stat
    }
    out.push({ id: `${src.name}/${rel}`, srcPath, size, basename: base, storage: src.storage });
  }
  return out;
}
