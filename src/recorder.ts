// Recording: spawn capture process(es) for the configured backend, producing a raw PCM-ish
// WAV in recordings/.partial/ (NOT the watched inbox/) so an in-progress recording never
// triggers the watcher. At finalize the capture is transcoded to the canonical 16 kHz mono
// FLAC and atomically dropped into inbox/ — by stop(), or by finalizeOrphans() if the
// recording ended on its own (MAX cap) or the host crashed.
//
// Why capture WAV but archive FLAC: raw PCM is maximally salvageable if a capture is killed
// mid-stream, whereas a FLAC truncated by SIGKILL can lose its STREAMINFO/last frame. So we
// keep crash recovery on robust PCM and encode FLAC only once the capture is complete.
//
// Two backends (RECORD_BACKEND):
//   ownscribe — one ownscribe-audio process captures system audio (ScreenCaptureKit) + the
//               mic and, on stop, merges them host-time-aligned. No output routing, so the
//               macOS volume keys keep working. Writes 24 kHz mono float; finalize transcodes
//               it to the canonical 16 kHz mono FLAC.
//   ffmpeg    — one ffmpeg captures an avfoundation device (e.g. a BlackHole Aggregate
//               Device) through the pan filter, writing <base>.wav (raw PCM); finalize
//               transcodes it to FLAC.
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
import { transcodeToFlac16k } from "./transcode.ts";

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
  // The raw capture in .partial/ is always parts[0].file (ffmpeg: <base>.wav PCM; ownscribe:
  // <base>.oa.wav 24 kHz float). Finalize transcodes it to inbox/<base>.flac.
  parts: RecordingPart[];
}

export class MeetingRecorder implements Recorder {
  constructor(private cfg: Config) {}

  isRecording(): boolean {
    const st = this.readState();
    return !!st && st.parts.some((p) => alive(p.pid));
  }

  currentFile(): string | null {
    return this.readState()?.parts[0]?.file ?? null;
  }

  async start(): Promise<{ ok: boolean; message: string }> {
    if (this.isRecording()) return { ok: false, message: "already recording" };
    await this.finalizeOrphans(); // clear any crashed/stale recording first

    const ts = stamp(new Date());
    const base = `meeting-${ts}`;
    for (const d of [this.cfg.paths.partialDir, this.cfg.paths.inboxDir, this.cfg.paths.logsDir, this.cfg.paths.stateDir]) {
      mkdirSync(d, { recursive: true });
    }

    let state: RecordingState;
    try {
      state =
        this.cfg.recordBackend === "ownscribe" ? this.startOwnscribe(base)
        : this.startFfmpeg(base);
    } catch (err) {
      return { ok: false, message: `could not start recording: ${String(err)}` };
    }
    this.writeState(state);
    const capture = state.parts[0]!.file;
    notify(this.cfg, "Meeting recording started");
    log.info("recorder", `recording [${state.backend}] → ${capture}`);
    return { ok: true, message: `recording started (${capture})` };
  }

  /** ffmpeg backend: one ffmpeg captures the avfoundation device through the pan filter,
   *  writing raw PCM to .partial/<base>.wav (transcoded to FLAC at finalize). */
  private startFfmpeg(base: string): RecordingState {
    const capture = join(this.cfg.paths.partialDir, `${base}.wav`);
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      ["ffmpeg", "-f", "avfoundation", "-i", `:${this.cfg.recordDeviceIndex}`, "-filter_complex", this.cfg.panFilter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", String(this.cfg.maxDurationSeconds), capture],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ffmpeg failed to start");
    return { backend: "ffmpeg", base, startedAt: Date.now(), parts: [{ pid: proc.pid, file: capture }] };
  }

  /** ownscribe backend: one ownscribe-audio process captures system (ScreenCaptureKit) + mic
   *  (AVFAudio) and, on stop, merges them host-time-aligned into one WAV. No output routing,
   *  so volume keys keep working. It writes a 24 kHz mono float WAV; finalize transcodes it to
   *  the canonical 16 kHz mono FLAC. */
  private startOwnscribe(base: string): RecordingState {
    if (!existsSync(this.cfg.ownscribeBin)) {
      throw new Error(`ownscribe-audio not found at ${this.cfg.ownscribeBin} — build it (see README → Recording backends)`);
    }
    const raw = join(this.cfg.paths.partialDir, `${base}.oa.wav`); // ownscribe's merged output (24 kHz float)
    const logFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const proc = Bun.spawn(
      [this.cfg.ownscribeBin, "capture", "-o", raw, "--mic", "--capture-mode-all",
        "--max-duration", String(this.cfg.maxDurationSeconds)],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: logFd, stderr: logFd },
    );
    proc.unref();
    if (!proc.pid) throw new Error("ownscribe-audio failed to start");
    return { backend: "ownscribe", base, startedAt: Date.now(), parts: [{ pid: proc.pid, file: raw }] };
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
          return (await this.stop()).ok ? this.cfg.paths.inboxWav(st.base) : null;
        }
        return null; // in progress
      }
      log.info("recorder", `recovering interrupted recording ${st.base}`);
      const moved = await this.finalizeState(st);
      this.clearState();
      return moved;
    }
    // No active recording: transcode any stray raw capture left in .partial/ (defensive).
    return this.moveStrayPartial();
  }

  /** Transcode the raw capture (parts[0]) → canonical 16 kHz mono FLAC and atomically move it
   *  into inbox/. Returns the inbox path, or null if nothing usable was captured / encode fails. */
  private async finalizeState(st: RecordingState): Promise<string | null> {
    const capture = st.parts[0]?.file;
    if (!capture || !existsSync(capture) || statSync(capture).size === 0) {
      log.warn("recorder", `${st.base}: no audio captured`);
      this.cleanupTemps(st);
      return null;
    }
    // Encode FLAC into a temp in .partial/ (not the watched inbox/), then atomic-rename — so the
    // watcher never sees a half-written file. Encode runs only once the capture is complete.
    const tmp = join(this.cfg.paths.partialDir, `${st.base}.flac`);
    if (!(await transcodeToFlac16k(this.cfg, capture, tmp))) {
      rmSync(tmp, { force: true });
      // Keep the raw capture — never lose the only copy of the meeting on a transient ffmpeg
      // hiccup. cleanupTemps is intentionally NOT called here.
      log.error("recorder", `${st.base}: transcode failed — kept raw capture ${capture}; recover with: ffmpeg -i "${capture}" -ac 1 -ar 16000 -c:a flac "<out>.flac"`);
      return null;
    }
    const dest = this.cfg.paths.inboxWav(st.base); // canonical .flac
    try {
      mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
      renameSync(tmp, dest);
      log.info("recorder", `finalized → inbox/${basename(dest)}`);
    } catch (err) {
      rmSync(tmp, { force: true });
      log.warn("recorder", `could not finalize ${st.base}: ${String(err)}`);
      return null;
    }
    this.cleanupTemps(st);
    return dest;
  }

  /** Recover a stray raw capture (meeting-<stamp>.wav, PCM) left in .partial/ by a crash:
   *  transcode it to canonical FLAC in inbox/. Never touches the backend temp tracks
   *  (.oa.wav, *.tmp.wav) — only a complete-looking PCM capture. */
  private async moveStrayPartial(): Promise<string | null> {
    const dir = this.cfg.paths.partialDir;
    if (!existsSync(dir)) return null;
    let last: string | null = null;
    for (const name of readdirSync(dir)) {
      if (!/^meeting-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.wav$/.test(name)) continue;
      const src = join(dir, name);
      try {
        if (statSync(src).size === 0) continue;
        const base = basename(name, ".wav");
        const tmp = join(dir, `${base}.flac`);
        if (!(await transcodeToFlac16k(this.cfg, src, tmp))) { rmSync(tmp, { force: true }); continue; }
        const dest = this.cfg.paths.inboxWav(base);
        mkdirSync(this.cfg.paths.inboxDir, { recursive: true });
        renameSync(tmp, dest);
        rmSync(src, { force: true }); // raw PCM consumed
        log.info("recorder", `finalized stray recording → inbox/${basename(dest)}`);
        last = dest;
      } catch (err) {
        if (existsSync(src)) log.warn("recorder", `could not finalize ${name}: ${String(err)}`);
      }
    }
    return last;
  }

  private cleanupTemps(st: RecordingState): void {
    for (const p of st.parts) {
      // The raw capture has been transcoded into inbox/ (or there was no audio) — drop it.
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
