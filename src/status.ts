// One shared shape + builder for "what is murmur doing right now", so the daemon's
// GET /status, the CLI's offline `status`, and the SwiftBar renderer can't drift.
import type { Config } from "./config.ts";
import type { Recorder } from "./recorder.ts";
import { MeetingRecorder } from "./recorder.ts";
import { PauseStore, readCurrent, type PauseMode, type CurrentJob } from "./jobstate.ts";
import { readJson } from "./state.ts";
import type { QueueItem } from "./queue.ts";

export interface StatusSnapshot {
  recording: boolean;
  recordingFile: string | null;
  pause: PauseMode;
  queueDepth: number;
  queue: string[]; // basenames
  current: CurrentJob | null;
}

export async function statusSnapshot(
  cfg: Config,
  recorder: Recorder,
  pause: PauseStore,
  queueItems: QueueItem[],
): Promise<StatusSnapshot> {
  return {
    recording: recorder.isRecording(),
    recordingFile: recorder.currentFile(),
    pause: pause.mode(),
    queueDepth: queueItems.length,
    queue: queueItems.map((i) => i.basename),
    current: await readCurrent(cfg),
  };
}

/** Build a snapshot purely from on-disk state — no running daemon required. Used by the
 *  CLI and SwiftBar, which talk to the same files the daemon writes. */
export async function offlineSnapshot(cfg: Config): Promise<StatusSnapshot> {
  const recorder = new MeetingRecorder(cfg);
  const pause = await PauseStore.load(cfg);
  const queue = await readJson<{ items: QueueItem[] }>(cfg.paths.queueFile, { items: [] });
  return statusSnapshot(cfg, recorder, pause, queue.items);
}
