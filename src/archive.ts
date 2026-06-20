// Copy a finished summary into the Obsidian vault, organized by month, with a generated
// title and rich YAML frontmatter:
//   <vaultRoot>/<vaultFolder>/<YYYY-MM>/<YYYY-MM-DD HH-MM> <title>.md
// The originals in $MEETINGS_BASE stay the source of truth; the vault is a derived view.
// No-op when no vault is configured. Idempotent (skips if a file with the same timestamp
// prefix already exists). Re-throws aborts (so the worker requeues); other errors are the
// caller's to log — a vault hiccup must not fail the local job.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { generateTitle, EMPTY_MARKER } from "./engines/ollama.ts";
import { isAbort } from "./engines/errors.ts";
import { parseStamp, stampFromDate } from "./stamp.ts";
import { locate } from "./recordings.ts";
import { CANONICAL_AUDIO_EXT } from "./paths.ts";
import { log } from "./log.ts";

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

  // summaryFile is guaranteed to exist here (early-returned above otherwise).
  const when = parseStamp(base) ?? stampFromDate(new Date(summaryFile.lastModified));
  const monthDir = join(cfg.vaultRoot, cfg.vaultFolder, when.month);
  // Second precision (HH-MM-SS), so two recordings that start in the same minute get
  // distinct note identities — the dedup below must not delete/overwrite an unrelated note.
  const prefix = `${when.date} ${when.clock}`;
  // The summary already opens with an LLM-generated title (see prompts/summary.md), so read
  // it straight from the text — no second model round-trip. Older summaries that predate the
  // title-in-prompt have no leading title and fall back to a dedicated generateTitle() call.
  let title = sanitizeTitle(titleFromSummary(summaryText));
  if (!title) {
    try {
      title = sanitizeTitle(await generateTitle(cfg, summaryText, signal));
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      log.warn("archive", `title generation failed for ${base}: ${String(err)}`);
    }
  }

  // Resolve the actual stored recording once — for the duration and the frontmatter source
  // pointer (a recording murmur produced is .flac; a .wav input is archived as .wav).
  const audioPath = await locate(cfg, base); // inbox during processing, processed/ afterwards
  const sourceName = audioPath ? basename(audioPath) : `${base}${CANONICAL_AUDIO_EXT}`;
  const speakers = await countSpeakers(cfg, base);
  const duration = audioPath ? await durationOf(cfg, audioPath) : null;
  const fm = [
    "---",
    `title: ${yaml(title || prefix)}`,
    `date: ${when.date}`,
    `time: ${yaml(when.display)}`,
    `source: ${yaml(sourceName)}`,
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
  // Replace any prior note for this recording (same timestamp prefix) — its title may have
  // changed on reprocessing — so the vault always reflects the latest summary, no duplicates.
  for (const f of readdirSync(monthDir)) {
    if (f.startsWith(prefix) && f.endsWith(".md") && join(monthDir, f) !== out) {
      try { rmSync(join(monthDir, f)); } catch {}
    }
  }
  await Bun.write(out, fm + summaryText.replace(/^\s+/, ""));
  log.info("archive", `→ ${out}`);
}

// Headings the summary template itself uses — so the first section of a title-less
// (older) summary is never mistaken for the meeting title.
const SECTION_HEADINGS = new Set([
  "Shrnutí", "Hlavní body", "Rozhodnutí", "Úkoly", "Otevřené otázky",
  "Technické poznámky", "Technická rozhodnutí", "Rizika / problémy", "Confidence",
]);

/** Pull the meeting title back out of a summary that opens with `# <title>` (the format
 *  the summary prompt now produces). Returns "" if the first heading is a section heading
 *  (an older, title-less summary) or there's no leading heading at all. */
export function titleFromSummary(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const m = firstLine.match(/^#\s+(.+)$/);
  if (!m) return "";
  const t = m[1]!.trim();
  return SECTION_HEADINGS.has(t) ? "" : t;
}

// Strip characters Obsidian/macOS reject in note names; collapse whitespace; cap length.
export function sanitizeTitle(t: string): string {
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

/** Human duration (H:MM:SS / M:SS) of the stored recording, or null if unknown. FLAC is
 *  compressed (size ≠ length), so probe it with ffprobe; a raw-PCM .wav (mono 16 kHz
 *  s16le, 44-byte header) is exact from file size with no subprocess. */
async function durationOf(cfg: Config, audioPath: string): Promise<string | null> {
  const seconds = audioPath.toLowerCase().endsWith(".wav")
    ? Math.max(0, (Bun.file(audioPath).size - 44) / 32000)
    : await probeDurationSeconds(cfg, audioPath);
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** Container duration in seconds via ffprobe, or null on any failure (duration is then just
 *  omitted from the note — a missing-ffprobe/odd-file case must never fail archiving). */
async function probeDurationSeconds(cfg: Config, file: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
      { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0) return null;
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
