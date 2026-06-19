// Localhost-only HTTP control API. SwiftBar, the CLI scripts, and you (via curl)
// drive the daemon through this. No auth — single-user macOS, bound to 127.0.0.1.
import type { Config } from "./config.ts";
import type { Worker } from "./worker.ts";
import { Queue } from "./queue.ts";
import { resolveWav } from "./recordings.ts";
import type { Recorder } from "./recorder.ts";
import type { PauseStore } from "./jobstate.ts";
import { statusSnapshot } from "./status.ts";
import { log } from "./log.ts";

interface Deps {
  cfg: Config;
  worker: Worker;
  queue: Queue;
  recorder: Recorder;
  pause: PauseStore;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function safeJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function startControl(deps: Deps): ReturnType<typeof Bun.serve> {
  const { cfg, worker, queue, recorder, pause } = deps;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const route = `${req.method} ${pathname}`;

      switch (route) {
        case "GET /status": {
          return json(await statusSnapshot(cfg, recorder, pause, queue.list()));
        }
        case "POST /record/start": {
          const r = await recorder.start();
          worker.notifyChange();
          return json(r, r.ok ? 200 : 409);
        }
        case "POST /record/stop": {
          const r = await recorder.stop();
          worker.notifyChange();
          return json(r, r.ok ? 200 : 409);
        }
        case "POST /pause": {
          const { mode } = await safeJson(req);
          if (mode === "hard") await worker.hardPause();
          else await worker.softPause();
          return json({ pause: pause.mode() });
        }
        case "POST /resume": {
          await worker.resume();
          return json({ pause: pause.mode() });
        }
        case "POST /enqueue": {
          const body = await safeJson(req);
          const wavArg = typeof body.wav === "string" ? body.wav : "";
          if (!wavArg) return json({ error: "missing 'wav'" }, 400);
          const resolved = await resolveWav(cfg, wavArg);
          if (!resolved) return json({ error: `wav not found: ${wavArg}` }, 404);
          const item = await queue.enqueue(resolved);
          worker.notifyChange();
          return json({ enqueued: item?.basename ?? null });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    },
  });

  log.info("control", `listening on http://127.0.0.1:${cfg.port}`);
  return server;
}
