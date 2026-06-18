// Recording: spawn ffmpeg directly against the Aggregate Device (mic + system audio),
// downmixed to mono 16 kHz PCM. Replaces the old record-meeting.sh / stop-meeting.sh.
// State lives in recording.pid + current-recording.txt so isRecording()/currentFile()
// work regardless of who started the recording; both are cleared the moment a recording
// ends (via clearRecordingState).
//
// ffmpeg writes into recordings/.partial/ (NOT the watched inbox/) so an in-progress
// recording never triggers the watcher or pollutes inbox. The finished .wav is moved
// into inbox/ — by stop(), or by finalizeOrphans() if the recording ended on its own
// (MAX_DURATION cap) or the recorder crashed.
//
// This is the seam the future meeting-app auto-record module plugs into.
import { existsSync, readFileSync, openSync, mkdirSync, rmSync, writeFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { notify } from "./notify.ts";
import { sleep } from "./util.ts";
import { log } from "./log.ts";

// Tuned for the specific Aggregate Device channel layout (mic on c0/c1, system on c2).
const PAN_FILTER = "pan=mono|c0=0.35*c0+0.35*c1+0.7*c2,alimiter";

export interface Recorder {
  isRecording(): boolean;
  currentFile(): string | null;
  start(): Promise<{ ok: boolean; message: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
  finalizeOrphans(): void;
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
    // Record into .partial/ (not watched); moved to inbox/ only when complete.
    const outFile = join(this.cfg.paths.partialDir, `meeting-${ts}.wav`);
    const logFile = join(this.cfg.paths.logsDir, `meeting-${ts}.log`);
    mkdirSync(this.cfg.paths.partialDir, { recursive: true });
    mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
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
    notify(this.cfg, "Meeting recording started");
    log.info("recorder", `recording (pid ${proc.pid}, device :${this.cfg.recordDeviceIndex}) → ${outFile}`);
    return { ok: true, message: `recording started (${outFile})` };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const pidFile = this.cfg.paths.recordingPid;
    if (!this.isRecording()) {
      this.clearRecordingState(); // clear any stale pid/current-recording files
      this.finalizeOrphans(); // rescue a partial whose ffmpeg already exited on its own
      return { ok: false, message: "not recording" };
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGINT"); // SIGINT lets ffmpeg finalize the .wav cleanly
    } catch (err) {
      log.warn("recorder", `kill ${pid} failed: ${String(err)}`);
    }
    // Wait for ffmpeg to actually exit (and thus finish writing the WAV header) before
    // moving the file, so inbox never sees a half-finalized recording. ~5s cap.
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break; // process gone
      }
      await sleep(100);
    }
    this.clearRecordingState();
    const moved = this.finalizeOrphans();
    notify(this.cfg, "Meeting recording stopped");
    log.info("recorder", `stopped recording (pid ${pid})`);
    return { ok: true, message: moved ? `recording stopped → ${moved}` : "recording stopped" };
  }

  /** Remove the recording state files once a recording has truly ended. Idempotent —
   *  safe to call when they're already gone. */
  private clearRecordingState(): void {
    rmSync(this.cfg.paths.recordingPid, { force: true });
    rmSync(this.cfg.paths.currentRecordingTxt, { force: true });
  }

  /** Move any completed-but-unmoved recordings from .partial/ into inbox/. Called by
   *  stop(), and periodically by the daemon to catch recordings that ended without an
   *  explicit stop (MAX_DURATION cap, crash). No-op while a recording is in progress —
   *  the live file is still being written and must not be touched. Returns the last
   *  destination moved, or null. */
  finalizeOrphans(): string | null {
    if (this.isRecording()) return null;
    const dir = this.cfg.paths.partialDir;
    if (!existsSync(dir)) return null;
    let last: string | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".wav")) continue;
      const src = join(dir, name);
      // Guard against a file still being flushed: require a non-zero, stable size.
      let size: number;
      try {
        size = statSync(src).size;
      } catch {
        continue;
      }
      if (size === 0) continue;
      const dest = join(this.cfg.paths.inboxDir, basename(name));
      try {
        mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
        renameSync(src, dest); // atomic within the same filesystem
        log.info("recorder", `finalized recording → inbox/${name}`);
        last = dest;
      } catch (err) {
        // A concurrent finalize (CLI stop + daemon sweep) may have moved it already.
        if (existsSync(src)) log.warn("recorder", `could not finalize ${name}: ${String(err)}`);
      }
    }
    // We finalized an orphan → the recording it belonged to has ended (MAX_DURATION cap
    // or crash, no explicit stop), so retire its now-stale state files too.
    if (last) this.clearRecordingState();
    return last;
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
