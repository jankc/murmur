// Single source of truth for every filesystem path the daemon touches.
// All derived from $MEETINGS_BASE. Recordings move through folders to encode state:
//   recordings/.partial/  — in-progress (ffmpeg writes here; NOT watched), moved to inbox when done
//   recordings/inbox/      — complete/pending (watcher watches only here)
//   recordings/processed/<YYYY-MM>/ — done (moved here after summarize+archive succeed)
//   recordings/failed/     — a non-retryable failure (moved here so it doesn't retry-loop)
import { join } from "node:path";

export interface Paths {
  base: string;
  recordingsDir: string; // parent of .partial/inbox/processed/failed
  partialDir: string;
  inboxDir: string;
  processedDir: string;
  failedDir: string;
  transcriptsDir: string;
  summariesDir: string;
  logsDir: string;
  stateDir: string;
  // Active-recording state (one JSON; may track >1 capture process — see recorder.ts).
  recordingState: string;
  // Daemon state files.
  queueFile: string;
  pauseFile: string;
  currentFile: string;
  lockFile: string;
  failureLog: string;
  // Per-recording derived paths.
  partialWav: (basename: string) => string;
  inboxWav: (basename: string) => string;
  processedWav: (basename: string, month: string) => string;
  failedWav: (basename: string) => string;
  transcript: (basename: string) => string;
  summary: (basename: string) => string;
}

export function buildPaths(base: string): Paths {
  const recordingsDir = join(base, "recordings");
  const partialDir = join(recordingsDir, ".partial");
  const inboxDir = join(recordingsDir, "inbox");
  const processedDir = join(recordingsDir, "processed");
  const failedDir = join(recordingsDir, "failed");
  const transcriptsDir = join(base, "transcripts");
  const summariesDir = join(base, "summaries");
  const logsDir = join(base, "logs");
  const stateDir = join(base, "state");

  return Object.freeze({
    base,
    recordingsDir,
    partialDir,
    inboxDir,
    processedDir,
    failedDir,
    transcriptsDir,
    summariesDir,
    logsDir,
    stateDir,
    recordingState: join(stateDir, "recording.json"),
    queueFile: join(stateDir, "queue.json"),
    pauseFile: join(stateDir, "pause.json"),
    currentFile: join(stateDir, "current.json"),
    lockFile: join(stateDir, "daemon.lock"),
    failureLog: join(logsDir, "process-failures.log"),
    partialWav: (b: string) => join(partialDir, `${b}.wav`),
    inboxWav: (b: string) => join(inboxDir, `${b}.wav`),
    processedWav: (b: string, month: string) => join(processedDir, month, `${b}.wav`),
    failedWav: (b: string) => join(failedDir, `${b}.wav`),
    transcript: (b: string) => join(transcriptsDir, `${b}.txt`),
    summary: (b: string) => join(summariesDir, `${b}.md`),
  });
}
