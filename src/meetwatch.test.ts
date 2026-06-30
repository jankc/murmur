// Tests for the pure meeting-detection policy: parsing watch-mic output, classifying a mic-on edge
// against the allow/ignore lists, and the non-timing nudge guards. No subprocess/notify — these are
// the decision functions the MeetingWatcher orchestrates.
import { test, expect, describe } from "bun:test";
import { parseWatchLine, isMeetingEdge, shouldNudge } from "./meetwatch.ts";

const ALLOW = ["com.microsoft.teams2", "com.tinyspeck.slackmacgap", "us.zoom.xos"];
const VOICEINK = "com.prakashjoshipax.VoiceInk";

describe("parseWatchLine", () => {
  test("parses `mic on` with a comma-separated owner list", () => {
    expect(parseWatchLine("mic on com.microsoft.teams2,com.foo")).toEqual({
      kind: "on",
      owners: ["com.microsoft.teams2", "com.foo"],
    });
  });

  test("parses `mic on` with no owners (unknown owner → empty list)", () => {
    expect(parseWatchLine("mic on")).toEqual({ kind: "on", owners: [] });
  });

  test("trims whitespace around the marker and each owner", () => {
    expect(parseWatchLine("  mic on  com.a , com.b ")).toEqual({ kind: "on", owners: ["com.a", "com.b"] });
  });

  test("parses `mic off`", () => {
    expect(parseWatchLine("mic off")).toEqual({ kind: "off" });
  });

  test("returns null for unrelated lines (stderr noise / blanks)", () => {
    expect(parseWatchLine("")).toBeNull();
    expect(parseWatchLine("starting up")).toBeNull();
  });
});

describe("isMeetingEdge", () => {
  test("an allowlisted mic owner is a meeting", () => {
    expect(isMeetingEdge(["com.microsoft.teams2"], ALLOW, [])).toBe(true);
  });

  test("a helper sub-process of an allowlisted app counts (Teams opens the mic as .modulehost)", () => {
    expect(isMeetingEdge(["com.microsoft.teams2.modulehost"], ALLOW, [])).toBe(true);
  });

  test("the dot boundary prevents a lookalike id from matching", () => {
    expect(isMeetingEdge(["com.microsoft.teams2x"], ALLOW, [])).toBe(false);
  });

  test("a dictation app holding the mic (meeting app merely running, not owning) is NOT a meeting", () => {
    // VoiceInk owns the mic; Teams may be running but does not appear as a mic owner.
    expect(isMeetingEdge([VOICEINK], ALLOW, [])).toBe(false);
  });

  test("the ignore-list hard-vetoes even when an allowlisted app also holds the mic", () => {
    expect(isMeetingEdge([VOICEINK, "com.microsoft.teams2"], ALLOW, [VOICEINK])).toBe(false);
  });

  test("unknown / empty owners fail closed (no meeting)", () => {
    expect(isMeetingEdge([], ALLOW, [])).toBe(false);
    expect(isMeetingEdge(["com.unknown.app"], ALLOW, [])).toBe(false);
  });
});

describe("shouldNudge", () => {
  const base = { isRecording: false, armed: true, now: 1_000_000, lastStopAt: 0, cooldownMs: 30_000 };

  test("nudges when idle, armed, and outside any cooldown", () => {
    expect(shouldNudge(base)).toBe(true);
  });

  test("never nudges while already recording", () => {
    expect(shouldNudge({ ...base, isRecording: true })).toBe(false);
  });

  test("never nudges when disarmed (already nudged this call)", () => {
    expect(shouldNudge({ ...base, armed: false })).toBe(false);
  });

  test("suppresses a nudge within the post-stop cooldown", () => {
    expect(shouldNudge({ ...base, lastStopAt: base.now - 5_000 })).toBe(false); // 5s after stop, cooldown 30s
  });

  test("allows a nudge once the cooldown has elapsed", () => {
    expect(shouldNudge({ ...base, lastStopAt: base.now - 31_000 })).toBe(true);
  });
});
