// Recording lifecycle: a recording's folder IS its state. This module is the single
// place that knows where a recording currently lives and how it moves between folders:
//   .partial → inbox → processed/<YYYY-MM>   (success)
//                    → failed                 (non-retryable failure)
// Reused by the worker, the inline CLI path, the control API, and the archiver — so the
// folder-as-state rules live in exactly one file.
import { statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { basename as pathBasename, dirname, isAbsolute, join } from "node:path";
import type { Config } from "./config.ts";
import { monthOf } from "./stamp.ts";
import { log } from "./log.ts";

/** Locate a recording by bare basename, wherever it currently sits in its lifecycle
 *  (inbox → failed → processed/<month>). Returns the existing path or null. */
export async function locate(cfg: Config, base: string): Promise<string | null> {
  const inbox = cfg.paths.inboxWav(base);
  if (await Bun.file(inbox).exists()) return inbox;
  const failed = cfg.paths.failedWav(base);
  if (await Bun.file(failed).exists()) return failed;
  // processed/ is partitioned by month — glob for the basename. The dir may not exist yet
  // (e.g. a fresh base, or `murmur import` before the daemon's first run) — that's "not there".
  try {
    const glob = new Bun.Glob(`**/${base}.wav`);
    for await (const rel of glob.scan({ cwd: cfg.paths.processedDir })) {
      return join(cfg.paths.processedDir, rel);
    }
  } catch {
    /* processed/ absent → not found */
  }
  return null;
}

/** Resolve an /enqueue or CLI argument (absolute path, cwd-relative path, or bare
 *  basename) to an existing .wav path. Returns the path or null if not found. */
export async function resolveWav(cfg: Config, input: string): Promise<string | null> {
  if (isAbsolute(input)) return (await Bun.file(input).exists()) ? input : null;
  const cwd = join(process.cwd(), input);
  if (await Bun.file(cwd).exists()) return cwd;
  return locate(cfg, pathBasename(input, ".wav"));
}

/** Move a recording to its terminal lifecycle folder (location = state). Best-effort:
 *  a move failure is logged but never turns a successful job into a failed one.
 *  Returns the destination path, or null if there was nothing to move. */
export async function move(cfg: Config, base: string, to: "processed" | "failed"): Promise<string | null> {
  const src = await locate(cfg, base);
  if (!src) return null; // already moved, or recorded elsewhere
  const dest =
    to === "processed"
      ? cfg.paths.processedWav(base, monthOf(base, statSync(src).mtime))
      : cfg.paths.failedWav(base);
  if (src === dest) return dest; // already in its terminal home
  try {
    await mkdir(dirname(dest), { recursive: true });
    await rename(src, dest); // atomic within the same filesystem
    log.info("recordings", `moved ${base} → ${to}`);
    return dest;
  } catch (err) {
    log.warn("recordings", `could not move ${base} → ${to}: ${String(err)}`);
    return null;
  }
}
