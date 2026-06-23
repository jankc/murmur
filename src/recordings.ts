// Recording lifecycle: a recording's FOLDER is its state. This module is the single place that
// knows where a recording's folder currently lives and how it moves between lifecycle dirs:
//   .partial → inbox → processed/<YYYY-MM>   (success)
//                    → failed                 (non-retryable failure)
// The folder (named by basename) holds every artifact (recording.<ext>, transcript.txt, …) and
// moves as one unit. Reused by the worker, the inline CLI path, the control API, and the
// archiver — so the folder-as-state rules live in exactly one file.
import { statSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { basename as pathBasename, dirname, isAbsolute, join } from "node:path";
import type { Config } from "./config.ts";
import { ARTIFACTS, KNOWN_AUDIO_EXTS, stripAudioExt } from "./paths.ts";
import { monthOf } from "./stamp.ts";
import { log } from "./log.ts";

/** True if `p` exists and is a directory (sync stat — cheap, used inside the async locate glob). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Locate a recording's FOLDER by bare basename, wherever it currently sits in its lifecycle
 *  (inbox → failed → processed/<month>). Returns the folder dir or null. */
export async function locate(cfg: Config, base: string): Promise<string | null> {
  for (const dir of [cfg.paths.inboxDir, cfg.paths.failedDir]) {
    const folder = join(dir, base);
    if (isDir(folder)) return folder;
  }
  // processed/ is partitioned by month — glob for the <base>/ folder. The dir may not exist yet
  // (a fresh base, or `murmur import` before the daemon's first run) — treat that as "not there".
  try {
    const glob = new Bun.Glob(`*/${base}`);
    for await (const rel of glob.scan({ cwd: cfg.paths.processedDir, onlyFiles: false })) {
      const folder = join(cfg.paths.processedDir, rel);
      if (isDir(folder)) return folder;
    }
  } catch {
    /* processed/ absent → not found */
  }
  return null;
}

/** The recording audio file (`recording.<ext>`) inside a folder, or null. Imports keep their
 *  original extension, so probe each known ext (case-sensitive, lowercase — see paths.ts). */
export async function recordingFileIn(folder: string): Promise<string | null> {
  for (const ext of KNOWN_AUDIO_EXTS) {
    const p = join(folder, ARTIFACTS.recording(ext));
    if (await Bun.file(p).exists()) return p;
  }
  return null;
}

/** Resolve an /enqueue or CLI argument (absolute path, cwd-relative path, or bare basename) to an
 *  existing recording file. An absolute/cwd path is returned as-is if it exists; otherwise the
 *  argument is treated as a basename and resolved to the `recording.<ext>` inside its located
 *  folder. Returns the path or null if not found. */
export async function resolveWav(cfg: Config, input: string): Promise<string | null> {
  if (isAbsolute(input)) return (await Bun.file(input).exists()) ? input : null;
  const cwd = join(process.cwd(), input);
  if (await Bun.file(cwd).exists()) return cwd;
  const folder = await locate(cfg, stripAudioExt(pathBasename(input)));
  return folder ? recordingFileIn(folder) : null;
}

/** Move a recording's whole FOLDER to its terminal lifecycle dir (location = state). Atomic
 *  (a single directory rename) within one filesystem, with a copy+unlink fallback on EXDEV.
 *  Best-effort: a move failure is logged but never turns a successful job into a failed one.
 *  Idempotent — a no-op when the folder is already in its terminal home. Returns the destination
 *  folder, or null if there was nothing to move. */
export async function move(cfg: Config, base: string, to: "processed" | "failed"): Promise<string | null> {
  const src = await locate(cfg, base);
  if (!src) return null; // already moved, or recorded elsewhere
  const dest =
    to === "processed"
      ? join(cfg.paths.processedDir, monthOf(base, statSync(src).mtime), base)
      : join(cfg.paths.failedDir, base);
  if (src === dest) return dest; // already in its terminal home
  try {
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(src, dest); // atomic within the same filesystem
    } catch (err) {
      // Cross-device rename (MEETINGS_BASE spanning filesystems): fall back to a recursive
      // copy + remove. Rare — the lifecycle dirs all live under recordingsDir (one fs).
      if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
      await cp(src, dest, { recursive: true });
      await rm(src, { recursive: true, force: true });
    }
    log.info("recordings", `moved ${base} → ${to}`);
    return dest;
  } catch (err) {
    log.warn("recordings", `could not move ${base} → ${to}: ${String(err)}`);
    return null;
  }
}
