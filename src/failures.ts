// Append pipeline failures to logs/process-failures.log, including a ready-to-paste
// re-run command. Keyed by basename (location-independent — the wav has been moved to
// recordings/failed/, and `murmur process` resolves a basename wherever it sits).
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { notify } from "./notify.ts";
import { log, isoStamp } from "./log.ts";

export async function logFailure(
  cfg: Config,
  basename: string,
  stage: string,
  code: number,
  _wavPath: string,
): Promise<void> {
  // A copy-pasteable re-run command (no trailing prose); the wav sits in recordings/failed/.
  const lineText = `[${isoStamp()}] ${basename} — ${stage} failed (exit ${code}). Re-run: murmur reprocess "${basename}"\n`;
  try {
    await mkdir(dirname(cfg.paths.failureLog), { recursive: true });
    await appendFile(cfg.paths.failureLog, lineText);
  } catch (err) {
    log.error("failures", `could not write failure log: ${String(err)}`);
  }
  log.error("failures", `${basename}: ${stage} failed (exit ${code})`);
  notify(cfg, `${stage} failed for ${basename} — see logs/process-failures.log`);
}
