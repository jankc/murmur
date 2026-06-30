// Single source of truth for every filesystem path the daemon touches.
// All derived from $MEETINGS_BASE. Each recording is a FOLDER named by its basename; the folder
// moves through lifecycle dirs to encode state, and holds every artifact for that recording:
//   recordings/.partial/<base>/  — in-progress staging (NOT watched), folder-renamed to inbox when done
//   recordings/inbox/<base>/      — complete/pending (watcher watches only here)
//   recordings/processed/<YYYY-MM>/<base>/ — done (moved here after summarize+archive succeed)
//   recordings/failed/<base>/     — a non-retryable failure (moved here so it doesn't retry-loop)
// Inside a recording folder the artifacts are role-named (see ARTIFACTS): recording.<ext>,
// transcript.txt, summary.md, asr.log. paths.ts stays PURE (no fs) — resolving WHERE a folder
// currently lives needs fs probing, which lives in recordings.ts.
import { dirname, join } from "node:path";

// murmur's OWN recordings are written as FLAC: lossless (identical ASR accuracy) at ~half the size
// of 16 kHz mono s16le WAV. But the pipeline (whisper + pyannote, both ffmpeg-backed) is format-
// agnostic, so inbox/ accepts any of these common audio formats — `murmur import` and hand-dropped
// files keep their original container (re-encoding an already-compressed m4a/mp3 to FLAC just
// bloats it). Route extension logic through isRecordingFile()/stripAudioExt(), not a hardcoded ext.
export const CANONICAL_AUDIO_EXT = ".flac"; // what murmur's OWN captures are written as
export const KNOWN_AUDIO_EXTS = [".flac", ".wav", ".m4a", ".m4b", ".mp3", ".aac", ".ogg", ".opus", ".aiff", ".aif", ".caf"] as const;

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

// Role-named artifacts INSIDE a recording folder. Files are named by role (not basename), so a
// recording's audio/transcript/summary/log travel together as one folder. `recording(ext)` keeps
// the original container extension — FLAC for murmur's own captures, m4a/mp3/… for imports.
export const ARTIFACTS = {
  recording: (ext: string) => `recording${ext}`,
  transcript: "transcript.txt",
  summary: "summary.md",
  asrLog: "asr.log",
  // Optional free-form user context (who SPEAKER_NN is, the topic, acronyms). Written by the CLI's
  // --context flag and injected by summarize() into the summary prompt only. Absent for most.
  context: "context.md",
} as const;

/** Absolute path of a recording's folder within a given lifecycle dir (inbox/processed-month/failed). */
export function recordingFolder(lifecycleDir: string, base: string): string {
  return join(lifecycleDir, base);
}

/** In-folder artifact paths derived from a recording file — `dirname(recordingFile)` IS the
 *  recording's folder. The pipeline already holds the recording path (job.wavPath / a resolved
 *  path), so it derives transcript/summary/log siblings without any fs probing. */
export function artifactsFor(recordingFile: string): {
  folder: string;
  transcript: string;
  summary: string;
  asrLog: string;
} {
  const folder = dirname(recordingFile);
  return {
    folder,
    transcript: join(folder, ARTIFACTS.transcript),
    summary: join(folder, ARTIFACTS.summary),
    asrLog: join(folder, ARTIFACTS.asrLog),
  };
}

export interface Paths {
  base: string;
  recordingsDir: string; // parent of .partial/inbox/processed/failed
  partialDir: string;
  inboxDir: string;
  processedDir: string;
  failedDir: string;
  // Scratch for `murmur import` (copy external sources here, then atomic-rename the folder
  // into inbox/). Deliberately NOT .partial/ — that folder is the recorder's, and a half-
  // written file there could collide with finalize/recovery. Same filesystem as inbox/ so the
  // directory rename is atomic.
  importTmpDir: string;
  logsDir: string;
  stateDir: string;
  // Active-recording state (one JSON; may track >1 capture process — see recorder.ts).
  recordingState: string;
  // Meeting auto-detection flag (mur003): "a meeting is live and unrecorded" — written by the
  // daemon's meeting watcher, read by SwiftBar/status, cleared on mic-off / record / stop.
  meetingFile: string;
  // Daemon state files.
  queueFile: string;
  pauseFile: string;
  currentFile: string;
  lockFile: string;
  importLock: string; // single-run lock so a hand-run `murmur import` can't race the scheduled one
  importLedger: string; // `murmur import` dedup cache (id → {size, basename, importedAt})
  failureLog: string;
  // There's deliberately no per-recording path builder here: a recording's folder can live under
  // inbox/processed-month/failed (resolved via recordings.ts locate()/move()), and its in-folder
  // artifacts are derived from the recording file via artifactsFor() / ARTIFACTS — keeping this
  // layer pure (no fs).
}

export function buildPaths(base: string): Paths {
  const recordingsDir = join(base, "recordings");
  const partialDir = join(recordingsDir, ".partial");
  const inboxDir = join(recordingsDir, "inbox");
  const processedDir = join(recordingsDir, "processed");
  const failedDir = join(recordingsDir, "failed");
  const importTmpDir = join(recordingsDir, ".import-tmp");
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
    logsDir,
    stateDir,
    recordingState: join(stateDir, "recording.json"),
    meetingFile: join(stateDir, "meeting.json"),
    queueFile: join(stateDir, "queue.json"),
    pauseFile: join(stateDir, "pause.json"),
    currentFile: join(stateDir, "current.json"),
    lockFile: join(stateDir, "daemon.lock"),
    importLock: join(stateDir, "import.lock"),
    importLedger: join(stateDir, "import-ledger.json"),
    failureLog: join(logsDir, "process-failures.log"),
  });
}
