// Transcription (+ optional diarization) via one Python helper (asr/asr.py) that runs
// mlx-whisper and pyannote community-1 in a single venv, emitting JSON. murmur keeps the
// orchestration and the (tested) chunk↔turn merge. The helper reads the wav read-only, so
// there's no scratch/rename/locate dance — we just parse stdout and write transcripts/<base>.txt.
import { mkdir } from "node:fs/promises";
import { openSync, closeSync, mkdirSync, writeSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { QueueItem } from "../queue.ts";
import { log } from "../log.ts";
import { AbortError, EngineError, isAbort } from "./errors.ts";

export interface Turn {
  start: number;
  end: number;
  speaker: string;
}
export interface Chunk {
  start: number;
  end: number;
  text: string;
}

interface AsrOutput {
  language: string;
  chunks: Chunk[];
  turns: Turn[];
}

export async function transcribe(cfg: Config, job: QueueItem, signal: AbortSignal): Promise<string> {
  const wantDiarize = cfg.diarize && !!cfg.hfToken;
  const out = await runAsr(cfg, job.basename, job.wavPath, signal, wantDiarize);

  const dest = cfg.paths.transcript(job.basename);
  await mkdir(cfg.paths.transcriptsDir, { recursive: true });

  let text: string;
  if (out.chunks.length === 0) {
    // No speech — emit an empty transcript so the summary prompt returns its
    // "prázdný/testovací" one-liner instead of erroring (empty-marker path).
    log.warn("asr", `${job.basename}: no transcript produced (no speech?) — writing empty transcript`);
    text = "";
  } else if (wantDiarize && out.turns.length > 0) {
    text = assignSpeakers(out.chunks, out.turns);
  } else {
    // Diarization off, or it failed (helper returns empty turns) — degrade to plain
    // text rather than losing the meeting.
    if (wantDiarize) log.warn("asr", `${job.basename}: no speaker turns — writing plain transcript`);
    text = out.chunks.map((c) => c.text.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim() + "\n";
  }
  await Bun.write(dest, text);
  return dest;
}

/** Spawn the asr helper on a wav and parse its JSON ({language, chunks, turns}). stderr is
 *  streamed to logs/asr-<base>.log; stdout is captured. Diarization is requested inline. */
async function runAsr(cfg: Config, label: string, wav: string, signal: AbortSignal, diarize: boolean): Promise<AsrOutput> {
  const script = join(cfg.repoDir, "asr", "asr.py");
  if (!existsSync(cfg.pythonBin)) {
    throw new EngineError(`asr venv python not found at ${cfg.pythonBin} (see README → Install)`, 1);
  }
  const args = [script, wav, "--model", cfg.asrModel];
  // Only force a language when explicitly configured; "auto" (default) lets whisper detect
  // it. Forcing the wrong language makes whisper emit nothing for that speech (drops it).
  if (cfg.language && cfg.language !== "auto") args.push("--language", cfg.language);
  if (diarize) {
    args.push("--diarize");
    if (cfg.numSpeakers > 0) args.push("--num-speakers", String(cfg.numSpeakers));
  }
  log.info("asr", `transcribing ${label} (lang=${cfg.language})${diarize ? " (diarized)" : ""}`);

  // Stream the helper's stderr (model load + progress + warnings) straight to a per-job
  // log file (like the recorder does for ffmpeg); stdout is the JSON payload we parse.
  const logPath = join(cfg.paths.logsDir, `asr-${label}.log`);
  mkdirSync(cfg.paths.logsDir, { recursive: true });
  const logFd = openSync(logPath, "a");
  writeSync(logFd, `\n=== asr ${label}${diarize ? " (diarized)" : ""} ===\n`);

  const proc = Bun.spawn([cfg.pythonBin, ...args], {
    cwd: cfg.meetingsBase,
    env: { ...process.env, PATH: cfg.childPath, HF_TOKEN: cfg.hfToken },
    stdin: "ignore",
    stdout: "pipe",
    stderr: logFd,
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try { proc.kill("SIGTERM"); } catch {}
    killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let stdout = "";
  let code: number;
  try {
    [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } finally {
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
    try { closeSync(logFd); } catch {}
  }

  if (signal.aborted) throw new AbortError("asr aborted");
  if (code !== 0) throw new EngineError(`asr exited ${code} (see ${logPath})`, code, stdout.slice(-1000));
  try {
    const parsed = JSON.parse(stdout) as Partial<AsrOutput>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : "",
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
      turns: Array.isArray(parsed.turns) ? parsed.turns : [],
    };
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new EngineError(`asr output not JSON (see ${logPath}): ${stdout.slice(-500)}`, 1);
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function fmtTimestamp(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(whole)}.${pad(ms, 3)}`;
}

/** Speaker whose turn overlaps the chunk most (null if none overlap). */
function speakerFor(chunk: Chunk, turns: Turn[]): string | null {
  let best: string | null = null;
  let bestOverlap = 0;
  for (const t of turns) {
    const overlap = Math.min(chunk.end, t.end) - Math.max(chunk.start, t.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = t.speaker;
    }
  }
  return best;
}

/** Merge transcription chunks with diarization turns into the annotated transcript format
 *  ("[HH:MM:SS.mmm] [SPEAKER_xx] text"), grouping consecutive same-speaker chunks into one
 *  line. Pure + deterministic — unit-tested. A chunk with no overlapping turn inherits the
 *  previous speaker (keeps a continuous turn intact), or SPEAKER_00 at the very start. */
export function assignSpeakers(chunks: Chunk[], turns: Turn[]): string {
  const lines: string[] = [];
  let curSpeaker: string | null = null;
  let curStart = 0;
  let buf: string[] = [];

  const flush = () => {
    if (buf.length && curSpeaker !== null) {
      lines.push(`[${fmtTimestamp(curStart)}] [${curSpeaker}] ${buf.join(" ").replace(/\s+/g, " ").trim()}`);
    }
  };

  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const speaker: string = speakerFor(c, turns) ?? curSpeaker ?? "SPEAKER_00";
    if (speaker !== curSpeaker) {
      flush();
      curSpeaker = speaker;
      curStart = c.start;
      buf = [text];
    } else {
      buf.push(text);
    }
  }
  flush();
  return lines.join("\n") + "\n";
}
