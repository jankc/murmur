// Load configuration by sourcing the repo's config.sh (so $HOME etc. expand correctly)
// and layering daemon-specific defaults on top. Produces one frozen, typed Config.
import { join, dirname, delimiter } from "node:path";
import { buildPaths, type Paths } from "./paths.ts";
import { truthy, parseNum } from "./util.ts";
import { log } from "./log.ts";

export interface Config {
  repoDir: string;
  meetingsBase: string;
  paths: Paths;
  port: number;
  // whisply (transcription)
  whisplyBin: string;
  whisplyModel: string;
  language: string;
  device: string;
  diarize: boolean;
  hfToken: string;
  cleanScratch: boolean;
  // ollama (summarization)
  ollamaHost: string;
  modelSummary: string;
  promptFile: string;
  // Obsidian vault archiving (optional — empty vaultRoot disables it)
  vaultRoot: string;
  vaultFolder: string;
  // recording (ffmpeg from the Aggregate Device)
  recordDeviceIndex: string;
  maxDurationSeconds: number;
  panFilter: string; // ffmpeg filter that downmixes the Aggregate Device to mono
  silenceDb: number; // warn after stop if the recording's peak dBFS is at/below this

  // PATH handed to spawned children so ffmpeg/whisply/ollama/terminal-notifier resolve.
  childPath: string;
}

const REPO_DIR = join(import.meta.dir, "..");

// Keys we pull out of config.sh, in a fixed order, NUL-separated so values with
// spaces (e.g. MEETING_APPS) survive intact.
const KEYS = [
  "MEETINGS_BASE",
  "MODEL_SUMMARY",
  "MEETING_AI_PORT",
  "WHISPLY_BIN",
  "WHISPLY_MODEL",
  "WHISPLY_LANG",
  "WHISPLY_DEVICE",
  "DIARIZE",
  "HF_TOKEN",
  "OLLAMA_HOST",
  "PROMPT_FILE",
  "MEETING_AI_CLEAN_SCRATCH",
  "RECORD_DEVICE_INDEX",
  "MAX_DURATION_SECONDS",
  "RECORD_PAN_FILTER",
  "RECORD_SILENCE_DB",
  "OBSIDIAN_VAULT",
  "VAULT_FOLDER",
] as const;

// Downmix the 3-channel Aggregate Device to mono for transcription. Channel layout (from
// Audio MIDI Setup): c0+c1 = BlackHole 2ch (system audio — the other participants), c2 =
// MacBook Pro Microphone (your own voice). The stereo system pair (0.35+0.35 ≈ 0.7 for
// centred speech) is balanced against the single mono mic at 0.7, and alimiter prevents
// clipping when both are loud. Override with RECORD_PAN_FILTER if your Aggregate Device
// orders its sub-devices differently (the mic landing on a different channel is the usual
// reason a capture comes out mute or lopsided).
const DEFAULT_PAN_FILTER = "pan=mono|c0=0.35*c0+0.35*c1+0.7*c2,alimiter";

type RawEnv = Partial<Record<(typeof KEYS)[number], string>>;

function sourceConfigSh(): RawEnv {
  const configSh = join(REPO_DIR, "config.sh");
  const script = `set -a; [ -f "${configSh}" ] && . "${configSh}"; printf '%s\\0' ${KEYS.map((k) => `"\${${k}-}"`).join(" ")}`;
  const res = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`failed to source config.sh: ${res.stderr.toString()}`);
  }
  const values = res.stdout.toString().split("\0");
  const raw: RawEnv = {};
  KEYS.forEach((k, i) => {
    const v = values[i];
    if (v !== undefined && v !== "") raw[k] = v;
  });
  return raw;
}

function buildChildPath(whisplyBin: string): string {
  const home = process.env.HOME ?? "";
  const wanted = [
    dirname(whisplyBin),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? join(home, ".local/bin") : "",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  const existing = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return [...new Set([...wanted, ...existing])].join(delimiter);
}

export function loadConfig(): Config {
  const raw = sourceConfigSh();
  // Env vars (e.g. set in the plist) override config.sh, which overrides defaults.
  const pick = (key: (typeof KEYS)[number], fallback: string): string =>
    process.env[key] ?? raw[key] ?? fallback;

  const home = process.env.HOME ?? "";
  const meetingsBase = pick("MEETINGS_BASE", join(home, "Recordings/Meetings"));
  const whisplyBin = pick("WHISPLY_BIN", join(home, ".local/bin/whisply"));
  // Numeric config with a guard: a non-numeric value falls back (with a warning) rather
  // than silently becoming NaN (which would, e.g., break the control-API port bind).
  const num = (key: (typeof KEYS)[number], fallback: number): number => {
    const raw = pick(key, String(fallback));
    if (!Number.isFinite(Number(raw))) log.warn("config", `${key}="${raw}" is not a number — using ${fallback}`);
    return parseNum(raw, fallback);
  };

  const cfg: Config = {
    repoDir: REPO_DIR,
    meetingsBase,
    paths: buildPaths(meetingsBase),
    port: num("MEETING_AI_PORT", 7461),
    whisplyBin,
    whisplyModel: pick("WHISPLY_MODEL", "large-v3-turbo"),
    language: pick("WHISPLY_LANG", "cs"),
    device: pick("WHISPLY_DEVICE", "mlx"),
    diarize: truthy(pick("DIARIZE", "0")),
    hfToken: pick("HF_TOKEN", ""),
    cleanScratch: truthy(pick("MEETING_AI_CLEAN_SCRATCH", "1")),
    ollamaHost: pick("OLLAMA_HOST", "http://localhost:11434"),
    modelSummary: pick("MODEL_SUMMARY", "gemma4:26b-mlx"),
    promptFile: pick("PROMPT_FILE", join(REPO_DIR, "prompts/summary.md")),
    vaultRoot: pick("OBSIDIAN_VAULT", ""),
    vaultFolder: pick("VAULT_FOLDER", "Murmur"),
    recordDeviceIndex: pick("RECORD_DEVICE_INDEX", "0"),
    maxDurationSeconds: num("MAX_DURATION_SECONDS", 7200),
    panFilter: pick("RECORD_PAN_FILTER", DEFAULT_PAN_FILTER),
    silenceDb: num("RECORD_SILENCE_DB", -80),
    childPath: buildChildPath(whisplyBin),
  };

  if (cfg.diarize && !cfg.hfToken) {
    log.warn("config", "DIARIZE=1 but HF_TOKEN is empty — diarization disabled (running whisply without --annotate)");
  }
  return Object.freeze(cfg);
}
