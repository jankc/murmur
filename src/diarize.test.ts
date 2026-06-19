// Tests for the chunk↔turn merge — the deterministic core of community1 diarization.
import { test, expect, describe } from "bun:test";
import { assignSpeakers, type Chunk, type Turn } from "./engines/diarize.ts";

const chunk = (start: number, end: number, text: string): Chunk => ({ start, end, text });
const turn = (start: number, end: number, speaker: string): Turn => ({ start, end, speaker });

describe("assignSpeakers", () => {
  test("assigns each chunk to the max-overlap speaker", () => {
    const chunks = [chunk(0, 2, "hi"), chunk(2, 4, "there")];
    const turns = [turn(0, 2, "SPEAKER_00"), turn(2, 4, "SPEAKER_01")];
    const out = assignSpeakers(chunks, turns);
    expect(out).toContain("[SPEAKER_00] hi");
    expect(out).toContain("[SPEAKER_01] there");
  });

  test("groups consecutive same-speaker chunks into one line", () => {
    const chunks = [chunk(0, 2, "one"), chunk(2, 4, "two"), chunk(4, 6, "three")];
    const turns = [turn(0, 6, "SPEAKER_00")];
    const out = assignSpeakers(chunks, turns).trim();
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("[SPEAKER_00] one two three");
  });

  test("formats the timestamp as HH:MM:SS.mmm from the group's first chunk", () => {
    const out = assignSpeakers([chunk(6.9, 8.4, "x")], [turn(6.9, 8.4, "SPEAKER_00")]);
    expect(out).toContain("[00:00:06.900] [SPEAKER_00] x");
  });

  test("a chunk with no overlapping turn inherits the previous speaker", () => {
    const chunks = [chunk(0, 2, "a"), chunk(2, 4, "b")]; // 2nd chunk overlaps no turn
    const turns = [turn(0, 2, "SPEAKER_01")];
    const out = assignSpeakers(chunks, turns).trim();
    expect(out.split("\n")).toHaveLength(1); // both attributed to SPEAKER_01, grouped
    expect(out).toContain("[SPEAKER_01] a b");
  });

  test("partial overlap picks the dominant speaker", () => {
    // chunk 0–10 overlaps SPEAKER_00 for 2s, SPEAKER_01 for 8s → SPEAKER_01 wins
    const out = assignSpeakers([chunk(0, 10, "hello")], [turn(0, 2, "SPEAKER_00"), turn(2, 10, "SPEAKER_01")]);
    expect(out).toContain("[SPEAKER_01] hello");
  });

  test("skips empty/whitespace chunks and collapses inner whitespace", () => {
    const chunks = [chunk(0, 1, "  hi  "), chunk(1, 2, "   "), chunk(2, 3, "you")];
    const turns = [turn(0, 3, "SPEAKER_00")];
    const out = assignSpeakers(chunks, turns).trim();
    expect(out).toBe("[00:00:00.000] [SPEAKER_00] hi you");
  });

  test("no turns at all → everything falls back to SPEAKER_00", () => {
    const out = assignSpeakers([chunk(0, 2, "alone")], []);
    expect(out).toContain("[SPEAKER_00] alone");
  });
});
