// Pause state and current-job state, both persisted so they survive a daemon restart.
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./state.ts";

export type PauseMode = "none" | "soft" | "hard";

interface PauseState {
  mode: PauseMode;
  since: number | null;
}

export class PauseStore {
  private constructor(private cfg: Config, private state: PauseState) {}

  static async load(cfg: Config): Promise<PauseStore> {
    const state = await readJson<PauseState>(cfg.paths.pauseFile, { mode: "none", since: null });
    return new PauseStore(cfg, state);
  }

  mode(): PauseMode {
    return this.state.mode;
  }

  isPaused(): boolean {
    return this.state.mode !== "none";
  }

  async set(mode: PauseMode): Promise<void> {
    this.state = { mode, since: mode === "none" ? null : Date.now() };
    await writeJsonAtomic(this.cfg.paths.pauseFile, this.state);
  }
}

export interface CurrentJob {
  basename: string;
  stage: "transcribe" | "summarize" | "archive";
  startedAt: number;
}

export async function writeCurrent(cfg: Config, job: CurrentJob): Promise<void> {
  await writeJsonAtomic(cfg.paths.currentFile, job);
}

export async function clearCurrent(cfg: Config): Promise<void> {
  await writeJsonAtomic(cfg.paths.currentFile, {});
}

export async function readCurrent(cfg: Config): Promise<CurrentJob | null> {
  const v = await readJson<Partial<CurrentJob>>(cfg.paths.currentFile, {});
  return v && v.basename && v.stage ? (v as CurrentJob) : null;
}

// Meeting auto-detection flag (mur003): "a meeting is live and not being recorded". Written by the
// daemon's meeting watcher when it nudges, cleared on mic-off / record / stop. Read by SwiftBar +
// status so the menubar can offer a one-click "Start recording".
export interface MeetingState {
  active: boolean;
  detectedAt: number; // epoch ms; 0 when inactive
  app?: string; // bundle id of the meeting app that triggered the nudge (for display)
}

// Crash-recovery bound: if the daemon dies while a meeting is flagged, the watcher can't clear the
// flag, so a reader treats one older than this as cleared. Sized to the max recording cap — a
// "meeting" older than that is moot. Normal teardown (mic-off/record/stop) clears it far sooner.
const MEETING_FLAG_TTL_MS = 2 * 60 * 60 * 1000;

export async function setMeetingDetected(cfg: Config, app?: string): Promise<void> {
  await writeJsonAtomic(cfg.paths.meetingFile, { active: true, detectedAt: Date.now(), app } satisfies MeetingState);
}

export async function clearMeetingDetected(cfg: Config): Promise<void> {
  await writeJsonAtomic(cfg.paths.meetingFile, { active: false, detectedAt: 0 } satisfies MeetingState);
}

/** The current detected-meeting flag, or null when inactive or stale (TTL-expired). */
export async function readMeetingDetected(cfg: Config): Promise<MeetingState | null> {
  const v = await readJson<Partial<MeetingState>>(cfg.paths.meetingFile, {});
  if (!v.active || !v.detectedAt) return null;
  if (Date.now() - v.detectedAt > MEETING_FLAG_TTL_MS) return null; // stale → daemon likely crashed; treat as cleared
  return v as MeetingState;
}
