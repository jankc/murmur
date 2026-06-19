#!/usr/bin/env bun
// murmur — the unified CLI. Shares the same modules as the daemon, so
// there's a single implementation of every step. Stateful actions (record/process/
// pause/status) talk to the daemon when it's running, and fall back to doing the work
// directly when it isn't; one-shot transcribe/summarize always run inline.
import { basename } from "node:path";
import { readdirSync, statSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { MeetingRecorder } from "./recorder.ts";
import { transcribe } from "./engines/asr.ts";
import { summarize } from "./engines/ollama.ts";
import { archiveSummary } from "./archive.ts";
import { type QueueItem } from "./queue.ts";
import { resolveWav, move } from "./recordings.ts";
import { PauseStore } from "./jobstate.ts";
import { offlineSnapshot } from "./status.ts";
import { renderSwiftBar } from "./swiftbar.ts";

const cfg = loadConfig();
const [cmd = "help", ...rest] = process.argv.slice(2);

const api = (path: string) => `http://127.0.0.1:${cfg.port}${path}`;
const daemonGet = (path: string) => fetch(api(path), { signal: AbortSignal.timeout(1500) });
const daemonPost = (path: string, body?: unknown) =>
  fetch(api(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
const daemonUp = () => daemonGet("/status").then((r) => r.ok).catch(() => false);

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
function positional(): string | undefined {
  return rest.find((a) => !a.startsWith("-"));
}

function newestRecording(cfg: Config): string | null {
  // Newest pending in inbox/ if any (the usual "process what I just recorded"); else
  // newest already-processed wav (inbox + processed are searched, recursively).
  const dirs = [cfg.paths.inboxDir, cfg.paths.processedDir];
  let best: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith(".wav")) continue;
      const p = `${dir}/${e}`;
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    }
    if (best && dir === cfg.paths.inboxDir) break; // prefer a pending recording
  }
  return best?.path ?? null;
}

async function runInline(wavPath: string): Promise<{ txt: string; md: string }> {
  const base = basename(wavPath, ".wav");
  const job: QueueItem = { basename: base, wavPath, enqueuedAt: 0, attempts: 0 };
  const signal = new AbortController().signal;
  // Process unconditionally, overwriting any prior outputs — same as the daemon worker.
  const txt = cfg.paths.transcript(base);
  await transcribe(cfg, job, signal);
  const md = cfg.paths.summary(base);
  await summarize(cfg, txt, signal);
  await archiveSummary(cfg, base, signal).catch((e) => console.error(`archive: ${String(e)}`));
  // Reached only on success (transcribe/summarize throw on failure): retire the wav to
  // processed/ so inbox stays pending-only, exactly as the daemon worker does.
  await move(cfg, base, "processed");
  return { txt, md };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case "daemon": {
    await runDaemon(cfg);
    break;
  }

  case "record": {
    const dev = flag("--device") ?? flag("-d");
    const recorder = new MeetingRecorder(dev ? { ...cfg, recordDeviceIndex: dev } : cfg);
    const r = await recorder.start();
    console.log(r.message);
    if (!r.ok) process.exit(1);
    break;
  }

  case "stop": {
    const r = await new MeetingRecorder(cfg).stop();
    console.log(r.message);
    break;
  }

  case "status": {
    if (await daemonUp()) {
      console.log(await (await daemonGet("/status")).text());
    } else {
      // Daemon down — assemble the same snapshot from on-disk state.
      console.log(JSON.stringify({ daemon: "offline", ...(await offlineSnapshot(cfg)) }, null, 2));
    }
    break;
  }

  case "pause": {
    const mode = positional() === "hard" ? "hard" : "soft";
    if (await daemonUp()) await daemonPost("/pause", { mode });
    else await (await PauseStore.load(cfg)).set(mode);
    console.log(`paused (${mode})`);
    break;
  }

  case "resume": {
    if (await daemonUp()) await daemonPost("/resume");
    else await (await PauseStore.load(cfg)).set("none");
    console.log("resumed");
    break;
  }

  case "swiftbar": {
    // Used by the SwiftBar plugin; renders from on-disk state (daemon-independent).
    process.stdout.write(await renderSwiftBar(cfg, process.execPath, import.meta.path));
    break;
  }

  case "process": {
    const arg = positional();
    const wav = arg ? await resolveWav(cfg, arg) : newestRecording(cfg);
    if (!wav) die(`no recording found${arg ? `: ${arg}` : ""}`);
    if (await daemonUp()) {
      const res = await daemonPost("/enqueue", { wav });
      console.log(`enqueued via daemon: ${await res.text()}`);
    } else {
      console.error(`daemon offline — processing inline: ${basename(wav)}`);
      const { txt, md } = await runInline(wav);
      console.log(`transcript: ${txt}`);
      console.log(`summary:    ${md}`);
    }
    break;
  }

  case "transcribe": {
    const arg = positional() ?? newestRecording(cfg) ?? "";
    const wav = (await resolveWav(cfg, arg)) ?? (arg && (await Bun.file(arg).exists()) ? arg : null);
    if (!wav) die(`recording not found: ${arg || "(none)"}`);
    const base = basename(wav, ".wav");
    const txt = cfg.paths.transcript(base);
    await transcribe(cfg, { basename: base, wavPath: wav, enqueuedAt: 0, attempts: 0 }, new AbortController().signal);
    console.log(txt);
    break;
  }

  case "summarize": {
    const arg = positional();
    if (!arg) die("usage: murmur summarize <transcript|basename>");
    const txt = (await Bun.file(arg).exists()) ? arg : cfg.paths.transcript(basename(arg, ".txt"));
    if (!(await Bun.file(txt).exists())) die(`transcript not found: ${arg}`);
    const sig = new AbortController().signal;
    const md = await summarize(cfg, txt, sig);
    await archiveSummary(cfg, basename(txt, ".txt"), sig).catch((e) => console.error(`archive: ${String(e)}`));
    console.log(md);
    break;
  }

  default:
    console.log(`murmur — local meeting recorder / transcriber / summarizer

Usage: murmur <command> [args]

  record [--device N]     start recording the Aggregate Device (ffmpeg)
  stop                    stop the current recording
  process [audio]         transcribe + summarize (newest, or by path/basename)
  transcribe [audio]      transcribe only → prints transcript path
  summarize <transcript>  summarize a transcript → prints summary path
  status                  recording / pause / queue state (JSON)
  pause [hard]            pause processing (soft = finish current; hard = abort + requeue)
  resume                  resume processing
  daemon                  run the orchestrator daemon in the foreground

Stateful commands use the daemon if it's running, else act directly.`);
    if (cmd !== "help") process.exit(1);
}
