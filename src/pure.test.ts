// Unit tests for the deterministic, dependency-free logic — the helpers most likely to
// regress silently (timestamp parsing drives filenames; wordCount gates the empty-marker
// path that once misclassified real meetings; title parsing is new). No GPU, no network.
import { test, expect, describe } from "bun:test";
import { parseStamp, stampFromDate, monthOf } from "./stamp.ts";
import { truthy, parseNum } from "./util.ts";
import { titleFromSummary, sanitizeTitle } from "./archive.ts";
import { wordCount } from "./engines/ollama.ts";

describe("stamp", () => {
  test("parseStamp extracts the embedded timestamp", () => {
    expect(parseStamp("meeting-2026-06-18_16-21-05")).toEqual({
      date: "2026-06-18",
      time: "16-21",
      display: "16:21",
      month: "2026-06",
    });
  });

  test("parseStamp returns null when there's no timestamp", () => {
    expect(parseStamp("notes-final")).toBeNull();
  });

  test("stampFromDate formats a Date in local time", () => {
    const s = stampFromDate(new Date(2026, 5, 18, 16, 21, 5)); // month is 0-based → June
    expect(s).toEqual({ date: "2026-06-18", time: "16-21", display: "16:21", month: "2026-06" });
  });

  test("monthOf prefers the name, falls back to the date", () => {
    expect(monthOf("meeting-2026-06-18_16-21-05", new Date(2000, 0, 1))).toBe("2026-06");
    expect(monthOf("garbage", new Date(2026, 0, 5))).toBe("2026-01");
  });
});

describe("util", () => {
  test("truthy", () => {
    for (const v of ["1", "true", "TRUE", "True"]) expect(truthy(v)).toBe(true);
    for (const v of ["0", "", "false", "yes", "no"]) expect(truthy(v)).toBe(false);
  });

  test("parseNum falls back on empty / non-numeric, parses valid", () => {
    expect(parseNum("7461", 1)).toBe(7461);
    expect(parseNum("3.5", 1)).toBe(3.5);
    expect(parseNum("", 7200)).toBe(7200); // Number("") is 0 — must NOT leak through
    expect(parseNum("   ", 7200)).toBe(7200);
    expect(parseNum("abc", 5)).toBe(5);
    expect(parseNum("12abc", 5)).toBe(5);
  });
});

describe("titleFromSummary", () => {
  test("extracts a leading title H1", () => {
    expect(titleFromSummary("# Volba databáze\n\n# Shrnutí\nfoo")).toBe("Volba databáze");
  });

  test("skips leading blank lines", () => {
    expect(titleFromSummary("\n\n#   Plán nahrávání\n\ntext")).toBe("Plán nahrávání");
  });

  test("returns '' for an older title-less summary (first heading is a section)", () => {
    expect(titleFromSummary("# Shrnutí\nNěco se stalo.")).toBe("");
  });

  test("returns '' when the first non-empty line isn't a heading", () => {
    expect(titleFromSummary("Plain text\n# Later heading")).toBe("");
    expect(titleFromSummary("")).toBe("");
  });
});

describe("sanitizeTitle", () => {
  test("strips filesystem/Obsidian-unsafe characters and collapses whitespace", () => {
    expect(sanitizeTitle("Foo: bar / baz")).toBe("Foo bar baz");
    expect(sanitizeTitle("Title #1 [draft]")).toBe("Title 1 draft");
    expect(sanitizeTitle("  lots   of   space  ")).toBe("lots of space");
  });

  test("caps length at 80 characters", () => {
    expect(sanitizeTitle("x".repeat(200)).length).toBe(80);
  });
});

describe("wordCount", () => {
  test("ignores diarization + timestamp markup", () => {
    expect(wordCount("[SPEAKER_00] [00:00:01.2] ahoj jak se máš")).toBe(4);
  });

  test("empty / markup-only transcripts count as zero", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("[SPEAKER_01]   \n  ")).toBe(0);
  });

  test("counts plain spoken words", () => {
    expect(wordCount("jedna dvě tři čtyři pět")).toBe(5);
  });
});
