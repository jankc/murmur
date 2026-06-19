// The serial GPU worker — exactly one transcribe+summarize job at a time.
// Honors soft/hard pause, auto-defers while a recording is in progress, processes each job
// unconditionally (location is the state — re-dropping a wav into inbox/ reprocesses it,
// overwriting outputs), and uses peek-then-commit so a crash mid-job replays cleanly.
import type { Config } from "./config.ts";
import type { Queue, QueueItem } from "./queue.ts";
import { move } from "./recordings.ts";
import type { Recorder } from "./recorder.ts";
import { PauseStore, writeCurrent, clearCurrent, readCurrent } from "./jobstate.ts";
import { transcribe } from "./engines/asr.ts";
import { summarize } from "./engines/ollama.ts";
import { archiveSummary } from "./archive.ts";
import { EngineError, isAbort } from "./engines/errors.ts";
import { logFailure } from "./failures.ts";
import { notify } from "./notify.ts";
import { log } from "./log.ts";

const IDLE_POLL_MS = 5000;

export class Worker {
  private running = false;
  private current: { ac: AbortController; job: QueueItem } | null = null;
  private wakeResolve: (() => void) | null = null;

  constructor(
    private cfg: Config,
    private queue: Queue,
    private recorder: Recorder,
    private pause: PauseStore,
  ) {}

  /** Wake the idle loop immediately (called when queue/pause/recording state changes). */
  notifyChange(): void {
    this.wakeResolve?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        this.wakeResolve = null;
        resolve();
      };
    });
  }

  async loop(): Promise<void> {
    this.running = true;
    await this.recover();
    log.info("worker", "loop started");
    while (this.running) {
      const blocked = this.pause.isPaused() || this.recorder.isRecording() || this.queue.size() === 0;
      if (blocked) {
        await this.wait(IDLE_POLL_MS);
        continue;
      }
      const job = this.queue.peek();
      if (!job) {
        await this.wait(IDLE_POLL_MS); // defensive: don't busy-spin if the head is gone
        continue;
      }
      await this.runOne(job);
    }
    log.info("worker", "loop stopped");
  }

  /** On startup, clear any stale current-job marker; the job itself is still queued
   *  (peek-then-commit) and will be retried — it just reruns from the top, overwriting outputs. */
  private async recover(): Promise<void> {
    const cur = await readCurrent(this.cfg);
    if (cur) {
      log.info("worker", `recovering interrupted job ${cur.basename} (was at stage ${cur.stage})`);
      await clearCurrent(this.cfg);
    }
  }

  private async runOne(job: QueueItem): Promise<void> {
    const ac = new AbortController();
    this.current = { ac, job };
    try {
      // The job is in inbox/ → process it unconditionally, overwriting any prior outputs.
      // (Re-dropping a wav into inbox is the supported way to reprocess; there are no
      // transcript/summary existence checks — location is the state.)
      const txt = this.cfg.paths.transcript(job.basename);
      await writeCurrent(this.cfg, { basename: job.basename, stage: "transcribe", startedAt: Date.now() });
      await transcribe(this.cfg, job, ac.signal);

      await writeCurrent(this.cfg, { basename: job.basename, stage: "summarize", startedAt: Date.now() });
      await summarize(this.cfg, txt, ac.signal);

      // Copy into the Obsidian vault (no-op if unconfigured). Abort propagates → requeue;
      // a vault error is logged but must not fail a job whose summary is already written locally.
      await writeCurrent(this.cfg, { basename: job.basename, stage: "archive", startedAt: Date.now() });
      try {
        await archiveSummary(this.cfg, job.basename, ac.signal);
      } catch (err) {
        if (isAbort(err) || ac.signal.aborted) throw err;
        log.warn("worker", `archive failed for ${job.basename}: ${String(err)}`);
      }

      // Done: the wav's home is now processed/<month>/ — that move IS the "processed"
      // signal (the watcher never looks outside inbox/ again).
      await move(this.cfg, job.basename, "processed");
      await this.queue.commitDequeue(job.basename);
      await clearCurrent(this.cfg);
      log.info("worker", `completed ${job.basename}`);
      notify(this.cfg, `Summary ready: ${job.basename}`);
    } catch (err) {
      if (isAbort(err) || ac.signal.aborted) {
        await this.queue.requeueFront(job.basename, job.wavPath);
        await clearCurrent(this.cfg);
        log.warn("worker", `aborted ${job.basename} (hard pause) — requeued`);
      } else {
        const stage = (await readCurrent(this.cfg))?.stage ?? "process";
        const code = err instanceof EngineError ? err.exitCode : 1;
        if (err instanceof EngineError && err.detail) log.error("worker", `${job.basename} stderr: ${err.detail}`);
        await logFailure(this.cfg, job.basename, stage, code, job.wavPath);
        // Move out of inbox/ so a poison recording doesn't get re-enqueued every restart.
        await move(this.cfg, job.basename, "failed");
        await this.queue.commitDequeue(job.basename);
        await clearCurrent(this.cfg);
      }
    } finally {
      this.current = null;
    }
  }

  currentBasename(): string | null {
    return this.current?.job.basename ?? null;
  }

  async softPause(): Promise<void> {
    await this.pause.set("soft");
    this.notifyChange();
    log.info("worker", "soft pause (will finish current job, then idle)");
  }

  async hardPause(): Promise<void> {
    await this.pause.set("hard");
    this.current?.ac.abort();
    this.notifyChange();
    log.info("worker", "hard pause (aborting current job)");
  }

  async resume(): Promise<void> {
    await this.pause.set("none");
    this.notifyChange();
    log.info("worker", "resumed");
  }

  /** Graceful shutdown: stop the loop and abort any in-flight child. */
  shutdown(): void {
    this.running = false;
    this.current?.ac.abort();
    this.notifyChange();
  }
}
