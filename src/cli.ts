#!/usr/bin/env bun
// murmur — the unified CLI. Shares the same modules as the daemon, so
// there's a single implementation of every step. Stateful actions (record/process/
// pause/status) talk to the daemon when it's running, and fall back to doing the work
// directly when it isn't; one-shot transcribe/summarize always run inline.
import { basename, dirname, join } from "node:path";
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { loadConfig, type Config } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { MeetingRecorder } from "./recorder.ts";
import { transcribe } from "./engines/asr.ts";
import { summarize } from "./engines/ollama.ts";
import { archiveSummary } from "./archive.ts";
import { type QueueItem } from "./queue.ts";
import { resolveWav, move } from "./recordings.ts";
import { EngineError } from "./engines/errors.ts";
import { logFailure } from "./failures.ts";
import { PauseStore } from "./jobstate.ts";
import { sleep } from "./util.ts";
import { offlineSnapshot, renderStatus, type StatusSnapshot } from "./status.ts";
import { renderSwiftBar } from "./swiftbar.ts";
import { runChecks } from "./health.ts";

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
  const md = cfg.paths.summary(base);
  let stage = "transcribe";
  try {
    await transcribe(cfg, job, signal);
    stage = "summarize";
    await summarize(cfg, txt, signal);
    await archiveSummary(cfg, base, signal).catch((e) => console.error(`archive: ${String(e)}`));
    // Only retire managed recordings (under MEETINGS_BASE) to processed/; an external one-off
    // path has no managed home, and a basename match could move an unrelated recording.
    if (wavPath.startsWith(cfg.meetingsBase)) await move(cfg, base, "processed");
    return { txt, md };
  } catch (err) {
    const code = err instanceof EngineError ? err.exitCode : 1;
    // Only managed recordings (under MEETINGS_BASE) have a failed/ home. move()/logFailure
    // resolve by basename, so an external one-off path (`murmur process /some/file.wav`) is
    // left alone — otherwise a managed recording that happens to share its basename could be
    // moved to failed/ instead.
    if (wavPath.startsWith(cfg.meetingsBase)) {
      await logFailure(cfg, base, stage, code, wavPath);
      await move(cfg, base, "failed");
    }
    throw err;
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const DAEMON_LABEL = "com.jank.murmur.daemon";

/** Enqueue a resolved wav via the daemon, or process it inline when the daemon is down. */
async function dispatchWav(wav: string): Promise<void> {
  if (await daemonUp()) {
    const res = await daemonPost("/enqueue", { wav });
    console.log(`enqueued via daemon: ${await res.text()}`);
  } else {
    console.error(`daemon offline — processing inline: ${basename(wav)}`);
    const { txt, md } = await runInline(wav);
    console.log(`transcript: ${txt}`);
    console.log(`summary:    ${md}`);
  }
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out: (out + err).trim() };
}

/** Manage the launchd daemon so config/plist changes don't need raw launchctl. `restart`
 *  re-reads an edited plist (bootout + bootstrap — `kickstart` alone would not); `install`
 *  copies the repo plist into ~/Library/LaunchAgents first. */
async function daemonctl(cfg: Config, action: "start" | "stop" | "restart" | "install"): Promise<void> {
  const domain = `gui/${userInfo().uid}`;
  const target = `${domain}/${DAEMON_LABEL}`;
  const installed = join(userInfo().homedir, "Library/LaunchAgents", `${DAEMON_LABEL}.plist`);
  const bootstrap = () => launchctl("bootstrap", domain, installed);

  if (action === "install") {
    const tmpl = join(cfg.repoDir, "launchd", `${DAEMON_LABEL}.plist.example`);
    if (!existsSync(tmpl)) die(`plist template not found: ${tmpl}`);
    // Render the machine paths from the running environment (process.execPath is this very
    // bun) so there's nothing to hand-edit; run-daemon.sh derives the log path from config.sh.
    const rendered = readFileSync(tmpl, "utf8")
      .replaceAll("__REPO__", cfg.repoDir)
      .replaceAll("__HOME__", userInfo().homedir)
      .replaceAll("__BUN_DIR__", dirname(process.execPath));
    mkdirSync(dirname(installed), { recursive: true });
    writeFileSync(installed, rendered);
    console.log(`installed → ${installed}`);
  } else if (!existsSync(installed)) {
    die(`daemon not installed (${installed} missing) — run: murmur daemon install`);
  }

  if (action === "stop") {
    const r = await launchctl("bootout", target);
    console.log(r.ok ? "daemon stopped" : `not running (${r.out || "no such service"})`);
    return;
  }
  if (action === "start") {
    const r = await bootstrap();
    if (!r.ok) die(`start failed: ${r.out || "already running?"}`);
    console.log("daemon started");
    return;
  }
  // restart / install → bootstrap, after booting out any loaded instance.
  await launchctl("bootout", target); // ignore "not loaded"
  await sleep(300);
  const r = await bootstrap();
  if (!r.ok) die(`bootstrap failed: ${r.out}`);
  console.log(action === "install" ? "daemon installed and started" : "daemon restarted");
}

const USAGE = `murmur — local meeting recorder / transcriber / summarizer

Usage: murmur <command> [args]

  record [--device N]      start recording (system audio + your mic)
  stop                     stop the current recording
  process [audio]          transcribe + summarize (newest, or by path/basename)
  reprocess <name>         re-run the pipeline for one recording (incl. from failed/)
  retry-failed             re-enqueue every recording in recordings/failed/
  transcribe [audio]       transcribe only → prints transcript path
  summarize <transcript>   summarize a transcript → prints summary path
  status [--json]          recording / pause / queue / failures (human; --json for tools)
  pause [hard]             pause processing (soft = finish current; hard = abort + requeue)
  resume                   resume processing
  doctor                   check setup (venv, ffmpeg, ollama+model, ownscribe, …) → non-zero on problems
  logs [failures] [-f]     tail the daemon logs (or process-failures.log); -f to follow
  daemon <sub>             run | start | stop | restart | install (manage the LaunchAgent)

Stateful commands use the daemon if it's running, else act directly.`;

switch (cmd) {
  case "daemon": {
    const sub = rest[0];
    if (sub === undefined || sub === "run") await runDaemon(cfg);
    else if (sub === "start" || sub === "stop" || sub === "restart" || sub === "install") await daemonctl(cfg, sub);
    else die(`unknown: murmur daemon ${sub} (run|start|stop|restart|install)`);
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
    if (!r.ok) process.exit(1);
    break;
  }

  case "status": {
    const up = await daemonUp();
    const base = up
      ? ((await (await daemonGet("/status")).json()) as StatusSnapshot)
      : await offlineSnapshot(cfg);
    const snap = { daemon: up ? "running" : "offline", ...base };
    if (rest.includes("--json")) console.log(JSON.stringify(snap, null, 2));
    else console.log(renderStatus(snap));
    break;
  }

  case "pause": {
    const mode = positional() === "hard" ? "hard" : "soft";
    if (await daemonUp()) {
      const res = await daemonPost("/pause", { mode }).catch((e) => die(`pause failed: ${String(e)}`));
      if (!res.ok) die(`pause failed: HTTP ${res.status}`);
      const body = (await res.json()) as { pause?: string };
      console.log(`paused (${body.pause ?? mode}) [daemon]`);
    } else {
      await (await PauseStore.load(cfg)).set(mode);
      console.log(`paused (${mode}) [offline — state written, no daemon to honor it]`);
    }
    break;
  }

  case "resume": {
    if (await daemonUp()) {
      const res = await daemonPost("/resume").catch((e) => die(`resume failed: ${String(e)}`));
      if (!res.ok) die(`resume failed: HTTP ${res.status}`);
      console.log("resumed [daemon]");
    } else {
      await (await PauseStore.load(cfg)).set("none");
      console.log("resumed [offline — state written]");
    }
    break;
  }

  case "swiftbar": {
    // Used by the SwiftBar plugin; renders from on-disk state (daemon-independent).
    process.stdout.write(await renderSwiftBar(cfg, process.execPath, import.meta.path));
    break;
  }

  case "doctor": {
    const checks = await runChecks(cfg);
    for (const c of checks) {
      const icon = c.ok ? "✓" : c.level === "error" ? "✗" : "⚠";
      console.log(`${icon} ${c.name}: ${c.ok ? "ok" : c.detail}`);
    }
    const failed = checks.filter((c) => !c.ok && c.level === "error");
    if (failed.length > 0) die(`\n${failed.length} check(s) failed`);
    console.log("\nall good");
    break;
  }

  case "logs": {
    const which = positional(); // "failures" → process-failures.log; else the daemon logs
    const follow = rest.includes("-f") || rest.includes("--follow");
    const files =
      which === "failures"
        ? [cfg.paths.failureLog]
        : [join(cfg.paths.logsDir, "daemon.out.log"), join(cfg.paths.logsDir, "daemon.err.log")];
    const existing = files.filter((f) => existsSync(f));
    if (existing.length === 0) {
      console.log(`no logs yet under ${cfg.paths.logsDir}`);
      break;
    }
    const tailArgs = follow ? ["-n", "40", "-F", ...existing] : ["-n", "80", ...existing];
    await Bun.spawn(["tail", ...tailArgs], { stdout: "inherit", stderr: "inherit", stdin: "ignore" }).exited;
    break;
  }

  case "process": {
    const arg = positional();
    const wav = arg ? await resolveWav(cfg, arg) : newestRecording(cfg);
    if (!wav) die(`no recording found${arg ? `: ${arg}` : ""}`);
    try { await dispatchWav(wav); } catch (e) { die(`processing failed: ${String(e)}`); }
    break;
  }

  case "reprocess": {
    const arg = positional();
    if (!arg) die("usage: murmur reprocess <name|path>");
    const wav = await resolveWav(cfg, arg);
    if (!wav) die(`recording not found: ${arg}`);
    try { await dispatchWav(wav); } catch (e) { die(`processing failed: ${String(e)}`); }
    break;
  }

  case "retry-failed": {
    let names: string[];
    try {
      names = readdirSync(cfg.paths.failedDir).filter((f) => f.endsWith(".wav"));
    } catch {
      names = [];
    }
    if (names.length === 0) {
      console.log("no failed recordings to retry");
      break;
    }
    console.log(`retrying ${names.length} failed recording(s)…`);
    const stillFailing: string[] = [];
    for (const n of names) {
      // Don't let one bad recording (inline path) abort the rest — catch, continue, report.
      try {
        await dispatchWav(cfg.paths.failedWav(basename(n, ".wav")));
      } catch (e) {
        stillFailing.push(n);
        console.error(`  ✗ ${n}: ${String(e)}`);
      }
    }
    if (stillFailing.length > 0) die(`\n${stillFailing.length}/${names.length} still failing`);
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

  case "help":
  case "-h":
  case "--help":
    console.log(USAGE);
    break;

  default:
    console.error(`unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
}
