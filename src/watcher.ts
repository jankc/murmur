// Watches recordings/ for new .wav files. macOS fs.watch (FSEvents) is coarse and
// can coalesce/miss events, so we (a) debounce + wait for the file size to stabilize
// (ffmpeg done writing — mirrors the old watch-recordings.sh 2s-stable logic), and
// (b) do a reconcile scan on boot to catch files created while the daemon was down.
import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface WatcherHandle {
  close(): void;
}

export function startWatcher(cfg: Config, onStable: (wav: string) => void): WatcherHandle {
  void reconcile(cfg, onStable);

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(cfg.paths.recordingsDir, { persistent: true }, (_event, fname) => {
    if (!fname || !fname.toString().endsWith(".wav")) return;
    const full = join(cfg.paths.recordingsDir, fname.toString());
    const existing = pending.get(full);
    if (existing) clearTimeout(existing);
    pending.set(
      full,
      setTimeout(() => void debounceStable(full, pending, onStable), 1000),
    );
  });
  log.info("watcher", `watching ${cfg.paths.recordingsDir}`);
  return { close: () => watcher.close() };
}

async function debounceStable(
  path: string,
  pending: Map<string, ReturnType<typeof setTimeout>>,
  onStable: (wav: string) => void,
): Promise<void> {
  let prev = -1;
  for (;;) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      pending.delete(path);
      return; // file removed/renamed away before it stabilized
    }
    const size = file.size;
    if (size > 0 && size === prev) break;
    prev = size;
    await sleep(2000);
  }
  pending.delete(path);
  log.info("watcher", `stable: ${path}`);
  onStable(path);
}

async function reconcile(cfg: Config, onStable: (wav: string) => void): Promise<void> {
  try {
    const entries = await readdir(cfg.paths.recordingsDir);
    const wavs = entries.filter((e) => e.endsWith(".wav"));
    if (wavs.length) log.info("watcher", `reconcile: ${wavs.length} existing recording(s)`);
    for (const e of wavs) onStable(join(cfg.paths.recordingsDir, e));
  } catch (err) {
    log.warn("watcher", `reconcile scan failed: ${String(err)}`);
  }
}
