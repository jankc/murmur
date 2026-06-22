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

  const symbol = recording
    ? "waveform.circle.fill"
    : paused
    ? "pause.circle.fill"
    : s.failedCount > 0
    ? "exclamationmark.circle.fill"
    : "waveform.circle";
  // Tint via sfconfig (palette rendering) rather than sfcolor — sfcolor on a title-line
  // sfimage is unreliable (swiftbar/SwiftBar#364). For *.circle.fill symbols the subject
  // (waveform / exclamation) is layer 0 and the surrounding circle is layer 1, so we paint
  // the subject in the menubar's own tint (looks identical to the idle icon) and only color
  // the ring. OS_APPEARANCE is a SwiftBar-provided env var ("Light" | "Dark").
  const appearance = process.env.OS_APPEARANCE ?? "Light";
  const neutral = appearance === "Dark" ? "#f5f5f7" : "#1d1d1f";
  const sfconfig = (subject: string, ring: string): string =>
    ` sfconfig=${Buffer.from(JSON.stringify({ renderingMode: "Palette", colors: [subject, ring] })).toString("base64")}`;
  const tint = recording
    ? sfconfig(neutral, "#FF3B30")
    : s.failedCount > 0
    ? sfconfig(neutral, "#FFD60A")
    : "";
  const title = `${depth > 0 ? `${depth} ` : ""}| sfimage=${symbol}${tint}`;
  const lines: string[] = [title, "---"];

  if (recording) {
    if (s.recordingFile) lines.push(`Recording: ${s.recordingFile.split("/").pop()} | color=red`);
    lines.push(action("Stop recording", "stop"));
  } else {
    lines.push(action("Start recording", "record"));
  }

  lines.push(s.current ? `Processing: ${s.current.basename} (${s.current.stage})` : `Queue: ${depth}`);
  if (s.failedCount > 0) {
    lines.push(`⚠️ ${s.failedCount} failed | color=red`);
    lines.push(action("Retry failed", "retry-failed"));
  }
  if (paused) {
    lines.push(`Processing paused (${s.pause}) | color=orange`);
    lines.push(action("Resume processing", "resume"));
  } else {
    lines.push(action("Pause (soft — finish current)", "pause"));
    lines.push(action("Pause now (hard — abort current)", "pause", "hard"));
  }
  return lines.join("\n") + "\n";
}
