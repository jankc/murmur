// Queue tests: dedup, skip-when-already-summarized, the force override, and the
// concurrent-enqueue race guard. Runs against a throwaway temp $MEETINGS_BASE.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths } from "./paths.ts";
import { Queue } from "./queue.ts";
import type { Config } from "./config.ts";

let base: string;
let cfg: Config;
const wav = (name: string) => join(base, "recordings/inbox", `${name}.wav`);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "murmur-test-"));
  // Queue only touches cfg.paths, so a paths-only Config is enough.
  cfg = { paths: buildPaths(base) } as unknown as Config;
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("Queue.enqueue", () => {
  test("enqueues a new recording", async () => {
    const q = await Queue.load(cfg);
    const item = await q.enqueue(wav("meeting-2026-06-18_10-00-00"));
    expect(item?.basename).toBe("meeting-2026-06-18_10-00-00");
    expect(q.size()).toBe(1);
  });

  test("dedups an already-queued basename", async () => {
    const q = await Queue.load(cfg);
    await q.enqueue(wav("m1"));
    expect(await q.enqueue(wav("m1"))).toBeNull();
    expect(q.size()).toBe(1);
  });

  test("skips when a summary already exists, unless forced", async () => {
    await Bun.write(cfg.paths.summary("done"), "# Title\n\n# Shrnutí\nx");
    const q = await Queue.load(cfg);
    expect(await q.enqueue(wav("done"))).toBeNull();
    expect(q.size()).toBe(0);

    const forced = await q.enqueue(wav("done"), { force: true });
    expect(forced?.basename).toBe("done");
    expect(q.size()).toBe(1);
  });

  test("concurrent enqueue of the same basename pushes only once", async () => {
    const q = await Queue.load(cfg);
    const results = await Promise.all([q.enqueue(wav("dup")), q.enqueue(wav("dup"))]);
    expect(results.filter(Boolean).length).toBe(1);
    expect(q.size()).toBe(1);
  });

  test("persists across reloads", async () => {
    const q1 = await Queue.load(cfg);
    await q1.enqueue(wav("persisted"));
    const q2 = await Queue.load(cfg);
    expect(q2.size()).toBe(1);
    expect(q2.peek()?.basename).toBe("persisted");
  });
});

describe("Queue dequeue / requeue", () => {
  test("commitDequeue removes a job", async () => {
    const q = await Queue.load(cfg);
    await q.enqueue(wav("a"));
    await q.commitDequeue("a");
    expect(q.size()).toBe(0);
  });

  test("requeueFront moves to head and counts the attempt", async () => {
    const q = await Queue.load(cfg);
    await q.enqueue(wav("first"));
    await q.enqueue(wav("second"));
    await q.requeueFront("second", wav("second"));
    expect(q.peek()?.basename).toBe("second");
    expect(q.peek()?.attempts).toBe(1);
    expect(q.size()).toBe(2);
  });
});
