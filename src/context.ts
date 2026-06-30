// Per-recording user context (the CLI's `--context` flag): resolve the flag value into text and
// persist it as <folder>/context.md so it travels with the recording's folder and is reused by a
// later summary. Lives outside cli.ts (which self-executes on import) so it's unit-testable.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS } from "./paths.ts";

/** Resolve a `--context` value into its text. One flag, three input modes by value convention:
 *  a literal string, `@<path>` to read a file, or `-` to read stdin to EOF (printing a prompt
 *  first on a TTY so it doubles as interactive "type it, then Ctrl-D" entry / a pipe target).
 *  Returns undefined when the flag was not given (so callers can tell "absent" from "empty"). */
export async function resolveContext(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value === "-") {
    if (process.stdin.isTTY) process.stderr.write("Enter context, then Ctrl-D:\n");
    return await Bun.stdin.text();
  }
  if (value.startsWith("@")) return await Bun.file(value.slice(1)).text();
  return value;
}

/** Persist resolved context as <folder>/context.md so it travels with the recording and is reused
 *  by a later summary. Empty/whitespace input is a no-op: no file is written and any existing
 *  context.md is left untouched (returns null). A non-empty value replaces whatever was there and
 *  returns the written path. */
export async function saveContext(folder: string, text: string | undefined): Promise<string | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  mkdirSync(folder, { recursive: true });
  const path = join(folder, ARTIFACTS.context);
  await Bun.write(path, trimmed + "\n");
  return path;
}
