// Speaker diarization via pyannote community-1 (pyannote.audio 4), run through a dedicated
// venv's Python (diarize/diarize.py). whisply does the transcription; this produces speaker
// turns and assignSpeakers() merges the two by timestamp — far better turn attribution than
// whisply's inline pyannote 3.1 (which mislabels mid-sentence on a mono meeting mix).
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "../config.ts";
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

/** Run the diarization helper on a wav and return its speaker turns. */
export async function diarizeTurns(cfg: Config, wav: string, signal: AbortSignal): Promise<Turn[]> {
  const script = join(cfg.repoDir, "diarize", "diarize.py");
  if (!existsSync(cfg.diarizePython)) {
    throw new EngineError(`diarize venv python not found at ${cfg.diarizePython} (see README → Diarization)`, 1);
  }
  const args = [script, wav];
  if (cfg.numSpeakers > 0) args.push("--num-speakers", String(cfg.numSpeakers));

  const proc = Bun.spawn([cfg.diarizePython, ...args], {
    cwd: cfg.meetingsBase,
    env: { ...process.env, PATH: cfg.childPath, HF_TOKEN: cfg.hfToken },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
    [stdout, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text().then((s) => { if (s.trim()) log.info("diarize", s.trim().split("\n").at(-1)!); }),
      proc.exited,
    ]);
  } finally {
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
  }

  if (signal.aborted) throw new AbortError("diarize aborted");
  if (code !== 0) throw new EngineError(`diarize exited ${code}`, code, stdout.slice(-1000));
  try {
    const parsed = JSON.parse(stdout) as { turns: Turn[] };
    return Array.isArray(parsed.turns) ? parsed.turns : [];
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new EngineError(`diarize output not JSON: ${stdout.slice(-500)}`, 1);
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
