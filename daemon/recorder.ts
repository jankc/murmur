// Recording control. We deliberately REUSE the existing, finely-tuned bash scripts
// (record-meeting.sh / stop-meeting.sh — the ffmpeg pan filter) rather than
// reimplement ffmpeg here. Recording state is read from the shared recording.pid
// file, so recordings started elsewhere (SwiftBar/Automator) are detected too.
//
// This interface is the seam the future meeting-app auto-record module plugs into.
import { existsSync, readFileSync } from "node:fs";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export interface Recorder {
  isRecording(): boolean;
  currentFile(): string | null;
  start(): Promise<{ ok: boolean; message: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
}

export class ScriptRecorder implements Recorder {
  constructor(private cfg: Config) {}

  isRecording(): boolean {
    const pidFile = this.cfg.paths.recordingPid;
    if (!existsSync(pidFile)) return false;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0); // signal 0 = existence check
      return true;
    } catch {
      return false; // stale pid file (ffmpeg died)
    }
  }

  currentFile(): string | null {
    const f = this.cfg.paths.currentRecordingTxt;
    if (!existsSync(f)) return null;
    const v = readFileSync(f, "utf8").trim();
    return v || null;
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.isRecording()) return { ok: false, message: "already recording" };
    const code = await this.runScript(this.cfg.recordScript, [this.cfg.recordDeviceIndex]);
    const ok = code === 0;
    if (!ok) log.error("recorder", `record-meeting.sh exited ${code}`);
    return { ok, message: ok ? "recording started" : `record script exited ${code}` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    if (!this.isRecording()) return { ok: false, message: "not recording" };
    const code = await this.runScript(this.cfg.stopScript);
    const ok = code === 0;
    if (!ok) log.error("recorder", `stop-meeting.sh exited ${code}`);
    return { ok, message: ok ? "recording stopped" : `stop script exited ${code}` };
  }

  private async runScript(script: string, args: string[] = []): Promise<number> {
    const proc = Bun.spawn(["bash", script, ...args], {
      cwd: this.cfg.repoDir,
      env: { ...process.env, PATH: this.cfg.childPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    return await proc.exited;
  }
}
