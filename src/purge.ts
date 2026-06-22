// `murmur purge` — find junk recordings whose transcript is empty or noise (repetitive ASR
// garbage) and, with --apply, delete ALL their artifacts (audio + transcript + summary + vault
// note). Detection is transcript-based and deterministic — no LLM call. Never runs in the
// pipeline; it's an explicit, opt-in cleanup. Dry-run unless apply=true.
import { readdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { wordCount, EMPTY_MARKER, MIN_WORDS } from "./engines/ollama.ts";
import { locate } from "./recordings.ts";
import { parseStamp } from "./stamp.ts";
import { log } from "./log.ts";

export type PurgeReason = "empty" | "noise";

export interface Classification {
  reason: PurgeReason | null; // null = keep
  words: number;
  uniqueRatio: number;
}

// Only apply the diversity test to transcripts long enough that a low ratio is meaningful — a
// short genuine note ("ano. ano. dobře.") shouldn't look like garbage.
const NOISE_MIN_WORDS = 40;
// Real speech (even rambly) sits well above this; ASR loops ("cast cast cast…") sit far below.
const NOISE_RATIO = 0.18;

/** Tokenize the way wordCount does (drop [HH:MM:SS] / [SPEAKER_NN] markup), then strip
 *  punctuation and lowercase so "cast," and "cast" count as one token. */
function tokens(transcript: string): string[] {
  return transcript
    .replace(/\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]/g, "")
    .replace(/\[SPEAKER_\d+\]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Pure, deterministic classifier. `empty` = below the LLM word gate or the summary was marked
 *  empty; `noise` = a long transcript with a tiny unique-word ratio (repetitive ASR garbage). */
export function classifyTranscript(transcript: string, summaryText = ""): Classification {
  const words = wordCount(transcript);
  if (summaryText.includes(EMPTY_MARKER) || words < MIN_WORDS) {
    return { reason: "empty", words, uniqueRatio: 1 };
  }
  const toks = tokens(transcript);
  const uniqueRatio = toks.length ? new Set(toks).size / toks.length : 1;
  if (toks.length >= NOISE_MIN_WORDS && uniqueRatio < NOISE_RATIO) {
    return { reason: "noise", words, uniqueRatio };
  }
  return { reason: null, words, uniqueRatio };
}

export interface PurgeItem {
  base: string;
  reason: PurgeReason;
  words: number;
  uniqueRatio: number;
  files: string[]; // every artifact to remove
}

/** Find the vault note(s) for a recording: the second-precision note this version writes, plus
 *  any legacy minute-precision note (the dedup in archive.ts only matches the former). */
function vaultNotesFor(cfg: Config, base: string): string[] {
  if (!cfg.vaultRoot) return [];
  const when = parseStamp(base);
  if (!when) return [];
  const dir = join(cfg.vaultRoot, cfg.vaultFolder, when.month);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // month folder absent → no note
  }
  const sec = `${when.date} ${when.clock}`; // "2026-06-20 17-58-25"
  const min = `${when.date} ${when.time} `; // legacy "2026-06-20 17-58 " (trailing space)
  return files
    .filter((f) => f.endsWith(".md") && (f.startsWith(sec) || f.startsWith(min)))
    .map((f) => join(dir, f));
}

/** Scan every transcript, classify it, and collect the artifacts of those flagged for purge. */
export async function scanPurge(cfg: Config): Promise<PurgeItem[]> {
  let names: string[];
  try {
    names = readdirSync(cfg.paths.transcriptsDir).filter((f) => f.endsWith(".txt"));
  } catch {
    return [];
  }
  names.sort();
  const items: PurgeItem[] = [];
  for (const f of names) {
    const base = f.slice(0, -4);
    const transcript = await Bun.file(cfg.paths.transcript(base)).text().catch(() => "");
    const summaryPath = cfg.paths.summary(base);
    const summaryText = await Bun.file(summaryPath).text().catch(() => "");
    const c = classifyTranscript(transcript, summaryText);
    if (!c.reason) continue;

    const files: string[] = [];
    const audio = await locate(cfg, base);
    if (audio) files.push(audio);
    files.push(cfg.paths.transcript(base));
    if (await Bun.file(summaryPath).exists()) files.push(summaryPath);
    files.push(...vaultNotesFor(cfg, base));
    items.push({ base, reason: c.reason, words: c.words, uniqueRatio: c.uniqueRatio, files });
  }
  return items;
}

/** Report (dry-run) or delete (apply=true) empty/junk recordings and all their artifacts. */
export async function purge(cfg: Config, apply: boolean): Promise<void> {
  const items = await scanPurge(cfg);
  if (items.length === 0) {
    console.log("purge: nothing to clean — no empty or junk recordings found.");
    return;
  }
  let fileCount = 0;
  for (const it of items) {
    const tag = it.reason === "empty" ? "empty" : `noise (unique-word ratio ${it.uniqueRatio.toFixed(2)})`;
    console.log(`\n${it.base}  —  ${tag}, ${it.words} words`);
    for (const file of it.files) {
      console.log(`  ${apply ? "delete" : "would delete"}: ${file}`);
      fileCount++;
    }
  }
  if (!apply) {
    console.log(`\n${items.length} recording(s), ${fileCount} file(s) flagged. Re-run with --apply to delete.`);
    return;
  }
  let removed = 0;
  for (const it of items) {
    for (const file of it.files) {
      try {
        await unlink(file);
        removed++;
      } catch (err) {
        log.warn("purge", `failed to remove ${file}: ${String(err)}`);
      }
    }
  }
  console.log(`\npurged ${items.length} recording(s); removed ${removed}/${fileCount} file(s).`);
}
