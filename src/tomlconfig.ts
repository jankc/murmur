// Single-file configuration. <repoDir>/murmur.toml is the source for both daemon settings (read by
// config.ts) and import sources (read by sources.ts). It's gitignored, so secrets like the
// HuggingFace token live in it directly (or come from an env override). Parsed via Bun's native
// TOML loader — no dependency.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME ?? "";

/** Expand a leading `~/` (only) to $HOME — TOML does no shell expansion, so paths in the config
 *  carry their own `~`. A literal `~` later in the path (e.g. the `iCloud~com~…` container name)
 *  is left untouched. Non-string / absolute values pass through unchanged. */
export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

/** Parse <repoDir>/murmur.toml, or return null if the file is absent (→ caller uses built-in
 *  defaults). A malformed file throws: a typo in the single source of truth must be loud, not
 *  silently swallowed into all-defaults. */
export function readMurmurToml(repoDir: string): Record<string, unknown> | null {
  const file = join(repoDir, "murmur.toml");
  if (!existsSync(file)) return null;
  try {
    return Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
