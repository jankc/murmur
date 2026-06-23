// Watcher folder detection. The deterministic part — the boot reconcile that enumerates inbox/*/
// folders and enqueues the complete ones — is exercised here; the live fs.watch debounce is timing
// dependent and covered by the end-to-end verification instead.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths } from "./paths.ts";
import { startWatcher, type WatcherHandle } from "./watcher.ts";
import { sleep } from "./util.ts";
import type { Config } from "./config.ts";

let base: string;
let cfg: Config;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "murmur-watch-"));
  cfg = { paths: buildPaths(base) } as unknown as Config;
  mkdirSync(cfg.paths.inboxDir, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function makeRecording(name: string, ext = ".flac"): Promise<string> {
  const folder = join(cfg.paths.inboxDir, name);
  mkdirSync(folder, { recursive: true });
  await Bun.write(join(folder, `recording${ext}`), "audio-bytes");
  return join(folder, `recording${ext}`);
}

/** Start the watcher, collect onStable calls until `want` of them arrive (or timeout), then close. */
async function collectReconcile(want: number): Promise<string[]> {
  const seen: string[] = [];
  let handle: WatcherHandle | null = null;
  try {
    handle = startWatcher(cfg, (wav) => seen.push(wav));
    for (let i = 0; i < 80 && seen.length < want; i++) await sleep(25);
  } finally {
    handle?.close();
  }
  return seen.sort();
}

describe("watcher boot reconcile", () => {
  test("enqueues complete recording folders, preserving each extension", async () => {
    const a = await makeRecording("meeting-1");
    const b = await makeRecording("meeting-2", ".m4a");
    expect(await collectReconcile(2)).toEqual([a, b].sort());
  });

  test("ignores a folder with no recording file", async () => {
    mkdirSync(join(cfg.paths.inboxDir, "not-a-recording"), { recursive: true });
    const a = await makeRecording("meeting-1");
    // Give the reconcile time; only the real recording should be enqueued.
    const seen = await collectReconcile(1);
    expect(seen).toEqual([a]);
  });
});
