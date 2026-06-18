// Persistent FIFO job queue, mirrored to state/queue.json on every mutation.
// The worker uses peek()-then-commitDequeue() so a job is only removed once both
// pipeline stages succeed — a crash mid-job leaves it at the head for replay.
import { basename as pathBasename, join, isAbsolute } from "node:path";
import type { Config } from "./config.ts";
import { readJson, writeJsonAtomic } from "./state.ts";
import { log } from "./log.ts";

export interface QueueItem {
  basename: string;
  wavPath: string;
  enqueuedAt: number;
  attempts: number;
}

interface QueueFileV1 {
  version: 1;
  items: QueueItem[];
}

/** Locate a recording by bare basename, wherever it currently sits in its lifecycle
 *  (inbox → processed/<month> → failed). Returns the existing path or null. */
export async function locateWav(cfg: Config, base: string): Promise<string | null> {
  const inbox = cfg.paths.inboxWav(base);
  if (await Bun.file(inbox).exists()) return inbox;
  const failed = cfg.paths.failedWav(base);
  if (await Bun.file(failed).exists()) return failed;
  // processed/ is partitioned by month — glob for the basename.
  const glob = new Bun.Glob(`**/${base}.wav`);
  for await (const rel of glob.scan({ cwd: cfg.paths.processedDir })) {
    return join(cfg.paths.processedDir, rel);
  }
  return null;
}

/** Resolve a /enqueue argument (full path or bare basename) to an existing .wav path. */
export async function resolveWav(cfg: Config, input: string): Promise<string | null> {
  if (isAbsolute(input)) return (await Bun.file(input).exists()) ? input : null;
  const cwd = join(process.cwd(), input);
  if (await Bun.file(cwd).exists()) return cwd;
  return locateWav(cfg, pathBasename(input, ".wav"));
}

export class Queue {
  private items: QueueItem[];

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
   * Add a wav to the queue. Skips if already queued or already fully processed
   * (summary exists) unless force is set. Returns the item, or null if skipped/missing.
   */
  async enqueue(wavPath: string, opts: { force?: boolean } = {}): Promise<QueueItem | null> {
    const base = pathBasename(wavPath, ".wav");
    if (this.items.some((i) => i.basename === base)) return null;
    if (!opts.force && (await Bun.file(this.cfg.paths.summary(base)).exists())) {
      log.info("queue", `skip ${base} (summary already exists)`);
      return null;
    }
    const item: QueueItem = { basename: base, wavPath, enqueuedAt: Date.now(), attempts: 0 };
    this.items.push(item);
    await this.persist();
    log.info("queue", `enqueued ${base} (depth ${this.items.length})`);
    return item;
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
