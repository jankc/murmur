// Atomic JSON persistence: write to a temp file then rename, so a crash mid-write
// can never leave a torn state file (queue/pause/current).
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  const file = Bun.file(path);
  if (!(await file.exists())) return fallback;
  try {
    return (await file.json()) as T;
  } catch {
    // Corrupt/empty file — fall back rather than crash the daemon.
    return fallback;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await Bun.write(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
