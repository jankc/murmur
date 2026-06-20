// Single source of truth for every filesystem path the daemon touches.
// All derived from $MEETINGS_BASE. Recordings move through folders to encode state:
//   recordings/.partial/  — in-progress (ffmpeg writes here; NOT watched), moved to inbox when done
//   recordings/inbox/      — complete/pending (watcher watches only here)
//   recordings/processed/<YYYY-MM>/ — done (moved here after summarize+archive succeed)
//   recordings/failed/     — a non-retryable failure (moved here so it doesn't retry-loop)
import { join } from "node:path";

// murmur's OWN recordings are written as FLAC: lossless (identical ASR accuracy) at ~half the size
// of 16 kHz mono s16le WAV. But the pipeline (whisper + pyannote, both ffmpeg-backed) is format-
// agnostic, so inbox/ accepts any of these common audio formats — `murmur import` and hand-dropped
// files keep their original container (re-encoding an already-compressed m4a/mp3 to FLAC just
// bloats it). Route extension logic through isRecordingFile()/stripAudioExt(), not a hardcoded ext.
export const CANONICAL_AUDIO_EXT = ".flac"; // what murmur's OWN captures are written as
export const KNOWN_AUDIO_EXTS = [".flac", ".wav", ".m4a", ".mp3", ".aac", ".ogg", ".opus", ".aiff"] as const;

// Matching is case-SENSITIVE (lowercase only). Every recording filename is a lowercase ext, and
// locate() builds lowercase paths/globs — accepting an uppercase ext here would let the watcher
// pick up a file that locate()/move() then can't find on a case-sensitive volume (it would loop
// in inbox, reprocessed on every restart).
/** True if a filename is a recording we should pick up (any supported audio format). */
export function isRecordingFile(name: string): boolean {
  return KNOWN_AUDIO_EXTS.some((e) => name.endsWith(e));
}

/** Strip a recognized recording extension to get the bare basename (no-op if none matches). */
export function stripAudioExt(name: string): string {
  const ext = KNOWN_AUDIO_EXTS.find((e) => name.endsWith(e));
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
  // hold a mix of formats (FLAC captures + imports), so callers must resolve via recordings.ts
  // locate()/move() (which check every known extension) rather than assume one.
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
    // Inbox target for murmur's OWN captures (FLAC). Imported recordings keep their own extension
    // and are resolved (in inbox/failed/processed) by recordings.ts locate(), which checks all.
    inboxWav: (b: string) => join(inboxDir, `${b}${CANONICAL_AUDIO_EXT}`),
    transcript: (b: string) => join(transcriptsDir, `${b}.txt`),
    summary: (b: string) => join(summariesDir, `${b}.md`),
  });
}
