// Recording: spawn capture process(es) for the configured backend, producing a mono
// 16 kHz PCM WAV in recordings/.partial/ (NOT the watched inbox/) so an in-progress
// recording never triggers the watcher. The finished .wav is moved into inbox/ by stop(),
// or by finalizeOrphans() if the recording ended on its own (MAX cap) or the host crashed.
//
// Two backends (RECORD_BACKEND):
//   ownscribe — one ownscribe-audio process captures system audio (ScreenCaptureKit) + the
//               mic and, on stop, merges them host-time-aligned. No output routing, so the
//               macOS volume keys keep working. Writes 24 kHz mono float; finalize transcodes
//               it to the pipeline's 16 kHz mono s16le.
//   ffmpeg    — one ffmpeg captures an avfoundation device (e.g. a BlackHole Aggregate
//               Device) through the pan filter, writing <base>.wav directly.
//
// All recording state lives in state/recording.json so isRecording()/currentFile() work
// regardless of who started it (CLI or daemon) and a recording can span >1 process. Capture
// processes are detached (unref) so they outlive a short-lived `murmur record` invocation.
import { existsSync, readFileSync, writeFileSync, openSync, mkdirSync, rmSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./config.ts";
import { notify } from "./notify.ts";
import { sleep } from "./util.ts";
import { log } from "./log.ts";

export interface Recorder {
  isRecording(): boolean;
  currentFile(): string | null;
  start(): Promise<{ ok: boolean; message: string }>;
  stop(): Promise<{ ok: boolean; message: string }>;
  finalizeOrphans(): Promise<string | null>;
}

interface RecordingPart {
  pid: number;
  file: string;
}
interface RecordingState {
  backend: "ffmpeg" | "ownscribe";
  base: string;
  startedAt: number;
  outWav: string; // final mono 16 kHz wav in .partial/ (after transcode, for ownscribe)
  parts: RecordingPart[];
}

export class MeetingRecorder implements Recorder {
  constructor(private cfg: Config) {}

  isRecording(): boolean {
    const st = this.readState();
    return !!st && st.parts.some((p) => alive(p.pid));
  }

  currentFile(): string | null {
    return this.readState()?.outWav ?? null;
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.isRecording()) return { ok: false, message: "already recording" };
    await this.finalizeOrphans(); // clear any crashed/stale recording first

    const ts = stamp(new Date());
    const base = `meeting-${ts}`;
    const outWav = join(this.cfg.paths.partialDir, `${base}.wav`);
    for (const d of [this.cfg.paths.partialDir, this.cfg.paths.inboxDir, this.cfg.paths.logsDir, this.cfg.paths.stateDir]) {
      mkdirSync(d, { recursive: true });
    }

    let state: RecordingState;
    try {
      state =
        this.cfg.recordBackend === "ownscribe" ? this.startOwnscribe(base, outWav)
        : this.startFfmpeg(base, outWav);
    } catch (err) {
      return { ok: false, message: `could not start recording: ${String(err)}` };
    }
    this.writeState(state);
    notify(this.cfg, "Meeting recording started");
    log.info("recorder", `recording [${state.backend}] → ${outWav}`);
    return { ok: true, message: `recording started (${outWav})` };
  }

  /** ffmpeg backend: one ffmpeg captures the avfoundation device through the pan filter. */
  private startFfmpeg(base: string, outWav: string): RecordingState {
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      ["ffmpeg", "-f", "avfoundation", "-i", `:${this.cfg.recordDeviceIndex}`, "-filter_complex", this.cfg.panFilter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", String(this.cfg.maxDurationSeconds), outWav],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ffmpeg failed to start");
    return { backend: "ffmpeg", base, startedAt: Date.now(), outWav, parts: [{ pid: proc.pid, file: outWav }] };
  }

  /** ownscribe backend: one ownscribe-audio process captures system (ScreenCaptureKit) + mic
   *  (AVFAudio) and, on stop, merges them host-time-aligned into one WAV. No output routing,
   *  so volume keys keep working. It writes a 24 kHz mono float WAV; finalize transcodes it to
   *  the 16 kHz mono s16le the pipeline expects. */
  private startOwnscribe(base: string, outWav: string): RecordingState {
    if (!existsSync(this.cfg.ownscribeBin)) {
      throw new Error(`ownscribe-audio not found at ${this.cfg.ownscribeBin} — build it (see README → Recording backends)`);
    }
    const raw = join(this.cfg.paths.partialDir, `${base}.oa.wav`); // ownscribe's merged output (24 kHz float)
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      [this.cfg.ownscribeBin, "capture", "-o", raw, "--mic", "--capture-mode-all"],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ownscribe-audio failed to start");
    return { backend: "ownscribe", base, startedAt: Date.now(), outWav, parts: [{ pid: proc.pid, file: raw }] };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const st = this.readState();
    if (!st) {
      await this.finalizeOrphans(); // rescue a partial whose capture already exited
      return { ok: false, message: "not recording" };
    }
    // SIGINT lets ffmpeg finalize its WAV; ownscribe-audio merges its two tracks on SIGINT,
    // which can take a few seconds — so wait generously (we break the instant it exits; only
    // a truly hung process hits the cap).
    for (const p of st.parts) {
      try { process.kill(p.pid, "SIGINT"); } catch {}
    }
    for (let i = 0; i < 600 && st.parts.some((p) => alive(p.pid)); i++) await sleep(100); // ~60s cap
    for (const p of st.parts) if (alive(p.pid)) { try { process.kill(p.pid, "SIGKILL"); } catch {} }

    const moved = await this.finalizeState(st);
    this.clearState();
    notify(this.cfg, "Meeting recording stopped");
    log.info("recorder", `stopped recording [${st.backend}]`);

    let message = moved ? `recording stopped → ${moved}` : "recording stopped (no audio captured)";
    // Both backends produce a single merged track → check the final file's level.
    if (moved) {
      const peak = await measurePeakDb(this.cfg, moved);
      if (peak !== null && peak <= this.cfg.silenceDb) {
        const w = `⚠️ recording looks silent (peak ${peak} dBFS) — check audio routing / mic`;
        log.warn("recorder", w);
        notify(this.cfg, "Recording looks silent — check audio routing");
        message += `\n${w}`;
      }
    }
    return { ok: true, message };
  }

  /** Move recordings that ended without an explicit stop into inbox/. No-op while a
   *  recording is genuinely live; auto-stops one that exceeded MAX_DURATION; recovers a
   *  crashed recording (all capture pids dead) by finalizing whatever was captured. */
  async finalizeOrphans(): Promise<string | null> {
    const st = this.readState();
    if (st) {
      if (st.parts.some((p) => alive(p.pid))) {
        if (Date.now() - st.startedAt > this.cfg.maxDurationSeconds * 1000) {
          log.info("recorder", `recording ${st.base} hit max duration — auto-stopping`);
          return (await this.stop()).ok ? join(this.cfg.paths.inboxDir, `${st.base}.wav`) : null;
        }
        return null; // in progress
      }
      log.info("recorder", `recovering interrupted recording ${st.base}`);
      const moved = await this.finalizeState(st);
      this.clearState();
      return moved;
    }
    // No active recording: move any legacy stray <base>.wav left in .partial/ (defensive).
    return this.moveStrayPartial();
  }

  /** Produce st.outWav (transcoding ownscribe's merged track if needed), then move it to
   *  inbox/. Returns the inbox path, or null if nothing usable was captured. */
  private async finalizeState(st: RecordingState): Promise<string | null> {
    if (st.backend === "ownscribe" && !(await this.transcodeOwnscribe(st))) {
      const raw = st.parts[0]?.file;
      // Transcode failed — never delete a non-empty merged capture, or the only copy of the
      // meeting is lost on a transient ffmpeg hiccup. Only clean up when there's no audio.
      if (raw && existsSync(raw) && statSync(raw).size > 0) {
        log.error("recorder", `${st.base}: transcode failed — kept raw capture ${raw}; recover with: ffmpeg -i "${raw}" -ac 1 -ar 16000 -c:a pcm_s16le "<out>.wav"`);
      } else {
        this.cleanupTemps(st);
      }
      return null;
    }
    if (!existsSync(st.outWav) || statSync(st.outWav).size === 0) {
      log.warn("recorder", `${st.base}: no audio captured`);
      this.cleanupTemps(st);
      return null;
    }
    const dest = join(this.cfg.paths.inboxDir, basename(st.outWav));
    try {
      mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
      renameSync(st.outWav, dest);
      log.info("recorder", `finalized → inbox/${basename(dest)}`);
    } catch (err) {
      if (existsSync(st.outWav)) log.warn("recorder", `could not finalize ${st.base}: ${String(err)}`);
      return null;
    }
    this.cleanupTemps(st);
    return dest;
  }

  /** Transcode ownscribe-audio's merged 24 kHz mono float WAV to the 16 kHz mono s16le the
   *  pipeline expects. Reports the level (the merge already synced system + mic). */
  private async transcodeOwnscribe(st: RecordingState): Promise<boolean> {
    const raw = st.parts[0]?.file;
    if (!raw || !existsSync(raw) || statSync(raw).size === 0) {
      log.warn("recorder", `${st.base}: no audio captured`);
      return false;
    }
    const proc = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", raw, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", st.outWav],
      { env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      log.error("recorder", `transcode failed for ${st.base}: ${(await new Response(proc.stderr).text()).slice(-400)}`);
      return false;
    }
    return true;
  }

  private moveStrayPartial(): string | null {
    const dir = this.cfg.paths.partialDir;
    if (!existsSync(dir)) return null;
    let last: string | null = null;
    for (const name of readdirSync(dir)) {
      // Only a complete final recording (meeting-<stamp>.wav) — never the backend's temp
      // tracks (.oa.wav, *.tmp.wav).
      if (!/^meeting-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.wav$/.test(name)) continue;
      const src = join(dir, name);
      try {
        if (statSync(src).size === 0) continue;
        const dest = join(this.cfg.paths.inboxDir, name);
        mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
        renameSync(src, dest);
        log.info("recorder", `finalized stray recording → inbox/${name}`);
        last = dest;
      } catch (err) {
        if (existsSync(src)) log.warn("recorder", `could not finalize ${name}: ${String(err)}`);
      }
    }
    return last;
  }

  private cleanupTemps(st: RecordingState): void {
    for (const p of st.parts) {
      if (p.file === st.outWav) continue; // ffmpeg backend wrote straight to outWav (already moved)
      try { if (existsSync(p.file)) unlinkSync(p.file); } catch {}
      // ownscribe-audio's own temp tracks, in case it died before cleaning them up itself.
      if (st.backend === "ownscribe") {
        for (const suffix of [".sys.tmp.wav", ".mic.tmp.wav"]) {
          try { if (existsSync(p.file + suffix)) unlinkSync(p.file + suffix); } catch {}
        }
      }
    }
  }

  private readState(): RecordingState | null {
    const f = this.cfg.paths.recordingState;
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as RecordingState;
    } catch {
      return null;
    }
  }

  private writeState(st: RecordingState): void {
    writeFileSync(this.cfg.paths.recordingState, JSON.stringify(st, null, 2));
  }

  private clearState(): void {
    rmSync(this.cfg.paths.recordingState, { force: true });
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Peak volume in dBFS via ffmpeg volumedetect, or null if unreadable. */
export async function measurePeakDb(cfg: Config, file: string): Promise<number | null> {
  try {
    if (!existsSync(file)) return null;
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
      { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const m = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
