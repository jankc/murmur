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
  void reconcile(cfg, onStable);

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(cfg.paths.inboxDir, { persistent: true }, (_event, fname) => {
    if (!fname) return;
    // The immediate child of inbox/ is the recording FOLDER. fs.watch may hand us the folder
    // name directly, or a path inside it — either way the first segment is the folder. Skip
    // dotfiles / staging leftovers (a stray .tmp etc. is never a recording folder).
    const top = fname.toString().split("/")[0];
    if (!top || top.startsWith(".")) return;
    const folder = join(cfg.paths.inboxDir, top);
    const existing = pending.get(folder);
    if (existing) clearTimeout(existing);
    pending.set(
      folder,
      setTimeout(() => void debounceStable(folder, pending, onStable), 1000),
    );
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
async function reconcile(cfg: Config, onStable: (wav: string) => void): Promise<void> {
  try {
    const entries = await readdir(cfg.paths.inboxDir, { withFileTypes: true });
    const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
    let found = 0;
    for (const e of folders) {
      const rec = await recordingFileIn(join(cfg.paths.inboxDir, e.name));
      if (rec) {
        onStable(rec);
        found++;
      }
    }
    if (found) log.info("watcher", `reconcile: ${found} recording(s) in inbox`);
  } catch (err) {
    log.warn("watcher", `reconcile scan failed: ${String(err)}`);
  }
}
