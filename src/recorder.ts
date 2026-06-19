// Recording: spawn capture process(es) for the configured backend, producing a mono
// 16 kHz PCM WAV in recordings/.partial/ (NOT the watched inbox/) so an in-progress
// recording never triggers the watcher. The finished .wav is moved into inbox/ by stop(),
// or by finalizeOrphans() if the recording ended on its own (MAX cap) or the host crashed.
//
// Two backends (RECORD_BACKEND):
//   ffmpeg   — one ffmpeg captures an avfoundation device (e.g. a BlackHole Aggregate
//              Device) through the pan filter, writing <base>.wav directly.
//   audiotee — captures the system-audio mix (the other participants) via AudioTee's
//              Core Audio tap AND the microphone via ffmpeg, into two .partial temp files;
//              stop() mixes them into <base>.wav. No BlackHole/aggregate, and it survives a
//              meeting app grabbing the mic (the system tap is independent of the mic).
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
  role: "main" | "system" | "mic";
  pid: number;
  file: string;
}
interface RecordingState {
  backend: "ffmpeg" | "audiotee";
  base: string;
  startedAt: number;
  outWav: string; // final mono wav in .partial/ (after mix, for audiotee)
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
      state = this.cfg.recordBackend === "audiotee" ? this.startAudioTee(base, outWav) : this.startFfmpeg(base, outWav);
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
    return { backend: "ffmpeg", base, startedAt: Date.now(), outWav, parts: [{ role: "main", pid: proc.pid, file: outWav }] };
  }

  /** audiotee backend: system audio via Core Audio tap → raw PCM file, mic via ffmpeg → wav.
   *  stop() mixes the two. Each is an independent detached process. */
  private startAudioTee(base: string, outWav: string): RecordingState {
    if (!existsSync(this.cfg.audioteeBin)) {
      throw new Error(`audiotee not found at ${this.cfg.audioteeBin} — build it (see README → Development)`);
    }
    const systemPcm = join(this.cfg.paths.partialDir, `${base}.system.pcm`);
    const micWav = join(this.cfg.paths.partialDir, `${base}.mic.wav`);

    const tap = Bun.spawn([this.cfg.audioteeBin, "--sample-rate", "16000"], {
      cwd: this.cfg.meetingsBase,
      env: { ...process.env, PATH: this.cfg.childPath },
      stdin: "ignore",
      stdout: openSync(systemPcm, "w"),
      stderr: openSync(join(this.cfg.paths.logsDir, `${base}.audiotee.log`), "a"),
    });
    tap.unref();

    const micLogFd = openSync(join(this.cfg.paths.logsDir, `${base}.log`), "a");
    const mic = Bun.spawn(
      ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-i", `:${this.cfg.micDevice}`,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", String(this.cfg.maxDurationSeconds), micWav],
      { cwd: this.cfg.meetingsBase, env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: micLogFd, stderr: micLogFd },
    );
    mic.unref();

    if (!tap.pid || !mic.pid) throw new Error("audiotee/ffmpeg failed to start");
    return {
      backend: "audiotee",
      base,
      startedAt: Date.now(),
      outWav,
      parts: [{ role: "system", pid: tap.pid, file: systemPcm }, { role: "mic", pid: mic.pid, file: micWav }],
    };
  }

  async stop(): Promise<{ ok: boolean; message: string }> {
    const st = this.readState();
    if (!st) {
      await this.finalizeOrphans(); // rescue a partial whose capture already exited
      return { ok: false, message: "not recording" };
    }
    // SIGINT lets ffmpeg finalize its WAV; audiotee shuts down gracefully on SIGTERM.
    for (const p of st.parts) {
      try { process.kill(p.pid, p.role === "system" ? "SIGTERM" : "SIGINT"); } catch {}
    }
    for (let i = 0; i < 50 && st.parts.some((p) => alive(p.pid)); i++) await sleep(100); // ~5s
    for (const p of st.parts) if (alive(p.pid)) { try { process.kill(p.pid, "SIGKILL"); } catch {} }

    const moved = await this.finalizeState(st);
    this.clearState();
    notify(this.cfg, "Meeting recording stopped");
    log.info("recorder", `stopped recording [${st.backend}]`);

    let message = moved ? `recording stopped → ${moved}` : "recording stopped (no audio captured)";
    // ffmpeg backend is a single mixed track → check the final file. audiotee reports per
    // track during the mix (mic vs system), so it isn't re-checked here.
    if (moved && st.backend === "ffmpeg") {
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

  /** Produce st.outWav (mixing the two audiotee tracks if needed), then move it to inbox/.
   *  Returns the inbox path, or null if nothing usable was captured. */
  private async finalizeState(st: RecordingState): Promise<string | null> {
    if (st.backend === "audiotee" && !(await this.mixAudioTee(st))) {
      this.cleanupTemps(st);
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

  /** Mix the system-audio track and the mic track into st.outWav, reporting each track's
   *  level so a silent mic (e.g. an app holding it) or silent system audio is pinpointed.
   *  Falls back to whichever track has audio if the other is empty. */
  private async mixAudioTee(st: RecordingState): Promise<boolean> {
    const sys = st.parts.find((p) => p.role === "system")?.file;
    const mic = st.parts.find((p) => p.role === "mic")?.file;
    const sysOk = !!sys && existsSync(sys) && statSync(sys).size > 0;
    const micOk = !!mic && existsSync(mic) && statSync(mic).size > 44; // bigger than a bare WAV header

    const sysPeak = sysOk ? await measurePeakDb(this.cfg, sys!, true) : null;
    const micPeak = micOk ? await measurePeakDb(this.cfg, mic!) : null;
    log.info("recorder", `${st.base} track levels — system: ${fmtDb(sysPeak)}, mic: ${fmtDb(micPeak)}`);
    const silent: string[] = [];
    if (sysPeak === null || sysPeak <= this.cfg.silenceDb) silent.push("system (other participants)");
    if (micPeak === null || micPeak <= this.cfg.silenceDb) silent.push("your mic");
    if (silent.length) {
      log.warn("recorder", `${st.base}: silent track(s) — ${silent.join(", ")}`);
      notify(this.cfg, `Silent: ${silent.join(" + ")} — check audio routing`);
    }

    let args: string[];
    if (sysOk && micOk) {
      args = ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", sys!, "-i", mic!, "-filter_complex",
        "[0:a]aformat=sample_rates=16000:channel_layouts=mono[s];[1:a]aformat=sample_rates=16000:channel_layouts=mono[m];[s][m]amix=inputs=2:duration=longest:normalize=0,alimiter[out]",
        "-map", "[out]"];
    } else if (sysOk) {
      args = ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", sys!];
    } else if (micOk) {
      args = ["-i", mic!];
    } else {
      return false; // nothing captured
    }
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-nostats", "-y", ...args, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", st.outWav],
      { env: { ...process.env, PATH: this.cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
      log.error("recorder", `mix failed for ${st.base}: ${(await new Response(proc.stderr).text()).slice(-500)}`);
      return false;
    }
    return true;
  }

  private moveStrayPartial(): string | null {
    const dir = this.cfg.paths.partialDir;
    if (!existsSync(dir)) return null;
    let last: string | null = null;
    for (const name of readdirSync(dir)) {
      // Only the final mixed/recorded wav — never the audiotee temp tracks.
      if (!name.endsWith(".wav") || name.endsWith(".mic.wav")) continue;
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

const fmtDb = (db: number | null): string => (db === null ? "— (empty)" : `${db} dBFS`);

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Peak volume in dBFS via ffmpeg volumedetect, or null if unreadable. Pass rawS16le=true
 *  for a headerless 16 kHz mono s16le file (the AudioTee system track). */
export async function measurePeakDb(cfg: Config, file: string, rawS16le = false): Promise<number | null> {
  try {
    if (!existsSync(file)) return null;
    const input = rawS16le ? ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", file] : ["-i", file];
    const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-nostats", ...input, "-af", "volumedetect", "-f", "null", "-"],
      { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const m = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
