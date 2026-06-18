// Transcription via whisply (uses mlx-whisper on Apple Silicon, optional pyannote
// diarization). whisply writes a NESTED layout under -o:
//   <out>/<stem>/<stem>_<lang>[ _annotated].txt
// so we run it into a per-job scratch dir, then locate + normalize the produced txt
// to the flat transcripts/<base>.txt path that summarize.sh + idempotency expect.
import { mkdir, rm, link, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { QueueItem } from "../queue.ts";
import { log } from "../log.ts";
import { AbortError, EngineError, isAbort } from "./errors.ts";

export async function transcribe(cfg: Config, job: QueueItem, signal: AbortSignal): Promise<string> {
  const scratch = cfg.paths.scratchDir(job.basename);
  const localInput = join(scratch, "audio.wav");
  const wantDiarize = cfg.diarize && !!cfg.hfToken;

  await prepareScratch(scratch, localInput, job.wavPath);
  try {
    await runWhisply(cfg, job.basename, localInput, scratch, signal, wantDiarize);
  } catch (err) {
    if (isAbort(err) || signal.aborted) throw err;
    if (wantDiarize) {
      // Diarization can fail independently of transcription (e.g. gated pyannote
      // models, MPS issues). Don't lose the transcript over it — retry plain.
      log.warn("whisply", `${job.basename}: diarized run failed (${(err as Error).message}); retrying without diarization`);
      await prepareScratch(scratch, localInput, job.wavPath); // whisply may have mutated localInput
      await runWhisply(cfg, job.basename, localInput, scratch, signal, false);
    } else {
      throw err;
    }
  }
  return await locateAndNormalize(cfg, job.basename, scratch);
}

/** Reset the scratch dir and link the input in under an already-sanitized name.
 *  whisply renames/sanitizes its -f input file IN PLACE, which would corrupt
 *  recordings/ and could re-trigger the watcher — so it only ever sees this copy. */
async function prepareScratch(scratch: string, localInput: string, wavPath: string): Promise<void> {
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    await link(wavPath, localInput); // instant hardlink (same filesystem)
  } catch {
    await copyFile(wavPath, localInput);
  }
}

async function runWhisply(
  cfg: Config,
  label: string,
  localInput: string,
  scratch: string,
  signal: AbortSignal,
  diarize: boolean,
): Promise<void> {
  const args = ["run", "-f", localInput, "-o", scratch, "-d", cfg.device, "-m", cfg.whisplyModel, "-l", cfg.language, "-e", "txt"];
  if (diarize) args.push("--annotate", "-hf", cfg.hfToken);
  log.info("whisply", `transcribing ${label}${diarize ? " (diarized)" : ""}`);

  const proc = Bun.spawn([cfg.whisplyBin, ...args], {
    // whisply computes output paths relative to cwd and crashes if they're outside it,
    // so run it from $MEETINGS_BASE (which contains both the input wav and the scratch dir).
    cwd: cfg.meetingsBase,
    env: { ...process.env, PATH: cfg.childPath },
    stdout: "pipe",
    stderr: "pipe",
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => {
    try { proc.kill("SIGTERM"); } catch {}
    killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let code: number;
  try {
    code = await proc.exited;
  } finally {
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", onAbort);
  }

  if (signal.aborted) throw new AbortError("whisply aborted");
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new EngineError(`whisply exited ${code}`, code, stderr.slice(-2000));
  }
}

async function locateAndNormalize(cfg: Config, basename: string, scratch: string): Promise<string> {
  const found: string[] = [];
  const glob = new Bun.Glob("**/*.txt");
  for await (const f of glob.scan({ cwd: scratch, absolute: true })) found.push(f);

  const dest = cfg.paths.transcript(basename);
  await mkdir(cfg.paths.transcriptsDir, { recursive: true });

  if (found.length === 0) {
    // whisply writes nothing for "no speech" — emit an empty transcript so the
    // Czech prompt returns its "prázdný/testovací" one-liner instead of erroring.
    log.warn("whisply", `${basename}: no transcript produced (no speech?) — writing empty transcript`);
    await Bun.write(dest, "");
  } else {
    const pick =
      found.find((f) => f.endsWith("_annotated.txt")) ??
      found.find((f) => f.endsWith(`_${cfg.language}.txt`)) ??
      [...found].sort((a, b) => b.length - a.length)[0]!;
    await Bun.write(dest, Bun.file(pick));
  }

  if (cfg.cleanScratch) await rm(scratch, { recursive: true, force: true });
  return dest;
}
