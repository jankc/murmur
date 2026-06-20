// Ensure a source file's bytes are actually on local disk before we read it. iCloud with
// "Optimize Mac Storage" evicts contents, leaving a dataless placeholder: stat reports the
// full logical `size` but `blocks` (512-byte units actually allocated) is 0. `brctl download`
// faults it back in; we then poll until blocks appear. The storage axis is independent of the
// source layout, so any adapter (folder, future voice-memos) reuses this.
import { existsSync, statSync } from "node:fs";
import { sleep } from "./util.ts";
import { log } from "./log.ts";

export type Storage = "icloud" | "none";

/** True once `path` has its contents locally (or already did / isn't an iCloud file).
 *  Returns false on a missing file or a download that didn't materialise within the timeout. */
export async function ensureLocal(
  path: string,
  storage: Storage,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  if (!existsSync(path)) return false;
  if (storage !== "icloud") return true;

  const st = statSync(path);
  if (st.size === 0 || st.blocks > 0) return true; // empty, or already materialised

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 500;
  log.info("materialize", `downloading from iCloud: ${path}`);
  // brctl requests the download asynchronously; we wait for blocks to appear.
  try {
    await Bun.spawn(["brctl", "download", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  } catch (err) {
    log.warn("materialize", `brctl download failed for ${path}: ${String(err)}`);
    // Don't give up — reading the file can also fault it in; keep polling below.
  }
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    if (statSync(path).blocks > 0) return true;
    await sleep(pollMs);
  }
  log.warn("materialize", `timed out waiting for iCloud download: ${path}`);
  return false;
}
