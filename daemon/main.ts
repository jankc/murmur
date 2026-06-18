// meeting-ai orchestrator daemon entrypoint.
// Launched by the LaunchAgent: bun run daemon/main.ts
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { Queue } from "./queue.ts";
import { PauseStore } from "./jobstate.ts";
import { ScriptRecorder } from "./recorder.ts";
import { Worker } from "./worker.ts";
import { startControl } from "./control.ts";
import { startWatcher } from "./watcher.ts";
import { log } from "./log.ts";

const cfg = loadConfig();

// 1. Ensure the directory layout exists.
for (const dir of [
  cfg.paths.recordingsDir,
  cfg.paths.transcriptsDir,
  cfg.paths.summariesDir,
  cfg.paths.logsDir,
  cfg.paths.stateDir,
  cfg.paths.scratchRoot,
]) {
  await mkdir(dir, { recursive: true });
}

// 2. Single-instance lock (LaunchAgent KeepAlive + a manual run could otherwise double-run).
if (!(await acquireLock())) {
  log.error("main", `another daemon is already running (lock ${cfg.paths.lockFile}); exiting`);
  process.exit(1);
}

// 3. Startup self-check — surfaces the #1 failure mode (binaries not on PATH).
await selfCheck();

// 4. Construct + wire modules.
const queue = await Queue.load(cfg);
const pause = await PauseStore.load(cfg);
const recorder = new ScriptRecorder(cfg);
const worker = new Worker(cfg, queue, recorder, pause);

const server = startControl({ cfg, worker, queue, recorder, pause });
const watcher = startWatcher(cfg, (wav) => {
  void queue.enqueue(wav).then((item) => {
    if (item) worker.notifyChange();
  });
});

// 5. Graceful shutdown.
let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("main", `${sig} received — shutting down`);
  worker.shutdown();
  watcher.close();
  server.stop(true);
  try {
    rmSync(cfg.paths.lockFile);
  } catch {}
  setTimeout(() => process.exit(0), 200);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log.info("main", `daemon up — base=${cfg.meetingsBase} port=${cfg.port} pause=${pause.mode()} queueDepth=${queue.size()}`);

// 6. Run the worker loop (resolves when shutdown() stops it).
await worker.loop();

async function acquireLock(): Promise<boolean> {
  const f = cfg.paths.lockFile;
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false; // a live daemon holds the lock
      } catch {
        /* stale lock — fall through and overwrite */
      }
    }
  }
  await writeFile(f, String(process.pid));
  return true;
}

async function selfCheck(): Promise<void> {
  log.info("main", `whisply: ${cfg.whisplyBin} (${(await Bun.file(cfg.whisplyBin).exists()) ? "found" : "MISSING"})`);
  log.info("main", `whisply model=${cfg.whisplyModel} lang=${cfg.language} device=${cfg.device} diarize=${cfg.diarize && !!cfg.hfToken}`);
  log.info("main", `ollama: ${cfg.ollamaHost} model=${cfg.modelSummary}`);
  log.info("main", `recorder device index=${cfg.recordDeviceIndex}`);
  const ollamaUp = await fetch(`${cfg.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false);
  log.info("main", `ollama reachable: ${ollamaUp}`);
  log.info("main", `child PATH: ${cfg.childPath}`);
}
