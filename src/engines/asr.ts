// Transcription (+ optional diarization) via one Python helper (asr/asr.py) that runs
// mlx-whisper and pyannote community-1 in a single venv, emitting JSON. murmur keeps the
// orchestration and the (tested) chunk↔turn merge. The helper reads the recording read-only, so
// there's no scratch/rename/locate dance — we just parse stdout and write the transcript and the
// per-job ASR log into the recording's own folder (transcript.txt, asr.log).
import { mkdir, rm } from "node:fs/promises";
import { openSync, closeSync, mkdirSync, writeSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../config.ts";
import type { QueueItem } from "../queue.ts";
import { artifactsFor } from "../paths.ts";
import { probeDurationSeconds } from "../ffprobe.ts";
import { pad } from "../util.ts";
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
  // Every artifact lives in the recording's own folder, derived from the recording file.
  const { folder, transcript: dest, asrLog } = artifactsFor(job.wavPath);
  // Trim leading/trailing near-silence into a temp before ASR (when enabled). This keeps
  // whisper's first-30s language auto-detect on real speech (a silent lead-in otherwise gets
  // mis-detected as English) and avoids it hallucinating over the quiet head/tail. `offset` is
  // how much head was removed, added back below so timestamps stay anchored to the original.
  const trimmed = cfg.trimSilence
    ? await trimSilence(cfg, job.wavPath, job.basename, asrLog, signal)
    : { path: job.wavPath, offset: 0, cleanup: async () => {} };

  try {
    const out = await runAsr(cfg, job.basename, trimmed.path, asrLog, signal, wantDiarize);
    if (trimmed.offset > 0) reanchor(out, trimmed.offset);

    await mkdir(folder, { recursive: true });

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
  } finally {
    await trimmed.cleanup();
  }
}

/** Shift every chunk/turn timestamp by `offset` seconds — re-anchoring a trimmed-audio timeline
 *  back onto the original recording so transcript timestamps match wall-clock. Shifting chunks
 *  and turns together preserves their overlap, so speaker assignment is unaffected. */
function reanchor(out: AsrOutput, offset: number): void {
  for (const c of out.chunks) { c.start += offset; c.end += offset; }
  for (const t of out.turns) { t.start += offset; t.end += offset; }
}

// Require this many continuous seconds of sound before the trim stops — short blips in an
// otherwise-quiet lead-in (breaths, keyboard, a cough) don't prematurely end the head/tail trim.
const TRIM_MIN_SOUND_S = 2;

interface Trimmed {
  path: string; // file ASR should read (trimmed temp, or the original on fallback)
  offset: number; // seconds removed from the head — added back to timestamps via reanchor()
  cleanup: () => Promise<void>;
}

/** Run ffmpeg with stderr appended to the per-job asr log; resolves to its exit code. */
async function ffmpeg(args: string[], cfg: Config, logPath: string, signal: AbortSignal): Promise<number> {
  const logFd = openSync(logPath, "a");
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", "-y", ...args], {
    env: { ...process.env, PATH: cfg.childPath },
    stdin: "ignore",
    stdout: "ignore",
    stderr: logFd,
  });
  const onAbort = () => { try { proc.kill("SIGKILL"); } catch {} };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await proc.exited;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try { closeSync(logFd); } catch {}
  }
}

/** Trim leading + trailing near-silence into a 16 kHz mono temp wav for ASR, returning the head
 *  offset so the caller can re-anchor timestamps. Only the ends are trimmed — internal pauses are
 *  preserved (the `areverse` sandwich), so the timeline (and diarization) stays intact. Any
 *  failure falls back to the original file (offset 0): trimming must never lose a meeting. */
async function trimSilence(cfg: Config, src: string, label: string, logPath: string, signal: AbortSignal): Promise<Trimmed> {
  const noop: Trimmed = { path: src, offset: 0, cleanup: async () => {} };
  mkdirSync(dirname(logPath), { recursive: true });

  const headFilter = `silenceremove=start_periods=1:start_threshold=${cfg.trimThresholdDb}dB:start_duration=${TRIM_MIN_SOUND_S}`;
  const tailFilter = `areverse,${headFilter},areverse`;
  const wav = ["-ar", "16000", "-ac", "1"]; // what whisper/pyannote want anyway
  const stamp = `${label}.${process.pid}`;
  const headTmp = join(tmpdir(), `murmur-trim-${stamp}-head.wav`);
  const finalTmp = join(tmpdir(), `murmur-trim-${stamp}.wav`);
  const rmTmp = (f: string) => rm(f, { force: true }).catch(() => {});
  const abortIfCancelled = () => { if (signal.aborted) throw new AbortError("asr trim aborted"); };

  try {
    const origDur = await probeDurationSeconds(cfg, src);
    if (origDur === null) {
      log.warn("asr", `${label}: trim skipped — could not probe ${src}`);
      return noop;
    }

    // 1. Head-only trim → its duration gives the exact head offset (origDur − headDur). Keeping
    //    this a separate pass is what lets us measure the head cut precisely; the tail pass below
    //    operates on this file, so the offset stays valid.
    if ((await ffmpeg(["-i", src, "-af", headFilter, ...wav, headTmp], cfg, logPath, signal)) !== 0) {
      abortIfCancelled();
      log.warn("asr", `${label}: head trim failed — using untrimmed audio`);
      await rmTmp(headTmp);
      return noop;
    }
    const headDur = await probeDurationSeconds(cfg, headTmp);
    if (headDur === null) { await rmTmp(headTmp); return noop; }
    const offset = Math.max(0, origDur - headDur);

    // 2. Trailing-silence trim on the head-trimmed file (leaves the head, hence `offset`, intact).
    //    If it fails we still transcribe the head-trimmed audio — the head fix is the important one.
    if ((await ffmpeg(["-i", headTmp, "-af", tailFilter, ...wav, finalTmp], cfg, logPath, signal)) !== 0) {
      abortIfCancelled();
      log.warn("asr", `${label}: tail trim failed — transcribing head-trimmed audio (head +${offset.toFixed(1)}s)`);
      await rmTmp(finalTmp);
      return { path: headTmp, offset, cleanup: () => rmTmp(headTmp) };
    }
    await rmTmp(headTmp);
    const finalDur = await probeDurationSeconds(cfg, finalTmp);
    log.info("asr", `${label}: trimmed silence — head +${offset.toFixed(1)}s, ${origDur.toFixed(0)}s → ${(finalDur ?? 0).toFixed(0)}s`);
    return { path: finalTmp, offset, cleanup: () => rmTmp(finalTmp) };
  } catch (err) {
    await rmTmp(headTmp);
    await rmTmp(finalTmp);
    if (isAbort(err) || signal.aborted) throw err;
    log.warn("asr", `${label}: trim error (${String(err)}) — using untrimmed audio`);
    return noop;
  }
}

/** Spawn the asr helper on a recording and parse its JSON ({language, chunks, turns}). stderr is
 *  streamed to the recording folder's asr.log; stdout is captured. Diarization is requested inline. */
async function runAsr(cfg: Config, label: string, wav: string, logPath: string, signal: AbortSignal, diarize: boolean): Promise<AsrOutput> {
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

  // Stream the helper's stderr (model load + progress + warnings) straight to the recording's
  // own per-job log file (like the recorder does for ffmpeg); stdout is the JSON payload we parse.
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  writeSync(logFd, `\n=== asr ${label}${diarize ? " (diarized)" : ""} ===\n`);

  const proc = Bun.spawn([cfg.pythonBin, ...args], {
    cwd: cfg.meetingsBase,
    env: { ...process.env, PATH: cfg.childPath, HF_TOKEN: cfg.hfToken },
    stdin: "ignore",
    stdout: "pipe",
    stderr: logFd,
  });

  // Wall-clock backstop: kill a wedged helper so it can't stall the queue forever.
  // PROCESS_TIMEOUT_SECONDS (default 2h) is well above any real transcription.
  let timedOut = false;
  const stageTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGKILL"); } catch {}
  }, cfg.processTimeoutSeconds * 1000);

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
    clearTimeout(stageTimer);
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
    try { closeSync(logFd); } catch {}
  }

  if (signal.aborted) throw new AbortError("asr aborted");
  if (timedOut) throw new EngineError(`asr timed out after ${cfg.processTimeoutSeconds}s (see ${logPath})`, 124);
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
