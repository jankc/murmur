// Renders the SwiftBar menubar block from on-disk state (recording pid, queue, pause),
// so it works whether or not the daemon is running. Menu actions invoke the murmur CLI
// itself (`bun run cli.ts <cmd>`), which routes to the daemon when up, else acts directly.
import type { Config } from "./config.ts";
import { offlineSnapshot } from "./status.ts";

export async function renderSwiftBar(cfg: Config, bun: string, cli: string): Promise<string> {
  const s = await offlineSnapshot(cfg); // same on-disk state the daemon reports
  const recording = s.recording;
  const paused = s.pause !== "none";
  const depth = s.queueDepth;

  // SwiftBar runs `bash=<bin>` with paramN as argv; values must contain no spaces.
  const action = (label: string, ...cmd: string[]): string => {
    const params = ["run", cli, ...cmd].map((v, i) => `param${i + 1}=${v}`).join(" ");
    return `${label} | bash=${bun} ${params} terminal=false refresh=true`;
  };

  const title = recording ? "🔴" : paused ? "⏸" : "⚪";
  const lines: string[] = [depth > 0 ? `${title} ${depth}` : title, "---"];

  if (recording) {
    if (s.recordingFile) lines.push(`Recording: ${s.recordingFile.split("/").pop()} | color=red`);
    lines.push(action("Stop recording", "stop"));
  } else {
    lines.push(action("Start recording", "record"));
  }

  lines.push(s.current ? `Processing: ${s.current.basename} (${s.current.stage})` : `Queue: ${depth}`);
  if (paused) {
    lines.push(`Processing paused (${s.pause}) | color=orange`);
    lines.push(action("Resume processing", "resume"));
  } else {
    lines.push(action("Pause (soft — finish current)", "pause"));
    lines.push(action("Pause now (hard — abort current)", "pause", "hard"));
  }
  return lines.join("\n") + "\n";
}
