// Tests for the murmur.toml loader: the grouped-TOML → Config mapping, the legacy config.sh
// fallback, [[sources]] parsing, and the print-env round-trip. loadConfig/loadSources take a
// repoDir, so each test points them at a temp dir with its own config file.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configAsEnv } from "./config.ts";
import { readMurmurToml, expandHome } from "./tomlconfig.ts";
import { loadSources } from "./sources.ts";
import type { Config } from "./config.ts";

const HOME = process.env.HOME ?? "";

// Every key loadConfig reads from the environment. Cleared around each test so an exported
// MEETINGS_BASE (etc.) in the dev shell can't make a "toml value wins" assertion flaky.
const ENV_KEYS = [
  "MEETINGS_BASE", "MODEL_SUMMARY", "MURMUR_PORT", "MURMUR_PYTHON", "ASR_MODEL", "ASR_LANG",
  "DIARIZE", "DIARIZE_NUM_SPEAKERS", "HF_TOKEN", "OLLAMA_HOST", "PROMPT_FILE", "RECORD_BACKEND",
  "RECORD_DEVICE_INDEX", "OWNSCRIBE_BIN", "MAX_DURATION_SECONDS", "PROCESS_TIMEOUT_SECONDS",
  "RECORD_PAN_FILTER", "RECORD_SILENCE_DB", "OBSIDIAN_VAULT", "VAULT_FOLDER",
];
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "murmur-cfg-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("readMurmurToml", () => {
  test("returns null when the file is absent", () => {
    expect(readMurmurToml(mkdtempSync(join(tmpdir(), "murmur-empty-")))).toBeNull();
  });

  test("throws (loudly) on a malformed file rather than silently falling back", () => {
    const dir = tmpRepo({ "murmur.toml": "meetings_base = \n" });
    expect(() => readMurmurToml(dir)).toThrow(/failed to parse/);
  });
});

describe("loadConfig from murmur.toml", () => {
  const TOML = `
meetings_base = "~/X/base"
port = 9999
process_timeout_seconds = 123

[summary]
model = "test-model"

[asr]
language = "cs"
diarize = true
num_speakers = 3
hf_token = "hf_test"

[recording]
backend = "ownscribe"
silence_db = -40
`;

  test("maps grouped tables onto Config, expands ~/ , coerces types", () => {
    const dir = tmpRepo({ "murmur.toml": TOML });
    try {
      const cfg = loadConfig(dir);
      expect(cfg.meetingsBase).toBe(join(HOME, "X/base")); // ~/ expanded
      expect(cfg.port).toBe(9999); // number passes through num()
      expect(cfg.processTimeoutSeconds).toBe(123);
      expect(cfg.modelSummary).toBe("test-model");
      expect(cfg.language).toBe("cs");
      expect(cfg.diarize).toBe(true); // bool → "1" → truthy
      expect(cfg.numSpeakers).toBe(3);
      expect(cfg.hfToken).toBe("hf_test");
      expect(cfg.recordBackend).toBe("ownscribe");
      expect(cfg.silenceDb).toBe(-40); // negative number survives
      expect(cfg.repoDir).toBe(dir);
      expect(cfg.promptFile).toBe(join(dir, "prompts/summary.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unset keys fall back to built-in defaults", () => {
    const dir = tmpRepo({ "murmur.toml": TOML });
    try {
      const cfg = loadConfig(dir);
      expect(cfg.asrModel).toBe("mlx-community/whisper-large-v3-turbo");
      expect(cfg.ollamaHost).toBe("http://localhost:11434");
      expect(cfg.vaultRoot).toBe(""); // empty → archiving disabled
      expect(cfg.vaultFolder).toBe("Murmur");
      expect(cfg.maxDurationSeconds).toBe(7200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an environment variable overrides the file", () => {
    const dir = tmpRepo({ "murmur.toml": TOML });
    process.env.MEETINGS_BASE = "/env/wins";
    try {
      expect(loadConfig(dir).meetingsBase).toBe("/env/wins");
    } finally {
      delete process.env.MEETINGS_BASE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy config.sh fallback (no murmur.toml)", () => {
  test("config.sh is still read when murmur.toml is absent", () => {
    const dir = tmpRepo({ "config.sh": `export MEETINGS_BASE="/legacy/base"\nexport MODEL_SUMMARY="legacy-model"\n` });
    try {
      const cfg = loadConfig(dir);
      expect(cfg.meetingsBase).toBe("/legacy/base");
      expect(cfg.modelSummary).toBe("legacy-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("layered: murmur.toml wins per-key, config.sh fills the gaps (the secret-overlay case)", () => {
    const dir = tmpRepo({
      "murmur.toml": `meetings_base = "/from/toml"\n[summary]\nmodel = "toml-model"\n`,
      // config.sh re-declares MEETINGS_BASE (shadowed by toml) and supplies a key toml omits —
      // exactly how a sourced HF_TOKEN keeps flowing after you move config into murmur.toml.
      "config.sh": `export MEETINGS_BASE="/from/sh"\nexport HF_TOKEN="from-secrets-cache"\n`,
    });
    try {
      const cfg = loadConfig(dir);
      expect(cfg.meetingsBase).toBe("/from/toml"); // toml wins where both set it
      expect(cfg.hfToken).toBe("from-secrets-cache"); // config.sh fills what toml omits
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadSources from murmur.toml [[sources]]", () => {
  test("reads enabled folder sources, expands ~/ , skips disabled", () => {
    const dir = tmpRepo({
      "murmur.toml": `
[[sources]]
name = "jpr"
type = "folder"
root = "~/JPR"
glob = "*/*.m4a"
storage = "icloud"
enabled = true
timestamp = { from = "path", pattern = "(\\\\d{4})-(\\\\d{2})-(\\\\d{2})/(\\\\d{2})-(\\\\d{2})-(\\\\d{2})" }

[[sources]]
name = "disabled-one"
type = "folder"
root = "~/D"
glob = "*.m4a"
enabled = false
timestamp = { from = "path", pattern = "x" }
`,
    });
    try {
      const sources = loadSources({ repoDir: dir } as unknown as Config);
      expect(sources).toHaveLength(1);
      expect(sources[0]!.name).toBe("jpr");
      expect(sources[0]!.root).toBe(join(HOME, "JPR")); // ~/ expanded
      expect(sources[0]!.storage).toBe("icloud");
      expect(sources[0]!.timestamp.pattern).toBe("(\\d{4})-(\\d{2})-(\\d{2})/(\\d{2})-(\\d{2})-(\\d{2})");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("murmur.toml with no [[sources]] yields no sources (import unconfigured, not an error)", () => {
    const dir = tmpRepo({ "murmur.toml": `meetings_base = "~/X"\n[summary]\nmodel = "m"\n` });
    try {
      expect(loadSources({ repoDir: dir } as unknown as Config)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secrets_command (a shell hook in murmur.toml)", () => {
  test("runs the command and captures the env it exports — no config.sh needed", () => {
    const dir = tmpRepo({ "murmur.toml": `meetings_base = "/p"\nsecrets_command = 'export HF_TOKEN=tok-from-cmd'\n\n[summary]\nmodel = "m"\n` });
    try {
      expect(loadConfig(dir).hfToken).toBe("tok-from-cmd");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("accepts an array of commands", () => {
    const dir = tmpRepo({ "murmur.toml": `meetings_base = "/p"\nsecrets_command = ["export FOO=ignored", "export HF_TOKEN=arr-tok"]\n\n[summary]\nmodel = "m"\n` });
    try {
      expect(loadConfig(dir).hfToken).toBe("arr-tok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a benign failure (missing file in the command) doesn't abort startup", () => {
    const dir = tmpRepo({ "murmur.toml": `meetings_base = "/p"\nsecrets_command = '[ -f /no/such/file ] && source /no/such/file'\n\n[summary]\nmodel = "m"\n` });
    try {
      // The command exits non-zero, but printf is the final statement so the load still succeeds.
      expect(loadConfig(dir).meetingsBase).toBe("/p");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("configAsEnv (print-env round-trip)", () => {
  test("emits non-empty keys as strings; drops empties", () => {
    const dir = tmpRepo({ "murmur.toml": `meetings_base = "/p"\nport = 7461\n[summary]\nmodel = "m"\n[asr]\ndiarize = true\nhf_token = "t"\n` });
    try {
      const env = configAsEnv(loadConfig(dir));
      expect(env.MEETINGS_BASE).toBe("/p");
      expect(env.MURMUR_PORT).toBe("7461"); // number → string
      expect(env.DIARIZE).toBe("1"); // bool → "1"
      expect(env.OBSIDIAN_VAULT).toBeUndefined(); // empty vault root omitted
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
