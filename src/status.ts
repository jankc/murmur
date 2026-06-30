// One shared shape + builder for "what is murmur doing right now", so the daemon's
// GET /status, the CLI's offline `status`, and the SwiftBar renderer can't drift.
import { readdirSync } from "node:fs";
import type { Config } from "./config.ts";
import type { Recorder } from "./recorder.ts";
import { MeetingRecorder } from "./recorder.ts";
import { PauseStore, readCurrent, readMeetingDetected, type PauseMode, type CurrentJob, type MeetingState } from "./jobstate.ts";
import { readJson } from "./state.ts";
import type { QueueItem } from "./queue.ts";

export interface StatusSnapshot {
  recording: boolean;
  recordingFile: string | null;
  pause: PauseMode;
  queueDepth: number;
  queue: string[]; // basenames
  current: CurrentJob | null;
  failedCount: number; // recordings parked in recordings/failed/
  meeting: MeetingState | null; // a detected, not-yet-recorded meeting (mur003); null when none/stale
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
    failedCount: countFailed(cfg),
    meeting: await readMeetingDetected(cfg),
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

/** Count recording folders parked in recordings/failed/ (awaiting `murmur retry-failed`). */
function countFailed(cfg: Config): number {
  try {
    return readdirSync(cfg.paths.failedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Compact human render of a snapshot — the default for `murmur status`. The daemon's
 *  GET /status returns the raw JSON (also available via `--json`); this is the human view
 *  of the same shape, kept here so the two can't drift. */
export function renderStatus(s: StatusSnapshot & { daemon?: string }): string {
  const lines = [
    `daemon:    ${s.daemon ?? "running"}`,
    `recording: ${s.recording ? s.recordingFile?.split("/").pop() ?? "yes" : "idle"}`,
    `pause:     ${s.pause}`,
    s.current
      ? `current:   ${s.current.basename} (${s.current.stage}, ${fmtElapsed(Date.now() - s.current.startedAt)})`
      : "current:   none",
    `queue:     ${s.queueDepth}${s.queueDepth > 0 ? " — " + s.queue.join(", ") : ""}`,
  ];
  if (s.failedCount > 0) lines.push(`failed:    ${s.failedCount} (run: murmur retry-failed)`);
  if (s.meeting && !s.recording) lines.push(`meeting:   detected${s.meeting.app ? ` (${s.meeting.app})` : ""} — run: murmur record`);
  return lines.join("\n");
}
