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
