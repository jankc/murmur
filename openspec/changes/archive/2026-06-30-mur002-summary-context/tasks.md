## 1. CLI input plumbing

- [x] 1.1 Add a `resolveContext(value: string | undefined): Promise<string | undefined>` helper in `src/cli.ts`: returns `undefined` when the flag is absent; for `@<path>` read the file; for `-` read `Bun.stdin` to EOF (printing a one-line prompt first when `process.stdin.isTTY`); otherwise return the literal value.
- [x] 1.2 Add a `saveContext(folder: string, text: string): Promise<void>` helper: trim the text; if empty/whitespace, no-op (no write, leave any existing `context.md` untouched); else `mkdirSync(folder, { recursive: true })` and write `join(folder, "context.md")` (use `ARTIFACTS`/a `context` entry — see 3.1). Print a one-line `context saved → <path>` confirmation on write.
- [x] 1.3 Add a `VALUE_FLAGS` set (`--context`, `-c`, `--device`, `-d`) and update `positional()` to skip a value-flag together with its following value when scanning, so a `--context` value before the positional is not mistaken for it.

## 2. Wire `--context` into the five commands

- [x] 2.1 `record`: read `flag("--context") ?? flag("-c")`, `resolveContext` it, and after `recorder.start()` returns the base, `saveContext(join(cfg.paths.partialDir, base), text)` so it travels with the `.partial`→`inbox` rename.
- [x] 2.2 `process`: after `wav` is resolved (and non-null), `saveContext(dirname(wav), text)` before `dispatchWav(wav)`.
- [x] 2.3 `reprocess`: after `wav` is resolved, `saveContext(dirname(wav), text)` before `reprocessInline(wav)`.
- [x] 2.4 `transcribe`: after `wav` is resolved, `saveContext(dirname(wav), text)` (it produces no summary, but persists for a later `summarize`).
- [x] 2.5 `summarize`: after `txt` (transcript path) is resolved, `saveContext(dirname(txt), text)` before calling `summarize()`.

## 3. Prompt assembly + injection (summary step only)

- [x] 3.1 Add a `context: "context.md"` entry to `ARTIFACTS` in `src/paths.ts`.
- [x] 3.2 In `src/engines/ollama.ts`, extract prompt assembly into a pure exported `assembleSummaryPrompt({ baseRules, typePrompt, context, transcript }): string` that joins the sections and inserts a `--- KONTEXT OD UŽIVATELE ---` section between the type prompt and `--- TRANSCRIPT ---` **only when `context` is non-empty** (no empty delimiters when absent).
- [x] 3.3 In `summarize()`, read `join(folder, ARTIFACTS.context)` (tolerating absence → `""`), pass it to `assembleSummaryPrompt`, and `log.info("ollama", …)` when context was applied. Leave `classify()`/triage and the transcribe path unchanged.

## 4. Prompt instruction

- [x] 4.1 Add a short Czech paragraph to `prompts/base.md` describing the optional `--- KONTEXT OD UŽIVATELE ---` section: use it to resolve speaker identities / topics / acronyms for accuracy; do not echo it verbatim, do not treat it as transcript content, never invent beyond it.

## 5. Tests

- [x] 5.1 Unit-test `assembleSummaryPrompt`: context present → output contains the delimited section before the transcript; context absent/whitespace → no context delimiter appears.
- [x] 5.2 Unit-test `resolveContext`: literal passthrough; `@file` reads file contents; absent flag → `undefined` (stdin `-` may be covered with a piped fixture if practical).
- [x] 5.3 Unit-test `saveContext`: non-empty writes `<folder>/context.md`; empty/whitespace writes nothing and leaves an existing `context.md` intact; re-supplying replaces the file.
- [x] 5.4 End-to-end sanity: `murmur summarize <base> --context "…"` persists `context.md` and a subsequent `reprocess <base>` (no flag) still injects it.

## 6. Docs

- [x] 6.1 Document the `--context`/`-c` flag (three input modes; persisted per recording; summary-only; reused on re-runs) in the `USAGE` string in `src/cli.ts` and in `README.md`.
