// Best-effort macOS notifications via terminal-notifier, mirroring scripts/process.sh.
// Never throws — notifications are nice-to-have, not load-bearing.
import type { Config } from "./config.ts";
import { log } from "./log.ts";

export function notify(cfg: Config, message: string): void {
  try {
    Bun.spawn(["terminal-notifier", "-title", "murmur", "-message", message, "-sound", "default"], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PATH: cfg.childPath },
    });
  } catch (err) {
    log.warn("notify", `terminal-notifier failed: ${String(err)}`);
  }
}
