// Load configuration, layered env > murmur.toml > secrets_command > defaults. murmur.toml is the
// single config file; its secrets_command (arbitrary shell) fills gaps — chiefly a sourced secret
// like HF_TOKEN, kept out of the file — and an environment variable always wins (e.g. the launchd
// plist). Produces one frozen Config.
import { join, dirname, delimiter } from "node:path";
import { buildPaths, type Paths } from "./paths.ts";
import { truthy, parseNum } from "./util.ts";
import { readMurmurToml, expandHome } from "./tomlconfig.ts";
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

// Keys we capture from secrets_command's environment, in a fixed order, NUL-separated so values
// with spaces survive intact.
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

// Normalise murmur.toml's `secrets_command` (a shell command, or an array of them) to one script.
function secretsCommandOf(toml: Record<string, unknown> | null): string | undefined {
  const sc = toml?.["secrets_command"];
  if (typeof sc === "string") return sc.trim() || undefined;
  if (Array.isArray(sc)) {
    const cmds = sc.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return cmds.length ? cmds.join("\n") : undefined;
  }
  return undefined;
}

// Run murmur.toml's secrets_command and capture the KEYS it exported. The command is arbitrary
// shell — `source a-cache`, `op read …`, `pass show …`, etc. — run in a subshell purely to
// populate the environment; only recognised vars (HF_TOKEN, …) are kept. `set -a` exports bare
// assignments too, and printf is always the final command so a benign non-zero line (e.g. an
// absent secrets file) can't abort startup. Returns {} without spawning bash when no command is set.
function secretsEnv(secretsCommand: string | undefined): RawEnv {
  if (!secretsCommand) return {};
  const script = `set -a; ${secretsCommand}; printf '%s\\0' ${KEYS.map((k) => `"\${${k}-}"`).join(" ")}`;
  const res = Bun.spawnSync(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) {
    throw new Error(`secrets_command failed: ${res.stderr.toString()}`);
  }
  const values = res.stdout.toString().split("\0");
  const raw: RawEnv = {};
  KEYS.forEach((k, i) => {
    const v = values[i];
    if (v !== undefined && v !== "") raw[k] = v;
  });
  return raw;
}

// murmur.toml uses grouped, idiomatic tables; map them onto the flat KEYS used throughout
// loadConfig. Path-valued keys get a leading "~/" expanded (TOML does no shell expansion). An
// empty value means "unset" (→ default).
function tomlToRawEnv(toml: Record<string, any>): RawEnv {
  const asr = (toml.asr ?? {}) as Record<string, any>;
  const summary = (toml.summary ?? {}) as Record<string, any>;
  const vault = (toml.vault ?? {}) as Record<string, any>;
  const rec = (toml.recording ?? {}) as Record<string, any>;
  const path = (v: unknown) => (typeof v === "string" ? expandHome(v) : v);
  const bool = (v: unknown) => (typeof v === "boolean" ? (v ? "1" : "0") : v);
  const mapping: Record<(typeof KEYS)[number], unknown> = {
    MEETINGS_BASE: path(toml.meetings_base),
    MODEL_SUMMARY: summary.model,
    MURMUR_PORT: toml.port,
    MURMUR_PYTHON: path(asr.python),
    ASR_MODEL: asr.model,
    ASR_LANG: asr.language,
    DIARIZE: bool(asr.diarize),
    DIARIZE_NUM_SPEAKERS: asr.num_speakers,
    HF_TOKEN: asr.hf_token,
    OLLAMA_HOST: summary.ollama_host,
    PROMPT_FILE: path(summary.prompt_file),
    RECORD_BACKEND: rec.backend,
    RECORD_DEVICE_INDEX: rec.device_index,
    OWNSCRIBE_BIN: path(rec.ownscribe_bin),
    MAX_DURATION_SECONDS: rec.max_duration_seconds,
    PROCESS_TIMEOUT_SECONDS: toml.process_timeout_seconds,
    RECORD_PAN_FILTER: rec.pan_filter,
    RECORD_SILENCE_DB: rec.silence_db,
    OBSIDIAN_VAULT: path(vault.root),
    VAULT_FOLDER: vault.folder,
  };
  const raw: RawEnv = {};
  for (const k of KEYS) {
    const v = mapping[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s !== "") raw[k] = s;
  }
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

export function loadConfig(repoDir: string = REPO_DIR): Config {
  // Layered: env > murmur.toml > secrets_command > defaults. murmur.toml is the config; the env
  // exported by its secrets_command fills only what the TOML omits — which is where a *sourced*
  // secret (e.g. HF_TOKEN from a secrets manager) belongs, kept out of the config proper.
  const parsedToml = readMurmurToml(repoDir);
  const tomlRaw: RawEnv = parsedToml ? tomlToRawEnv(parsedToml) : {};
  const shRaw: RawEnv = secretsEnv(secretsCommandOf(parsedToml));
  const pick = (key: (typeof KEYS)[number], fallback: string): string =>
    process.env[key] ?? tomlRaw[key] ?? shRaw[key] ?? fallback;

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
    repoDir,
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
    promptFile: pick("PROMPT_FILE", join(repoDir, "prompts/summary.md")),
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

// The resolved config as shell `export KEY='value'` lines, for `murmur print-env` (consumed by
// launchd/run-daemon.sh to locate the log dir, whichever config file is in use). The inverse of
// the KEYS mapping; empty values are omitted so re-importing them can't clobber a default.
export function configAsEnv(cfg: Config): Record<string, string> {
  const all: Record<(typeof KEYS)[number], string> = {
    MEETINGS_BASE: cfg.meetingsBase,
    MODEL_SUMMARY: cfg.modelSummary,
    MURMUR_PORT: String(cfg.port),
    MURMUR_PYTHON: cfg.pythonBin,
    ASR_MODEL: cfg.asrModel,
    ASR_LANG: cfg.language,
    DIARIZE: cfg.diarize ? "1" : "0",
    DIARIZE_NUM_SPEAKERS: String(cfg.numSpeakers),
    HF_TOKEN: cfg.hfToken,
    OLLAMA_HOST: cfg.ollamaHost,
    PROMPT_FILE: cfg.promptFile,
    RECORD_BACKEND: cfg.recordBackend,
    RECORD_DEVICE_INDEX: cfg.recordDeviceIndex,
    OWNSCRIBE_BIN: cfg.ownscribeBin,
    MAX_DURATION_SECONDS: String(cfg.maxDurationSeconds),
    PROCESS_TIMEOUT_SECONDS: String(cfg.processTimeoutSeconds),
    RECORD_PAN_FILTER: cfg.panFilter,
    RECORD_SILENCE_DB: String(cfg.silenceDb),
    OBSIDIAN_VAULT: cfg.vaultRoot,
    VAULT_FOLDER: cfg.vaultFolder,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (v !== "") out[k] = v;
  return out;
}
