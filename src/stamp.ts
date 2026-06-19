// Parse the timestamp embedded in a recording basename (meeting-2026-06-18_16-21-05),
// or derive one from a Date. Shared by the vault archiver (note filename/frontmatter)
// and the recordings mover (processed/<YYYY-MM>/ partitioning).
export interface Stamp {
  date: string; // YYYY-MM-DD
  time: string; // HH-MM (filename-safe)
  display: string; // HH:MM (frontmatter)
  month: string; // YYYY-MM (folder)
}

const pad = (n: number) => String(n).padStart(2, "0");

export function parseStamp(base: string): Stamp | null {
  const m = base.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return { date: `${y}-${mo}-${d}`, time: `${hh}-${mm}`, display: `${hh}:${mm}`, month: `${y}-${mo}` };
}

export function stampFromDate(dt: Date): Stamp {
  const y = dt.getFullYear(), mo = pad(dt.getMonth() + 1), d = pad(dt.getDate());
  const hh = pad(dt.getHours()), mm = pad(dt.getMinutes());
  return { date: `${y}-${mo}-${d}`, time: `${hh}-${mm}`, display: `${hh}:${mm}`, month: `${y}-${mo}` };
}

/** Month folder (YYYY-MM) for a recording: from its name, else from a fallback Date. */
export function monthOf(base: string, fallback: Date): string {
  return (parseStamp(base) ?? stampFromDate(fallback)).month;
}
