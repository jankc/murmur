// Persistent FIFO job queue, mirrored to state/queue.json on every mutation.
// The worker uses peek()-then-commitDequeue() so a job is only removed once both
// pipeline stages succeed — a crash mid-job leaves it at the head for replay.
import { basename as pathBasename, dirname } from "node:path";
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./state.ts";
import { log } from "./log.ts";

export interface QueueItem {
  basename: string; // the recording's folder name (its key through the lifecycle)
  wavPath: string; // the in-folder recording file: <lifecycle>/<basename>/recording.<ext>
  enqueuedAt: number;
  attempts: number;
}

interface QueueFileV1 {
  version: 1;
  items: QueueItem[];
}

// Locating a recording and resolving a wav argument now live in recordings.ts (the
// single owner of the folder-as-state lifecycle). They're re-exported there.

export class Queue {
  private items: QueueItem[];
  // Basenames currently mid-enqueue. Guards the window between the dedup check and the
  // async `summary exists?` await, so two near-simultaneous watcher events for the same
  // recording can't both pass the check and double-push.
  private enqueuing = new Set<string>();

  private constructor(private cfg: Config, items: QueueItem[]) {
    this.items = items;
  }

  static async load(cfg: Config): Promise<Queue> {
    const data = await readJson<QueueFileV1>(cfg.paths.queueFile, { version: 1, items: [] });
    return new Queue(cfg, Array.isArray(data.items) ? data.items : []);
  }

  size(): number {
    return this.items.length;
  }

  list(): QueueItem[] {
    return [...this.items];
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.cfg.paths.queueFile, { version: 1, items: this.items } satisfies QueueFileV1);
  }

  /**
   * Add a wav to the queue. A recording's location is its state: anything handed here
   * (it's in inbox/) is meant to be processed, so we do NOT skip based on an existing
   * transcript/summary — re-dropping a wav into inbox reprocesses it, overwriting outputs.
   * The only skip is queue integrity: already queued, or mid-enqueue. Returns the item, or
   * null if it was a duplicate.
   */
  async enqueue(wavPath: string): Promise<QueueItem | null> {
    // wavPath is the in-folder recording file (<lifecycle>/<base>/recording.<ext>), so the
    // recording's key is its FOLDER name — the parent dir of the recording file.
    const base = pathBasename(dirname(wavPath));
    if (this.items.some((i) => i.basename === base) || this.enqueuing.has(base)) return null;
    this.enqueuing.add(base);
    try {
      const item: QueueItem = { basename: base, wavPath, enqueuedAt: Date.now(), attempts: 0 };
      this.items.push(item);
      await this.persist();
      log.info("queue", `enqueued ${base} (depth ${this.items.length})`);
      return item;
    } finally {
      this.enqueuing.delete(base);
    }
  }

  /** Remove a job after it completes (or after a non-retryable failure). */
  async commitDequeue(basename: string): Promise<void> {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.basename !== basename);
    if (this.items.length !== before) await this.persist();
  }

  /** Put an aborted job back at the front (hard-pause). Increments attempts. */
  async requeueFront(basename: string, wavPath: string): Promise<void> {
    this.items = this.items.filter((i) => i.basename !== basename);
    this.items.unshift({ basename, wavPath, enqueuedAt: Date.now(), attempts: 0 });
    const item = this.items[0];
    if (item) item.attempts += 1;
    await this.persist();
  }
}
