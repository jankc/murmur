// Folder-based locate / resolveWav / move — the folder-as-state lifecycle, against a throwaway
// temp $MEETINGS_BASE. A recording is a folder named by its basename holding recording.<ext>.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaths } from "./paths.ts";
import { locate, resolveWav, move, recordingFileIn } from "./recordings.ts";
import type { Config } from "./config.ts";

let base: string;
let cfg: Config;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "murmur-rec-"));
  cfg = { paths: buildPaths(base) } as unknown as Config;
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Create a recording folder <lifecycleDir>/<name>/recording.<ext> and return the folder dir. */
async function makeRecording(lifecycleDir: string, name: string, ext = ".flac"): Promise<string> {
  const folder = join(lifecycleDir, name);
  mkdirSync(folder, { recursive: true });
  await Bun.write(join(folder, `recording${ext}`), "audio-bytes");
  return folder;
}

const STAMP = "meeting-2026-06-18_10-00-00"; // parses to month 2026-06

describe("locate", () => {
  test("finds a recording folder in inbox", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("finds a recording folder in failed", async () => {
    const folder = await makeRecording(cfg.paths.failedDir, STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("finds a recording folder in processed/<YYYY-MM>", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    expect(await locate(cfg, STAMP)).toBe(folder);
  });

  test("returns null when the recording does not exist", async () => {
    expect(await locate(cfg, "meeting-nope")).toBeNull();
  });
});

describe("recordingFileIn / resolveWav", () => {
  test("recordingFileIn preserves the original extension", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP, ".m4a");
    expect(await recordingFileIn(folder)).toBe(join(folder, "recording.m4a"));
  });

  test("resolveWav resolves a bare basename to the in-folder recording file", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    expect(await resolveWav(cfg, STAMP)).toBe(join(folder, "recording.flac"));
  });

  test("resolveWav returns an existing absolute path as-is", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    const abs = join(folder, "recording.flac");
    expect(await resolveWav(cfg, abs)).toBe(abs);
  });

  test("resolveWav returns null for an unknown basename", async () => {
    expect(await resolveWav(cfg, "meeting-nope")).toBeNull();
  });
});

describe("move", () => {
  test("moves the whole folder inbox → processed/<YYYY-MM>", async () => {
    await makeRecording(cfg.paths.inboxDir, STAMP);
    const dest = await move(cfg, STAMP, "processed");
    expect(dest).toBe(join(cfg.paths.processedDir, "2026-06", STAMP));
    expect(existsSync(join(dest!, "recording.flac"))).toBe(true);
    expect(existsSync(join(cfg.paths.inboxDir, STAMP))).toBe(false); // source gone
  });

  test("moves sibling artifacts with the folder (single rename)", async () => {
    const folder = await makeRecording(cfg.paths.inboxDir, STAMP);
    await Bun.write(join(folder, "transcript.txt"), "hello");
    await Bun.write(join(folder, "summary.md"), "# x");
    const dest = await move(cfg, STAMP, "processed");
    expect(existsSync(join(dest!, "transcript.txt"))).toBe(true);
    expect(existsSync(join(dest!, "summary.md"))).toBe(true);
  });

  test("is idempotent in the terminal home (no-op, no error)", async () => {
    const folder = await makeRecording(join(cfg.paths.processedDir, "2026-06"), STAMP);
    const dest = await move(cfg, STAMP, "processed");
    expect(dest).toBe(folder); // src === dest → returned unchanged
    expect(existsSync(join(folder, "recording.flac"))).toBe(true);
  });

  test("moves to failed", async () => {
    await makeRecording(cfg.paths.inboxDir, STAMP);
    const dest = await move(cfg, STAMP, "failed");
    expect(dest).toBe(join(cfg.paths.failedDir, STAMP));
    expect(existsSync(join(dest!, "recording.flac"))).toBe(true);
  });

  test("returns null when there's nothing to move", async () => {
    expect(await move(cfg, "meeting-nope", "processed")).toBeNull();
  });
});
