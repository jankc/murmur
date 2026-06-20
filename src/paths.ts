// Single source of truth for every filesystem path the daemon touches.
// All derived from $MEETINGS_BASE. Recordings move through folders to encode state:
//   recordings/.partial/  — in-progress (ffmpeg writes here; NOT watched), moved to inbox when done
//   recordings/inbox/      — complete/pending (watcher watches only here)
//   recordings/processed/<YYYY-MM>/ — done (moved here after summarize+archive succeed)
//   recordings/failed/     — a non-retryable failure (moved here so it doesn't retry-loop)
import { join } from "node:path";

// Canonical archived audio format. New recordings (recorder + importer) are stored as FLAC:
// lossless (identical ASR accuracy) but ~half the size of the old 16 kHz mono s16le WAV.
// Lookups/filters must still accept legacy `.wav` so the existing back catalogue keeps working
// — route everything through isRecordingFile()/stripAudioExt() rather than hardcoding an ext.
export const CANONICAL_AUDIO_EXT = ".flac"; // what NEW recordings are written as
export const KNOWN_AUDIO_EXTS = [".flac", ".wav"] as const; // recognised when scanning/locating

/** True if a filename is a recording we should pick up (canonical FLAC, or a legacy WAV). */
export function isRecordingFile(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_AUDIO_EXTS.some((e) => lower.endsWith(e));
}

/** Strip a known recording extension to get the bare basename (no-op if none matches). */
export function stripAudioExt(name: string): string {
  const lower = name.toLowerCase();
  const ext = KNOWN_AUDIO_EXTS.find((e) => lower.endsWith(e));
  return ext ? name.slice(0, -ext.length) : name;
}

export interface Paths {
  base: string;
  recordingsDir: string; // parent of .partial/inbox/processed/failed
  partialDir: string;
  inboxDir: string;
  processedDir: string;
  failedDir: string;
  // Scratch for `murmur import` (transcode external sources to FLAC here, then atomic-rename
  // into inbox/). Deliberately NOT .partial/ — that folder is the recorder's, and a half-
  // written file there could collide with finalize/recovery. Same filesystem as inbox/ so the
  // rename is atomic.
  importTmpDir: string;
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
  importLedger: string; // `murmur import` dedup cache (id → {size, basename, importedAt})
  failureLog: string;
  // Per-recording derived paths. There's deliberately no processed/failed builder: those folders
  // hold a mix of canonical FLAC and legacy WAV, so callers must resolve via recordings.ts
  // locate()/move() (which check both extensions) rather than assume one.
  partialWav: (basename: string) => string; // raw PCM capture target (always .wav)
  inboxWav: (basename: string) => string; // canonical artifact target (.flac) for NEW recordings
  transcript: (basename: string) => string;
  summary: (basename: string) => string;
}

export function buildPaths(base: string): Paths {
  const recordingsDir = join(base, "recordings");
  const partialDir = join(recordingsDir, ".partial");
  const inboxDir = join(recordingsDir, "inbox");
  const processedDir = join(recordingsDir, "processed");
  const failedDir = join(recordingsDir, "failed");
  const importTmpDir = join(recordingsDir, ".import-tmp");
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
    importTmpDir,
    transcriptsDir,
    summariesDir,
    logsDir,
    stateDir,
    recordingState: join(stateDir, "recording.json"),
    queueFile: join(stateDir, "queue.json"),
    pauseFile: join(stateDir, "pause.json"),
    currentFile: join(stateDir, "current.json"),
    lockFile: join(stateDir, "daemon.lock"),
    importLedger: join(stateDir, "import-ledger.json"),
    failureLog: join(logsDir, "process-failures.log"),
    // .partial/ holds the raw PCM capture — stays WAV (maximally crash-salvageable); it's
    // transcoded to canonical FLAC at the .partial→inbox boundary, never archived as-is.
    partialWav: (b: string) => join(partialDir, `${b}.wav`),
    // Canonical inbox target (FLAC) for a NEW recording. Lookups for a legacy `.wav` back
    // catalogue (in inbox/failed/processed) live in recordings.ts locate(), which checks both.
    inboxWav: (b: string) => join(inboxDir, `${b}${CANONICAL_AUDIO_EXT}`),
    transcript: (b: string) => join(transcriptsDir, `${b}.txt`),
    summary: (b: string) => join(summariesDir, `${b}.md`),
  });
}
