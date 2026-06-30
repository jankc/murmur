## Context

Summaries are produced from the transcript alone. `summarize()` in `src/engines/ollama.ts`
classifies the recording (triage) and assembles `prompts/base.md` + `prompts/types/<type>.md` +
the transcript, with nothing the user knows that the transcript can't carry: who each
`SPEAKER_NN` is, what the meeting is about, project acronyms. There is no channel for that
knowledge today.

`mur001-per-recording-folders` (archived) made each recording a self-contained folder whose
location encodes its state, holding every artifact (`recording.<ext>`, `transcript.txt`,
`summary.md`, `asr.log`) named by role via `ARTIFACTS` in `src/paths.ts`. That folder is the
natural home for per-recording context.

Five commands can target a recording: `record` (stages a folder in `recordings/.partial/<base>/`,
then atomically renames it into `inbox/`; its summary happens later in the daemon),
`process`/`reprocess`/`transcribe` (resolve a recording file via `resolveWav`, whose
`dirname()` is the folder), and `summarize` (takes a transcript path / basename). Context must be
settable from each, persisted in the folder, and consumed **only** at the summary step. The
daemon already reads everything it needs from the folder, so a folder-resident context file needs
no protocol change.

## Goals / Non-Goals

**Goals:**
- One `--context` / `-c` flag with three value-encoded input modes (literal, `@path`, `-` stdin)
  on `record`, `process`, `reprocess`, `transcribe`, `summarize`.
- Persist the resolved text as `<folder>/context.md`; durable, travels with the folder, reused on
  later `summarize`/`reprocess` with no flag re-specified; re-supplying replaces it.
- Inject context into the **summary prompt only**, as a clearly delimited section before the
  transcript, with a `base.md` instruction telling the model how to use it.
- Fix positional parsing so a `--context` value is never mistaken for the positional argument.

**Non-Goals:**
- No context for triage/classification or for transcription (explicitly out of scope).
- No structured / per-speaker context — free text only.
- No global or config-file default context; context is strictly per recording.
- No dedicated edit/remove subcommand. Overwrite by re-supplying `--context`; removal piggybacks on
  `purge` / deleting the folder (which already removes the whole folder wholesale).
- No daemon API / queue-protocol change.

## Decisions

**1. Folder-resident `context.md` is the single source of truth.**
Persist context as `context.md` inside the recording's folder rather than threading it through the
daemon's enqueue payload or a separate `context/<base>.md` store. Because the folder *is* the
recording's state (mur001), persistence, durability, travel-with-the-folder, daemon pickup, reuse
on re-runs, and removal-on-`purge` all fall out for free, and the daemon needs no protocol change —
it reads `context.md` from the folder at summary time. *Alternative (queue field):* rejected —
transient, lost on `reprocess`, needs an API change, and awkward across the `record`→daemon handoff.

**2. One flag, value-encoded input mode.** A single `--context`/`-c` whose value selects the mode:
a literal string, `@<path>` to read a file, or `-` to read stdin to EOF. Mirrors common CLI
convention (curl-style `@file`, `-` for stdin) and keeps one flag to document. A shared
`resolveContext(value)` helper returns the resolved string (or `undefined` when the flag is
absent). For `-`, read `Bun.stdin` to EOF; when stdin is a TTY, print a one-line prompt first so
the same mode doubles as interactive "type it, then Ctrl-D" entry and as a pipe target.

**3. Resolve-then-save, before the work runs, into the right folder.** A `saveContext(folder, text)`
helper `mkdir -p`s the folder and writes `context.md`, trimming first; **empty/whitespace input is a
no-op** (no write, existing file untouched). Each command resolves its target folder and calls
`saveContext` *before* dispatching work, so the just-written `context.md` is what `summarize` reads:
- `record` → `join(cfg.paths.partialDir, base)` using the base returned by `recorder.start()`; the
  atomic `.partial`→`inbox` folder rename carries `context.md` with it, and the daemon's later
  summary reads it.
- `process` / `reprocess` / `transcribe` → `dirname(resolvedWav)`.
- `summarize` → `dirname(transcript)`.
Re-supplying `--context` overwrites the file (replace semantics, per spec).

**4. Pure, testable prompt-assembly helper.** Extract the prompt build in `summarize()` into a pure
`assembleSummaryPrompt({ baseRules, typePrompt, context, transcript })` that returns the joined
string and inserts a `--- KONTEXT OD UŽIVATELE ---` section **between the type prompt and the
`--- TRANSCRIPT ---` block** only when `context` is non-empty (no empty delimiters when absent).
`summarize()` reads `join(folder, "context.md")`, passes it in, and logs (`log.info("ollama", …)`)
when context was applied. The triage `classify()` prompt is left untouched.

**5. `base.md` instruction.** Add a short Czech paragraph stating that an optional
`--- KONTEXT OD UŽIVATELE ---` section may precede the transcript; use it to resolve speaker
identities, topics, and acronyms for accuracy; do not echo it verbatim, do not treat it as
transcript content, and never invent beyond it.

**6. `positional()` skips value-taking flags.** Today `positional()` returns the first arg not
starting with `-`, so `murmur summarize --context "SPEAKER_00 = Petr" mymeeting` would wrongly
return the context text. Introduce a `VALUE_FLAGS` set (`--context`, `-c`, and harmlessly
`--device`, `-d`) and skip a value-flag together with its following value when scanning for the
positional. `flag()` (retrieval) already works; only the positional scan changes.

## Risks / Trade-offs

- **`--context -` on a non-TTY with nothing piped blocks forever** → only read stdin when the value
  is exactly `-`; on a TTY print the waiting prompt; document Ctrl-D. It is an explicit opt-in mode.
- **`record` writes into `.partial/<base>/` around the time the recorder creates it (race)** →
  `saveContext` does `mkdir -p` on the identical path; the atomic rename happens only at
  stop/finalize, long after, so there is no collision and no lost file.
- **A stale `context.md` silently re-applies on a much later `reprocess`** → that is the intended
  reuse semantics; replace by re-supplying `--context`, remove by deleting the folder / `purge`.
  Documented, accepted.
- **Context could pull the model off the transcript or invite hallucination** → constrained by the
  `base.md` instruction (use for accuracy, never invent) and the existing `temperature: 0`. Residual
  risk accepted.
- **A very large `@file` / pasted context inflates the prompt** → context is prepended like the
  transcript already is; no hard cap in v1 (possible follow-up: log/trim length).
- **`summarize` given a raw transcript path outside a recording folder** → `context.md` simply won't
  exist there and injection is skipped; no breakage.

## Migration Plan

Purely additive. No data migration: `context.md` is optional and absent for every existing
recording, so injection no-ops for them. No config changes, no daemon protocol change. Rollback is
a code revert; any `context.md` files already written are inert without the reader.

## Open Questions

- Cap or trim very large context before sending to the model? Deferred — no cap in v1; logging the
  applied length is a cheap first step.
- Print a one-line `context saved → <path>` confirmation for discoverability? Leaning yes (folded
  into tasks as a minor UX line); harmless and aids debugging.
