// Transcode any ffmpeg-readable audio (m4a, the ownscribe 24 kHz float merge, the raw PCM
// capture) to the pipeline's canonical 16 kHz mono FLAC. Shared by both recorder backends'
// finalize step and `murmur import`, so there's one definition of "what murmur's audio is".
// FLAC is lossless (identical ASR accuracy) but ~half the size of the old s16le WAV.
import { existsSync, statSync } from "node:fs";
import type { Config } from "./config.ts";
import { log } from "./log.ts";

/** Transcode `input` → `out` (16 kHz mono FLAC). Returns false (and logs) on a missing/empty
 *  input or a non-zero ffmpeg exit; never throws. The caller owns `out` on failure. */
export async function transcodeToFlac16k(cfg: Config, input: string, out: string): Promise<boolean> {
  if (!existsSync(input) || statSync(input).size === 0) {
    log.warn("transcode", `no audio to transcode: ${input}`);
    return false;
  }
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-nostats", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "flac", out],
    { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    log.error("transcode", `ffmpeg failed (${code}) for ${input}: ${(await new Response(proc.stderr).text()).slice(-400)}`);
    return false;
  }
  return true;
}
