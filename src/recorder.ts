// Recording: spawn ffmpeg directly against the Aggregate Device (mic + system audio),
// downmixed to mono 16 kHz PCM. Replaces the old record-meeting.sh / stop-meeting.sh.
// State lives in the same files those scripts used (recording.pid, current-recording.txt,
// recording-started-at.txt) so isRecording() works regardless of who started it.
//
// This is the seam the future meeting-app auto-record module plugs into.
import { existsSync, readFileSync, openSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

// Tuned for the specific Aggregate Device channel layout (mic on c0/c1, system on c2).
const PAN_FILTER = "pan=mono|c0=0.35*c0+0.35*c1+0.7*c2,alimiter";

export interface Recorder {
  isRecording(): boolean;
  currentFile(): string | null;
  start(): Promise<{ ok: boolean; message: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
}

export class FfmpegRecorder implements Recorder {
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
    return readFileSync(f, "utf8").trim() || null;
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.isRecording()) return { ok: false, message: "already recording" };

    const ts = stamp(new Date());
    const outFile = join(this.cfg.paths.recordingsDir, `meeting-${ts}.wav`);
    const logFile = join(this.cfg.paths.logsDir, `meeting-${ts}.log`);
    mkdirSync(this.cfg.paths.recordingsDir, { recursive: true });
    mkdirSync(this.cfg.paths.logsDir, { recursive: true });

    const args = [
      "-f", "avfoundation",
      "-i", `:${this.cfg.recordDeviceIndex}`,
      "-filter_complex", PAN_FILTER,
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      "-t", String(this.cfg.maxDurationSeconds),
      outFile,
    ];

    const logFd = openSync(logFile, "a");
    const proc = Bun.spawn(["ffmpeg", ...args], {
      cwd: this.cfg.meetingsBase,
      env: { ...process.env, PATH: this.cfg.childPath },
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
    });
    proc.unref(); // let our process exit without waiting for / killing ffmpeg

    writeFileSync(this.cfg.paths.recordingPid, String(proc.pid));
    writeFileSync(this.cfg.paths.currentRecordingTxt, outFile);
    writeFileSync(join(this.cfg.meetingsBase, "recording-started-at.txt"), new Date().toString());
    notify("Meeting recording started");
    log.info("recorder", `recording (pid ${proc.pid}, device :${this.cfg.recordDeviceIndex}) → ${outFile}`);
    return { ok: true, message: `recording started (${outFile})` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const pidFile = this.cfg.paths.recordingPid;
    if (!this.isRecording()) {
      rmSync(pidFile, { force: true }); // clean up a stale pid file if present
      return { ok: false, message: "not recording" };
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGINT"); // SIGINT lets ffmpeg finalize the .wav cleanly
    } catch (err) {
      log.warn("recorder", `kill ${pid} failed: ${String(err)}`);
    }
    rmSync(pidFile, { force: true });
    rmSync(join(this.cfg.meetingsBase, "recording-started-at.txt"), { force: true });
    notify("Meeting recording stopped");
    log.info("recorder", `stopped recording (pid ${pid})`);
    return { ok: true, message: "recording stopped" };
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function notify(message: string): void {
  try {
    Bun.spawn(["osascript", "-e", `display notification "${message}" with title "Recording" sound name "Glass"`], {
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    /* notifications are best-effort */
  }
}
