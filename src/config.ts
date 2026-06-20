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
  // ASR — transcription (mlx-whisper) + optional diarization (pyannote community-1),
  // both run by asr/asr.py in one venv.
  pythonBin: string; // python of the asr venv
  asrModel: string; // mlx-whisper model (hf repo)
  language: string;
  diarize: boolean;
  numSpeakers: number; // hint for diarization; 0 = auto-detect
  hfToken: string;
  // ollama (summarization)
  ollamaHost: string;
  modelSummary: string;
  promptFile: string;
  // Obsidian vault archiving (optional — empty vaultRoot disables it)
  vaultRoot: string;
  vaultFolder: string;
  // recording
  recordBackend: "ffmpeg" | "ownscribe"; // see README → Recording backends
  recordDeviceIndex: string; // ffmpeg backend: avfoundation index of the Aggregate Device
  ownscribeBin: string; // ownscribe backend: path to the ownscribe-audio binary (synced system+mic)
  maxDurationSeconds: number;
  processTimeoutSeconds: number; // per-stage wall-clock backstop — kills a wedged ASR/ollama job
  panFilter: string; // ffmpeg backend: filter that downmixes the Aggregate Device to mono
  silenceDb: number; // warn after stop if a track's peak dBFS is at/below this

  // PATH handed to spawned children so ffmpeg/python/ollama/terminal-notifier resolve.
  childPath: string;
}

const REPO_DIR = join(import.meta.dir, "..");

// Keys we pull out of config.sh, in a fixed order, NUL-separated so values with
// spaces (e.g. MEETING_APPS) survive intact.
const KEYS = [
  "MEETINGS_BASE",
  "MODEL_SUMMARY",
  "MURMUR_PORT",
  "MURMUR_PYTHON",
  "ASR_MODEL",
  "ASR_LANG",
  "DIARIZE",
  "DIARIZE_NUM_SPEAKERS",
  "HF_TOKEN",
  "OLLAMA_HOST",
  "PROMPT_FILE",
  "RECORD_BACKEND",
  "RECORD_DEVICE_INDEX",
  "OWNSCRIBE_BIN",
  "MAX_DURATION_SECONDS",
  "PROCESS_TIMEOUT_SECONDS",
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

function pickBackend(v: string): Config["recordBackend"] {
  return v === "ownscribe" ? v : "ffmpeg";
}

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

function buildChildPath(pythonBin: string): string {
  const home = process.env.HOME ?? "";
  const wanted = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    home ? join(home, ".local/bin") : "",
    dirname(pythonBin),
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
  const pythonBin = pick("MURMUR_PYTHON", join(home, ".local/share/murmur/asr-venv/bin/python"));
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
    port: num("MURMUR_PORT", 7461),
    pythonBin,
    asrModel: pick("ASR_MODEL", "mlx-community/whisper-large-v3-turbo"),
    language: pick("ASR_LANG", "auto"), // "auto" = let whisper detect; forcing a wrong language drops that speech
    diarize: truthy(pick("DIARIZE", "0")),
    numSpeakers: num("DIARIZE_NUM_SPEAKERS", 0),
    hfToken: pick("HF_TOKEN", ""),
    ollamaHost: pick("OLLAMA_HOST", "http://localhost:11434"),
    modelSummary: pick("MODEL_SUMMARY", "gemma4:26b-mlx"),
    promptFile: pick("PROMPT_FILE", join(REPO_DIR, "prompts/summary.md")),
    vaultRoot: pick("OBSIDIAN_VAULT", ""),
    vaultFolder: pick("VAULT_FOLDER", "Murmur"),
    recordBackend: pickBackend(pick("RECORD_BACKEND", "ffmpeg")),
    recordDeviceIndex: pick("RECORD_DEVICE_INDEX", "0"),
    ownscribeBin: pick("OWNSCRIBE_BIN", join(home, ".local/bin/ownscribe-audio")),
    maxDurationSeconds: num("MAX_DURATION_SECONDS", 7200),
    processTimeoutSeconds: num("PROCESS_TIMEOUT_SECONDS", 7200),
    panFilter: pick("RECORD_PAN_FILTER", DEFAULT_PAN_FILTER),
    silenceDb: num("RECORD_SILENCE_DB", -80),
    childPath: buildChildPath(pythonBin),
  };

  if (cfg.diarize && !cfg.hfToken) {
    log.warn("config", "DIARIZE=1 but HF_TOKEN is empty — diarization disabled (plain transcript)");
  }
  return Object.freeze(cfg);
}
