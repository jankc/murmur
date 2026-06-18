// Tiny shared helpers, no dependencies.

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "1" or "true" (case-insensitive) → true; everything else → false. */
export const truthy = (v: string): boolean => v === "1" || v.toLowerCase() === "true";

/** Parse a numeric config string; empty/whitespace or non-finite input → fallback.
 *  (Number("") is 0, so empty is guarded explicitly.) */
export const parseNum = (raw: string, fallback: number): number => {
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
