// Single source of truth for every filesystem path the daemon touches.
// All derived from $MEETINGS_BASE so the layout matches the existing bash scripts.
import { join } from "node:path";

export interface Paths {
  base: string;
  recordingsDir: string;
  transcriptsDir: string;
  summariesDir: string;
  logsDir: string;
  stateDir: string;
  scratchRoot: string;
  // Existing recording state files (written by record-meeting.sh / stop-meeting.sh).
  recordingPid: string;
  currentRecordingTxt: string;
  // Daemon state files.
  queueFile: string;
  pauseFile: string;
  currentFile: string;
  lockFile: string;
  failureLog: string;
  // Per-recording derived paths.
  transcript: (basename: string) => string;
  summary: (basename: string) => string;
  scratchDir: (basename: string) => string;
}

export function buildPaths(base: string): Paths {
  const recordingsDir = join(base, "recordings");
  const transcriptsDir = join(base, "transcripts");
  const summariesDir = join(base, "summaries");
  const logsDir = join(base, "logs");
  const stateDir = join(base, "state");
  // whisply scratch lives *inside* transcripts/ but in a dot-dir so it never collides
  // with the flat <base>.txt namespace that summarize.sh + idempotency rely on.
  const scratchRoot = join(transcriptsDir, ".whisply-work");

  return Object.freeze({
    base,
    recordingsDir,
    transcriptsDir,
    summariesDir,
    logsDir,
    stateDir,
    scratchRoot,
    recordingPid: join(base, "recording.pid"),
    currentRecordingTxt: join(base, "current-recording.txt"),
    queueFile: join(stateDir, "queue.json"),
    pauseFile: join(stateDir, "pause.json"),
    currentFile: join(stateDir, "current.json"),
    lockFile: join(stateDir, "daemon.lock"),
    failureLog: join(logsDir, "process-failures.log"),
    transcript: (b: string) => join(transcriptsDir, `${b}.txt`),
    summary: (b: string) => join(summariesDir, `${b}.md`),
    scratchDir: (b: string) => join(scratchRoot, b),
  });
}
