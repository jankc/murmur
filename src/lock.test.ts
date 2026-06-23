// Tests for the shared interprocess PID lock. Each test gets a throwaway temp dir and drives
// acquire/release directly against a lock path — no Config needed (the helper takes a bare path).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock, releasePidLock } from "./lock.ts";

describe("acquirePidLock", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murmur-lock-"));
    lock = join(dir, "state", "import.lock"); // nested → exercises the mkdir of the parent
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquires on a fresh path, creating the parent dir and recording our pid", () => {
    expect(acquirePidLock(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  test("a live holder blocks a second acquire", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(lock, String(process.pid)); // our own pid — definitely alive
    expect(acquirePidLock(lock)).toBe(false);
  });

  test("a stale lock (dead/garbage pid) is reclaimed", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(lock, "0"); // not a real pid → stale
    expect(acquirePidLock(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });

  test("an empty lock file (holder crashed mid-create) is reclaimed", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(lock, ""); // readPid → 0 → stale
    expect(acquirePidLock(lock)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  });
});

describe("releasePidLock", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murmur-lock-"));
    lock = join(dir, "import.lock");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes a lock we own", () => {
    expect(acquirePidLock(lock)).toBe(true);
    releasePidLock(lock);
    expect(existsSync(lock)).toBe(false);
  });

  test("leaves a lock owned by someone else (reclaimed-as-stale guard)", () => {
    writeFileSync(lock, "999999"); // a different pid — not ours
    releasePidLock(lock);
    expect(existsSync(lock)).toBe(true); // must not delete the new holder's lock
  });

  test("is a no-op when there is no lock", () => {
    expect(() => releasePidLock(lock)).not.toThrow();
  });
});
