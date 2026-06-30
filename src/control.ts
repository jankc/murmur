// Localhost-only HTTP control API. SwiftBar, the CLI scripts, and you (via curl)
// drive the daemon through this. No auth — single-user macOS, bound to 127.0.0.1.
import type { Config } from "./config.ts";
import type { Worker } from "./worker.ts";
import { Queue } from "./queue.ts";
import { resolveWav } from "./recordings.ts";
import type { Recorder } from "./recorder.ts";
import { type PauseStore, clearMeetingDetected } from "./jobstate.ts";
import type { MeetingWatcher } from "./meetwatch.ts";
import { statusSnapshot } from "./status.ts";
import { log } from "./log.ts";

interface Deps {
  cfg: Config;
  worker: Worker;
  queue: Queue;
  recorder: Recorder;
  pause: PauseStore;
  meetwatch?: MeetingWatcher | null; // present only when meeting auto-detection is enabled
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
  const { cfg, worker, queue, recorder, pause, meetwatch } = deps;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: cfg.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const route = `${req.method} ${pathname}`;

      // CSRF guard for state-changing routes: a browser form can POST to loopback, but it
      // can't send an application/json content-type (that forces a CORS preflight we never
      // answer) nor omit the Origin header. Our own clients (CLI/SwiftBar fetch, curl) send
      // no Origin and an application/json content-type — they pass; a web page is rejected.
      if (req.method !== "GET") {
        const ct = req.headers.get("content-type") ?? "";
        if (!ct.startsWith("application/json") || req.headers.get("origin")) {
          return json({ error: "forbidden" }, 403);
        }
      }

      switch (route) {
        case "GET /status": {
          return json(await statusSnapshot(cfg, recorder, pause, queue.list()));
        }
        case "POST /record/start": {
          const r = await recorder.start();
          // A recording is starting (often FROM the meeting nudge) — clear the detected-meeting flag
          // so the menubar drops its "Start recording" affordance.
          void clearMeetingDetected(cfg).catch(() => {});
          worker.notifyChange();
          return json(r, r.ok ? 200 : 409);
        }
        case "POST /record/stop": {
          const r = await recorder.stop();
          // Clear the flag and start the post-stop cooldown so the watcher doesn't immediately
          // re-nudge while the mic lingers.
          void clearMeetingDetected(cfg).catch(() => {});
          meetwatch?.markRecordingStopped();
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
