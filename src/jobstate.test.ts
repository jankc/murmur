// Tests for the meeting-detection flag (mur003): set/clear round-trips, and that a flag older than
// the crash-recovery TTL reads as cleared. Uses a temp state file; only cfg.paths.meetingFile is read.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { writeJsonAtomic } from "./state.ts";
import { setMeetingDetected, clearMeetingDetected, readMeetingDetected } from "./jobstate.ts";

let dir: string;
let cfg: Config;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murmur-meeting-"));
  cfg = { paths: { meetingFile: join(dir, "meeting.json") } } as unknown as Config;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("meeting-detected flag", () => {
  test("absent flag reads as null", async () => {
    expect(await readMeetingDetected(cfg)).toBeNull();
  });

  test("set then read returns an active flag carrying the app", async () => {
    await setMeetingDetected(cfg, "com.microsoft.teams2");
    const m = await readMeetingDetected(cfg);
    expect(m?.active).toBe(true);
    expect(m?.app).toBe("com.microsoft.teams2");
    expect(m?.detectedAt).toBeGreaterThan(0);
  });

  test("clear makes it read as null", async () => {
    await setMeetingDetected(cfg, "com.tinyspeck.slackmacgap");
    await clearMeetingDetected(cfg);
    expect(await readMeetingDetected(cfg)).toBeNull();
  });

  test("a stale flag (older than the TTL) reads as null", async () => {
    // Write an active flag detected 3h ago — beyond the 2h crash-recovery TTL.
    await writeJsonAtomic(cfg.paths.meetingFile, { active: true, detectedAt: Date.now() - 3 * 60 * 60 * 1000 });
    expect(await readMeetingDetected(cfg)).toBeNull();
  });
});
