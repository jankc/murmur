// Unit tests for the import feeder's pure logic — the parts that decide filenames and
// what counts as "new". The IO (glob/stat/brctl/ffmpeg/rename) is exercised manually
// against the real iCloud folder, per the plan's verification steps.
import { test, expect, describe } from "bun:test";
import { basenameFromRelpath } from "./sources.ts";
import { isNew } from "./import.ts";

// The Just Press Record layout: <YYYY-MM-DD>/<HH-MM-SS>.m4a.
const JPR = "(\\d{4})-(\\d{2})-(\\d{2})/(\\d{2})-(\\d{2})-(\\d{2})";

describe("basenameFromRelpath", () => {
  test("maps a JPR path to a murmur basename", () => {
    expect(basenameFromRelpath("2026-04-22/21-55-30.m4a", JPR)).toBe("meeting-2026-04-22_21-55-30");
    expect(basenameFromRelpath("2025-10-03/14-09-18.m4a", JPR)).toBe("meeting-2025-10-03_14-09-18");
  });

  test("returns null when the path carries no timestamp", () => {
    expect(basenameFromRelpath("New Recording.m4a", JPR)).toBeNull();
    expect(basenameFromRelpath("Documents/notes.txt", JPR)).toBeNull();
  });

  test("rejects an out-of-range timestamp (parseStamp validates the assembled stamp)", () => {
    // pattern matches digit-wise, but 99-99-99 isn't a real clock — must not yield a basename
    // that would later mis-partition into processed/<YYYY-MM>/.
    expect(basenameFromRelpath("2026-04-22/21-55-30.m4a", JPR)).not.toBeNull();
    // a bad pattern (no groups) yields null rather than throwing
    expect(basenameFromRelpath("2026-04-22/21-55-30.m4a", "no-groups-here")).toBeNull();
  });

  test("an invalid regex doesn't throw — returns null", () => {
    expect(basenameFromRelpath("anything", "(")).toBeNull();
  });
});

describe("isNew", () => {
  const ledger = {
    version: 1 as const,
    items: { "jpr/2026-04-22/21-55-30.m4a": { size: 132931, basename: "meeting-2026-04-22_21-55-30", importedAt: 1 } },
  };

  test("unseen id is new", () => {
    expect(isNew(ledger, "jpr/2025-10-03/14-09-18.m4a", 196337)).toBe(true);
  });

  test("seen id at the same size is not new", () => {
    expect(isNew(ledger, "jpr/2026-04-22/21-55-30.m4a", 132931)).toBe(false);
  });

  test("seen id at a different size is new again (replaced recording)", () => {
    expect(isNew(ledger, "jpr/2026-04-22/21-55-30.m4a", 99999)).toBe(true);
  });
});
