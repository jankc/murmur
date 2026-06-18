// Append pipeline failures to logs/process-failures.log in the same format as
// scripts/process.sh, including a ready-to-paste re-run command.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { notify } from "./notify.ts";
import { log } from "./log.ts";

export async function logFailure(
  cfg: Config,
  basename: string,
  stage: string,
  code: number,
  wavPath: string,
): Promise<void> {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const rerun = `${join(cfg.repoDir, "scripts/process.sh")} "${wavPath}"`;
  const lineText = `[${ts}] ${basename} — ${stage} failed (exit ${code}). Re-run: ${rerun}\n`;
  try {
    await mkdir(dirname(cfg.paths.failureLog), { recursive: true });
    await appendFile(cfg.paths.failureLog, lineText);
  } catch (err) {
    log.error("failures", `could not write failure log: ${String(err)}`);
  }
  log.error("failures", `${basename}: ${stage} failed (exit ${code})`);
  notify(cfg, `${stage} failed for ${basename} — see logs/process-failures.log`);
}
