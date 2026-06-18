// Copy a finished summary into the Obsidian vault, organized by month, with a generated
// title and rich YAML frontmatter:
//   <vaultRoot>/<vaultFolder>/<YYYY-MM>/<YYYY-MM-DD HH-MM> <title>.md
// The originals in $MEETINGS_BASE stay the source of truth; the vault is a derived view.
// No-op when no vault is configured. Idempotent (skips if a file with the same timestamp
// prefix already exists). Re-throws aborts (so the worker requeues); other errors are the
// caller's to log — a vault hiccup must not fail the local job.
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { generateTitle, EMPTY_MARKER } from "./engines/ollama.ts";
import { isAbort } from "./engines/errors.ts";
import { log } from "./log.ts";

interface Stamp {
  date: string; // YYYY-MM-DD
  time: string; // HH-MM (filename-safe)
  display: string; // HH:MM (frontmatter)
  month: string; // YYYY-MM (folder)
}

export async function archiveSummary(cfg: Config, base: string, signal: AbortSignal): Promise<void> {
  if (!cfg.vaultRoot) return; // archiving disabled
  const summaryPath = cfg.paths.summary(base);
  const summaryFile = Bun.file(summaryPath);
  if (!(await summaryFile.exists())) return;

  const summaryText = await summaryFile.text();
  // Don't clutter the vault with empty/test recordings (summarize() marks these with
  // EMPTY_MARKER). Skip them and the title LLM call. Substring match stays robust if the
  // model ever emits the marker itself rather than our code path writing it.
  if (summaryText.includes(EMPTY_MARKER) || summaryText.toLowerCase().includes("prázdný nebo testovací")) {
    log.info("archive", `skip ${base} — empty/test recording`);
    return;
  }

  const when = parseStamp(base) ?? stampFromMtime(summaryPath);
  const monthDir = join(cfg.vaultRoot, cfg.vaultFolder, when.month);
  const prefix = `${when.date} ${when.time}`;

  if (existsSync(monthDir) && readdirSync(monthDir).some((f) => f.startsWith(prefix) && f.endsWith(".md"))) {
    return; // already archived
  }
  let title = "";
  try {
    title = sanitizeTitle(await generateTitle(cfg, summaryText, signal));
  } catch (err) {
    if (isAbort(err) || signal.aborted) throw err;
    log.warn("archive", `title generation failed for ${base}: ${String(err)}`);
  }

  const speakers = await countSpeakers(cfg, base);
  const duration = await durationOf(cfg, base);
  const fm = [
    "---",
    `title: ${yaml(title || prefix)}`,
    `date: ${when.date}`,
    `time: ${yaml(when.display)}`,
    `source: ${yaml(`${base}.wav`)}`,
    ...(duration ? [`duration: ${yaml(duration)}`] : []),
    ...(speakers ? [`speakers: ${speakers}`] : []),
    "tags: [meeting, murmur]",
    "---",
    "",
    "",
  ].join("\n");

  const fileBase = title ? `${prefix} ${title}` : prefix;
  const out = join(monthDir, `${fileBase}.md`);
  await mkdir(monthDir, { recursive: true });
  await Bun.write(out, fm + summaryText.replace(/^\s+/, ""));
  log.info("archive", `→ ${out}`);
}

// meeting-2026-06-18_16-21-05 → {date, time, display, month}
function parseStamp(base: string): Stamp | null {
  const m = base.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  return { date: `${y}-${mo}-${d}`, time: `${hh}-${mm}`, display: `${hh}:${mm}`, month: `${y}-${mo}` };
}

function stampFromMtime(path: string): Stamp {
  const dt = Bun.file(path).lastModified ? new Date(Bun.file(path).lastModified) : new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const y = dt.getFullYear(), mo = p(dt.getMonth() + 1), d = p(dt.getDate());
  const hh = p(dt.getHours()), mm = p(dt.getMinutes());
  return { date: `${y}-${mo}-${d}`, time: `${hh}-${mm}`, display: `${hh}:${mm}`, month: `${y}-${mo}` };
}

// Strip characters Obsidian/macOS reject in note names; collapse whitespace; cap length.
function sanitizeTitle(t: string): string {
  return t
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

function yaml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function countSpeakers(cfg: Config, base: string): Promise<number> {
  const t = Bun.file(cfg.paths.transcript(base));
  if (!(await t.exists())) return 0;
  return new Set((await t.text()).match(/SPEAKER_\d+/g) ?? []).size;
}

// Recordings are mono 16 kHz s16le PCM, so duration is exact from file size (44-byte header).
async function durationOf(cfg: Config, base: string): Promise<string | null> {
  const f = Bun.file(join(cfg.paths.recordingsDir, `${base}.wav`));
  if (!(await f.exists())) return null;
  const seconds = Math.max(0, (f.size - 44) / 32000);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}
