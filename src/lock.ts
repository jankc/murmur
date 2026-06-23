// Atomic interprocess PID lock, shared by the daemon (single-instance) and the import
// scheduler (manual run vs. the launchd tick). Replaces two hand-rolled copies that had
// drifted; this is the single source of truth for "only one of us at a time".
//
// The only portable exclusive primitive POSIX gives us is "create if absent" (linkSync /
// O_EXCL), so:
//   - acquire writes our PID into a temp file, then linkSync()s it into place — the lock
//     springs into existence already holding our PID, so a racing reader can never observe a
//     half-written/empty lock (the old openSync-then-writeSync had that window).
//   - a lock held by a LIVE process is never touched — the caller just backs off.
//   - a stale lock (holder PID dead/garbage) is reclaimed by atomically renaming it aside;
//     if that rename turns out to have grabbed a lock that was recreated live underneath us,
//     we put it back and back off rather than steal it.
//   - release only removes a lock we still own, so a run that was reclaimed as stale can't
//     delete the new holder's lock.
//
// This is correct for the realistic case (a seconds-long run vs. a concurrent start — the
// holder is alive, the contender sees a live PID and skips) and for a single stale lock left
// by a crash. It is NOT a kernel flock: PID reuse can still mask a dead holder as alive (rare
// on a single-user machine; clears with a manual `rm` of the lock), and a three-way reclaim in
// a sub-microsecond window is theoretically possible. A fully race-free lock would need an
// OS-level flock/fcntl, which Bun doesn't expose.
import { mkdirSync, writeFileSync, readFileSync, linkSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** True if `pid` names a live process. EPERM means it exists but isn't ours to signal — still
 *  alive. pid ≤ 0 is never a real process (and process.kill(0,…) would hit our whole group). */
function isAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID recorded in a lock file, or 0 if missing / unreadable / not a positive integer. */
function readPid(lockFile: string): number {
  try {
    const n = Number(readFileSync(lockFile, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The lock file exists. Return true if it was stale and we cleared it (caller should retry the
 *  create), false if a live process holds it (caller should back off). */
function reclaimIfStale(lockFile: string, tmp: string): boolean {
  if (isAlive(readPid(lockFile))) return false; // live holder
  const aside = `${tmp}.stale`;
  try {
    renameSync(lockFile, aside); // atomically take ownership of the file to remove
  } catch {
    return true; // someone else already moved/recreated it — retry the create
  }
  if (isAlive(readPid(aside))) {
    // It was recreated by a live process between our read and our rename — restore it.
    try {
      linkSync(aside, lockFile);
    } catch {
      /* already retaken — nothing to restore */
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true }); // genuinely stale — discarded
  return true;
}

/** Acquire `lockFile`, or return false if a live process already holds it. */
export function acquirePidLock(lockFile: string): boolean {
  mkdirSync(dirname(lockFile), { recursive: true });
  const tmp = `${lockFile}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, lockFile); // atomic create-if-absent; lock now holds our PID
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (!reclaimIfStale(lockFile, tmp)) return false; // live holder, or we backed off
        // reclaimed a stale lock → loop once to create ours
      }
    }
    return false; // lost the reclaim race to another starting process — it runs, we skip
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Release `lockFile`, but only if we still own it. */
export function releasePidLock(lockFile: string): void {
  if (readPid(lockFile) === process.pid) rmSync(lockFile, { force: true });
}
