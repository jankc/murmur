// One definition of "how long is this audio file" via ffprobe. Shared by the ASR pre-trim
// (re-anchoring timestamps) and the vault archiver (note frontmatter). Works for any container
// (FLAC/m4a/mp3/wav) and never throws — a missing-ffprobe/odd-file case returns null so callers
// just omit the duration rather than failing.
import type { Config } from "./config.ts";

export async function probeDurationSeconds(cfg: Config, file: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file],
      { env: { ...process.env, PATH: cfg.childPath }, stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
