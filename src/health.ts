// Setup/health checks shared by `murmur doctor` (prints a checklist, exits non-zero on a
// hard failure) and the daemon's startup selfCheck (logs them). One definition so the two
// can't drift. A check is "error" (the pipeline can't work) or "warn" (degraded/optional).
import type { Config } from "./config.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  level: "error" | "warn";
}

export async function runChecks(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const fileOk = (p: string) => Bun.file(p).exists();
  const add = (name: string, ok: boolean, detail: string, level: Check["level"] = "error") =>
    checks.push({ name, ok, detail, level });

  add("config.sh", await fileOk(`${cfg.repoDir}/config.sh`), `${cfg.repoDir}/config.sh`, "warn");
  // PROMPT_FILE is read on every non-trivial summarize — a missing override silently breaks it.
  add("summary prompt", await fileOk(cfg.promptFile), cfg.promptFile);
  add("asr venv python", await fileOk(cfg.pythonBin), cfg.pythonBin);

  const ffmpeg = Bun.which("ffmpeg", { PATH: cfg.childPath });
  add("ffmpeg", !!ffmpeg, ffmpeg ?? "not on PATH");

  if (cfg.recordBackend === "ownscribe") {
    add("ownscribe-audio", await fileOk(cfg.ownscribeBin), cfg.ownscribeBin);
  }

  const ollamaUp = await fetch(`${cfg.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  add("ollama reachable", ollamaUp, cfg.ollamaHost);
  if (ollamaUp) {
    const present = await fetch(`${cfg.ollamaHost}/api/show`, {
      method: "POST",
      body: JSON.stringify({ name: cfg.modelSummary }),
      signal: AbortSignal.timeout(3000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    add(`model ${cfg.modelSummary}`, present, present ? "available" : "not pulled — `ollama pull` or `ollama create` it");
  }

  if (cfg.diarize) {
    add("HF_TOKEN (diarization)", !!cfg.hfToken, cfg.hfToken ? "set" : "empty — diarization will be skipped", "warn");
  }

  const tn = Bun.which("terminal-notifier", { PATH: cfg.childPath });
  add("terminal-notifier", !!tn, tn ?? "not installed — notifications are silently skipped", "warn");

  return checks;
}
