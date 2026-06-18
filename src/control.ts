// Localhost-only HTTP control API. SwiftBar, the CLI scripts, and you (via curl)
// drive the daemon through this. No auth — single-user macOS, bound to 127.0.0.1.
import type { Config } from "./config.ts";
import type { Worker } from "./worker.ts";
import { Queue, resolveWav } from "./queue.ts";
import type { Recorder } from "./recorder.ts";
import type { PauseStore } from "./jobstate.ts";
import { readCurrent } from "./jobstate.ts";
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
          return json({
            recording: recorder.isRecording(),
            recordingFile: recorder.currentFile(),
            pause: pause.mode(),
            queueDepth: queue.size(),
            queue: queue.list().map((i) => i.basename),
            current: (await readCurrent(cfg)) ?? null,
          });
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
          const force = body.force === true;
          if (!wavArg) return json({ error: "missing 'wav'" }, 400);
          const resolved = await resolveWav(cfg, wavArg);
          if (!resolved) return json({ error: `wav not found: ${wavArg}` }, 404);
          const item = await queue.enqueue(resolved, { force });
          worker.notifyChange();
          return json({ enqueued: item?.basename ?? null });
        }
        case "GET /swiftbar": {
          return new Response(renderSwiftBar(deps), { headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    },
  });

  log.info("control", `listening on http://127.0.0.1:${cfg.port}`);
  return server;
}

/** Render a complete SwiftBar plugin block so the menubar script is just `curl`. */
function renderSwiftBar({ cfg, queue, recorder, pause }: Deps): string {
  const api = `http://127.0.0.1:${cfg.port}`;
  const recording = recorder.isRecording();
  const paused = pause.isPaused();
  const depth = queue.size();
  // SwiftBar runs the `bash=` binary with paramN as argv; values must contain no spaces.
  const action = (path: string, body?: string): string => {
    const parts = [`bash=/usr/bin/curl`, `param1=-fsS`, `param2=-X`, `param3=POST`, `param4=${api}${path}`];
    if (body) parts.push(`param5=-d`, `param6=${body}`);
    parts.push("terminal=false", "refresh=true");
    return parts.join(" ");
  };

  const title = recording ? "🔴" : paused ? "⏸" : "⚪";
  const lines: string[] = [depth > 0 ? `${title} ${depth}` : title, "---"];
  if (recording) {
    const f = recorder.currentFile();
    if (f) lines.push(`Recording: ${f.split("/").pop()} | color=red`);
    lines.push(`Stop recording | ${action("/record/stop")}`);
  } else {
    lines.push(`Start recording | ${action("/record/start")}`);
  }
  lines.push(`Queue: ${depth}`);
  if (paused) {
    lines.push(`Processing: paused (${pause.mode()}) | color=orange`);
    lines.push(`Resume processing | ${action("/resume")}`);
  } else {
    lines.push(`Processing: active`);
    lines.push(`Pause (soft — finish current) | ${action("/pause", '{"mode":"soft"}')}`);
    lines.push(`Pause now (hard — abort current) | ${action("/pause", '{"mode":"hard"}')}`);
  }
  return lines.join("\n") + "\n";
}
