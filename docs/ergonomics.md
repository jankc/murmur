# murmur — ergonomics backlog

Prioritized improvements from a whole-codebase ergonomics audit (2026-06-20). Checkboxes
track status. "Quick wins 1–6" are the first implementation batch.

Already shipped this session (not listed below): vendored capture helper (`capture/`),
upstream sync tooling, `MEETINGS_BASE`→log-path launchd wrapper, data relocation + `.stignore`.

## 🎯 Quick wins (high value, low effort) — ✅ shipped 2026-06-20

- [x] **1. Daemon lifecycle commands** — `murmur restart` / `start` / `stop` / `install`,
  scripting the `launchctl bootout`/`bootstrap` dance. `cli.ts:86-194`
- [x] **2. Human-readable `status`** (default) + `--json` for machines. Add daemon up/down,
  current-job elapsed time (`startedAt` is stored, never shown), and failed count.
  `cli.ts:107-115`, `status.ts:10-33`, `jobstate.ts:34-38`
- [x] **3. `murmur reprocess <name>` + `murmur retry-failed`** — one command instead of
  manually `mv`-ing a wav out of `failed/`/`processed/`. `cli.ts:138-152`, `failures.ts:18`
- [x] **4. Surface failures** — `failedCount` in `status`/snapshot + a `⚠️ N failed` SwiftBar
  row. `status.ts`, `swiftbar.ts:20-37`
- [x] **5. Docs accuracy** — (a) README's `ollama pull gemma4:26b-mlx` is unpullable; document
  the `*-mlx` models as custom local models. (b) Errors point to a nonexistent
  "README → ASR engine" anchor. (c) `config.sh.example` omits `OLLAMA_HOST`/`PROMPT_FILE`,
  lists phantom `AUTORECORD`/`MEETING_APPS`. `README.md`, `asr.ts:61`, `asr.py:4`, `config.sh.example`
- [x] **6. Exit-code & feedback hygiene** — `stop` exits 0 on failure; `pause`/`resume` print
  success without checking the daemon response; `-h`/`--help` exits 1. `cli.ts:101-194`

## Bigger ergonomic wins (M-effort) — ✅ shipped 2026-06-20

> Notes: the per-stage **timeout** shipped (`PROCESS_TIMEOUT_SECONDS` routes a wedged ASR/ollama
> job to `failed/`), but the poison-job **attempts-cap** was intentionally left out — hard-pause
> requeue is user-driven, and timeouts already unblock the queue. Log correlation: ollama gained a
> per-recording error log (`summary-<base>.log`) + `murmur logs`; universal basename-prefixing of
> every log line was deferred (most lines already carry the basename).

- [x] **Setup/uninstall helper** — idempotent `scripts/setup.sh` + `uninstall.sh`, replacing
  ~12 manual steps; no uninstall path exists today. `README.md:15-43`
- [x] **`murmur doctor`** — preflight venv / ffmpeg / ollama+model-present / ownscribe /
  HF_TOKEN; reuse in `selfCheck`. Auto-catches a missing summary model. `daemon.ts:104-117`
- [x] **Plist portability** — 5× hardcoded `/Users/jank` paths and a brittle mise `latest` bun
  path (vanishes on bun GC → daemon silently won't launch). Ship `.plist.example` with
  placeholders; resolve bun via `mise which bun`. `plist:14,18,30`, `run-daemon.sh`
- [x] **Empty-result clarity** — a no-speech recording notifies "Summary ready" and silently
  skips the vault. Warn "⚠️ no speech detected" instead. `worker.ts:107-111`, `asr.ts:39-43`, `archive.ts:28-31`
- [x] **Per-stage timeout** (+ poison-job cap deferred — see note above) — no wall-clock timeout on the ASR child or ollama
  fetch; hard-pause `requeueFront`s a wedged job forever (`attempts` incremented, never read).
  `ollama.ts:52`, `asr.ts:80`, `worker.ts:142-147`, `queue.ts:86-92`
- [x] **Log correlation** (per-recording ollama log + `murmur logs`; full prefixing deferred) — daemon log interleaves all jobs; ollama has no per-recording log
  (README claims each stage does). Prefix log lines with basename; add `murmur logs [-f]`.
  `log.ts`, `cli.ts`, `ollama.ts`

## Smaller papercuts (S-effort, lower impact)

- [ ] Notifications: unconfigurable (no `NOTIFY=0`), silent if `terminal-notifier` missing (not
  in `selfCheck`), no done/fail/recover events. `notify.ts`, `worker.ts`
- [ ] `summarize` lacks the "newest" default that `process`/`transcribe` have. `cli.ts:165-167`
- [ ] Czech-only default prompt + `PROMPT_FILE` knob undocumented. `prompts/summary.md`, `config.ts:143`
- [ ] Unpinned `pyannote>=4`; no `asr/requirements.txt`; venv path duplicated 3×. `asr.py`, `README.md:28-30`
- [ ] Non-copy-pasteable re-run hint in `process-failures.log`. `failures.ts:18`
- [ ] Scattered dir-creation vs one `ensureLayout(cfg)`. `daemon.ts:16-27`
- [ ] `-d`/`--device` undocumented; fragile hand-rolled flag parser. `cli.ts:34-40,93`
- [ ] Optional root `package.json` so dev cmds don't require `cd src`. `README.md:171-176`

## Whole-repo Codex review follow-ups (deferred — need a design call)

From the 2026-06-20 full-repo pass (base = root commit). The four clean-fix findings were
fixed (data-loss on finalize, control-API CSRF, external-path move guard, archive seconds);
these two need a decision before patching:

- [ ] **Enforce MAX_DURATION for ownscribe without the daemon** — `murmur record` detaches and
  only the (normally always-on) daemon's `finalizeOrphans()` enforces the cap; ownscribe-audio
  has no `--max-duration` flag. Options: add one to the vendored Swift, a CLI-side watchdog, or
  document the daemon dependency. `recorder.ts:104`
- [ ] **Crash-consistent move/dequeue in the worker** — a crash between `move(processed)` and
  `commitDequeue()` can flip a completed job into a `failed/` one on restart. Narrow window; the
  fix (reorder, or detect already-processed in `recover()`) has its own trade-offs. `worker.ts:107`
