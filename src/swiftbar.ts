// Renders the SwiftBar menubar block from on-disk state (recording pid, queue, pause),
// so it works whether or not the daemon is running. Menu actions invoke the murmur CLI
// itself (`bun run cli.ts <cmd>`), which routes to the daemon when up, else acts directly.
import type { Config } from "./config.ts";
import { FfmpegRecorder } from "./recorder.ts";
import { PauseStore, readCurrent } from "./jobstate.ts";
import { readJson } from "./state.ts";
import type { QueueItem } from "./queue.ts";

export async function renderSwiftBar(cfg: Config, bun: string, cli: string): Promise<string> {
  const recorder = new FfmpegRecorder(cfg);
  const pause = await PauseStore.load(cfg);
  const queue = await readJson<{ items: QueueItem[] }>(cfg.paths.queueFile, { items: [] });

  const recording = recorder.isRecording();
  const paused = pause.isPaused();
  const depth = queue.items.length;

  // SwiftBar runs `bash=<bin>` with paramN as argv; values must contain no spaces.
  const action = (label: string, ...cmd: string[]): string => {
    const params = ["run", cli, ...cmd].map((v, i) => `param${i + 1}=${v}`).join(" ");
    return `${label} | bash=${bun} ${params} terminal=false refresh=true`;
  };

  const title = recording ? "🔴" : paused ? "⏸" : "⚪";
  const lines: string[] = [depth > 0 ? `${title} ${depth}` : title, "---"];

  if (recording) {
    const f = recorder.currentFile();
    if (f) lines.push(`Recording: ${f.split("/").pop()} | color=red`);
    lines.push(action("Stop recording", "stop"));
  } else {
    lines.push(action("Start recording", "record"));
  }

  const current = await readCurrent(cfg);
  lines.push(current ? `Processing: ${current.basename} (${current.stage})` : `Queue: ${depth}`);
  if (paused) {
    lines.push(`Processing paused (${pause.mode()}) | color=orange`);
    lines.push(action("Resume processing", "resume"));
  } else {
    lines.push(action("Pause (soft — finish current)", "pause"));
    lines.push(action("Pause now (hard — abort current)", "pause", "hard"));
  }
  return lines.join("\n") + "\n";
}
