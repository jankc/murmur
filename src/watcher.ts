// Watches recordings/inbox/ for new recording FOLDERS. Each recording is a folder named by its
// basename containing recording.<ext>. Our producers publish atomically (folder-rename into
// inbox/), so a folder appearing here is complete by construction — but macOS fs.watch (FSEvents)
// is coarse and can coalesce/miss events, so we still (a) debounce + wait for the inner
// recording.<ext> to stabilize (defensive cover for a hand-dropped folder written incrementally),
// and (b) do a reconcile scan on boot to catch folders created while the daemon was down.
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { recordingFileIn } from "./recordings.ts";
import { sleep } from "./util.ts";
import { log } from "./log.ts";

export interface WatcherHandle {
  close(): void;
}

export function startWatcher(cfg: Config, onStable: (wav: string) => void): WatcherHandle {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Debounce a folder, then verify its recording.<ext> is size-stable before enqueuing. Shared by
  // the live watch AND the boot reconcile, so neither path can enqueue a still-being-written file.
  const schedule = (folder: string) => {
    const existing = pending.get(folder);
    if (existing) clearTimeout(existing);
    pending.set(folder, setTimeout(() => void debounceStable(folder, pending, onStable), 1000));
  };

  void reconcile(cfg, schedule);

  // recursive: a hand-dropped folder may be created first and its recording.<ext> written later;
  // recursive watching delivers that inner-file event (as "<base>/recording.<ext>"), so a slow
  // copy re-arms the debounce instead of being missed. Our own producers publish atomically (whole
  // folder renamed in), so for them the folder is complete on the first event regardless.
  const watcher = watch(cfg.paths.inboxDir, { persistent: true, recursive: true }, (_event, fname) => {
    if (!fname) return;
    // The first path segment under inbox/ is the recording FOLDER (fs.watch may hand us the folder
    // name or a path inside it). Skip dotfiles / staging leftovers (never a recording folder).
    const top = fname.toString().split("/")[0];
    if (!top || top.startsWith(".")) return;
    schedule(join(cfg.paths.inboxDir, top));
  });
  log.info("watcher", `watching ${cfg.paths.inboxDir}`);
  return { close: () => watcher.close() };
}

async function debounceStable(
  folder: string,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  onStable: (wav: string) => void,
): Promise<void> {
  let prev = -1;
  let misses = 0;
  let rec: string | null = null;
  for (;;) {
    rec = await recordingFileIn(folder);
    if (!rec) {
      // No recording.<ext> in the folder yet. For an atomic publish it's there on the first
      // poll; give a hand-dropped folder a bounded grace for the file to land, then drop it
      // (a non-recording folder, or one removed before it stabilized).
      if (++misses > 15) {
        pending.delete(folder);
        return;
      }
      await sleep(2000);
      continue;
    }
    const size = Bun.file(rec).size;
    if (size > 0 && size === prev) break; // producer done writing
    prev = size;
    await sleep(2000);
  }
  pending.delete(folder);
  log.info("watcher", `stable: ${rec}`);
  onStable(rec);
}

// On boot, scan only inbox/ for recording folders — processed/ recordings are done by definition
// (the folder IS the state), so they're never re-examined. This is the whole point of the move
// model, and it rebuilds the work-list (incl. after a layout migration) from the actual inbox.
// Each folder goes through the same `schedule` (debounce + size-stability) as a live event, so a
// folder still being copied when the daemon boots is not enqueued until it stops growing.
async function reconcile(cfg: Config, schedule: (folder: string) => void): Promise<void> {
  try {
    const entries = await readdir(cfg.paths.inboxDir, { withFileTypes: true });
    const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    let found = 0;
    for (const e of folders) {
      const folder = join(cfg.paths.inboxDir, e.name);
      if (await recordingFileIn(folder)) {
        schedule(folder);
        found++;
      }
    }
    if (found) log.info("watcher", `reconcile: ${found} recording(s) in inbox`);
  } catch (err) {
    log.warn("watcher", `reconcile scan failed: ${String(err)}`);
  }
}
