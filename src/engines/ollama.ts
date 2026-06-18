// Summarization via Ollama's HTTP API, preserving the existing Czech prompt and
// model (configurable via MODEL_SUMMARY). Preflight Ollama (start the
// app + wait if down), prepend prompts/summary.md, write summaries/<base>.md.
import { basename as pathBasename } from "node:path";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import { AbortError, EngineError, isAbort } from "./errors.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Emitted for genuinely empty/trivial recordings. Detection is done in code (word count)
// rather than left to the model, which over-classifies real rambly speech as "test audio".
// archive.ts skips notes whose summary contains "prázdný nebo testovací".
export const EMPTY_MARKER = "Transcript je prázdný nebo testovací — žádné shrnutí.";
const MIN_WORDS = 25;

// Count real spoken words, ignoring diarization markup ([00:00:01.2], [SPEAKER_00]).
function wordCount(transcript: string): number {
  return transcript
    .replace(/\[\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]/g, "")
    .replace(/\[SPEAKER_\d+\]/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
}

export async function summarize(cfg: Config, transcriptPath: string, signal: AbortSignal): Promise<string> {
  const base = pathBasename(transcriptPath, ".txt");
  const transcript = await Bun.file(transcriptPath).text();

  // Trivially short → mark empty without spending an LLM call (or risking misclassification).
  if (wordCount(transcript) < MIN_WORDS) {
    log.info("ollama", `transcript ${base} below ${MIN_WORDS} words — marking empty (skipping LLM)`);
    const out = cfg.paths.summary(base);
    await Bun.write(out, EMPTY_MARKER + "\n");
    return out;
  }

  await preflight(cfg, signal);

  const prompt = [
    await Bun.file(cfg.promptFile).text(),
    "",
    "--- TRANSCRIPT ---",
    transcript,
    "",
    "--- END ---",
    "",
  ].join("\n");

  log.info("ollama", `summarizing ${base} with ${cfg.modelSummary}`);
  let res: Response;
  try {
    res = await fetch(`${cfg.ollamaHost}/api/generate`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      // temperature 0 = greedy decoding: follows the prompt's rules far more reliably
      // and avoids the random "empty/test" misclassification of real transcripts.
      // (qwen3.6-mlx isn't bit-reproducible on Metal, but it reliably summarizes.)
      body: JSON.stringify({ model: cfg.modelSummary, prompt, stream: false, think: false, options: { temperature: 0 } }),
    });
  } catch (err) {
    if (signal.aborted || isAbort(err)) throw new AbortError("ollama aborted");
    throw new EngineError(`ollama request failed: ${String(err)}`, 1);
  }
  if (!res.ok) {
    throw new EngineError(`ollama HTTP ${res.status}`, res.status, (await res.text()).slice(-2000));
  }
  const { response } = (await res.json()) as { response: string };

  const out = cfg.paths.summary(base);
  await Bun.write(out, response);
  return out;
}

/** Generate a short meeting title from the finished summary (for the vault filename +
 *  frontmatter). Small, fast call; assumes Ollama is already up (summarize ran first). */
export async function generateTitle(cfg: Config, summaryText: string, signal: AbortSignal): Promise<string> {
  const prompt = [
    "Z následujícího shrnutí schůzky vytvoř krátký výstižný název (3–6 slov).",
    "Bez uvozovek, bez data a bez koncové interpunkce. Odpověz POUZE názvem na jednom řádku.",
    "",
    summaryText.slice(0, 4000),
  ].join("\n");
  const res = await fetch(`${cfg.ollamaHost}/api/generate`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: cfg.modelSummary, prompt, stream: false, think: false, options: { temperature: 0 } }),
  });
  if (!res.ok) throw new EngineError(`ollama title HTTP ${res.status}`, res.status);
  const { response } = (await res.json()) as { response: string };
  return response.trim().split("\n")[0]?.trim() ?? "";
}

async function preflight(cfg: Config, signal: AbortSignal): Promise<void> {
  if (await ping(cfg)) return;
  log.info("ollama", "not reachable — launching Ollama.app");
  try {
    await Bun.spawn(["open", "-a", "Ollama"], { env: { ...process.env, PATH: cfg.childPath } }).exited;
  } catch {
    /* `open` may be unavailable in some contexts; fall through to polling */
  }
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new AbortError("ollama preflight aborted");
    if (await ping(cfg)) return;
    await sleep(1000);
  }
  throw new EngineError("ollama not reachable after 60s", 1);
}

function ping(cfg: Config): Promise<boolean> {
  return fetch(`${cfg.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
}
