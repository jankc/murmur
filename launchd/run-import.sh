#!/usr/bin/env bash
# launchd entrypoint for the periodic `murmur import` job (every 10 min, see the plist).
#
# Mirrors run-daemon.sh but for a one-shot command: _job-env.sh resolves the config
# (murmur.toml) via `murmur print-env` and derives the log location from MEETINGS_BASE; this
# script then execs `murmur import` with stdout/stderr redirected there. `exec` replaces this
# shell with bun, so there's no lingering process and launchd tracks the import directly. The
# job runs to completion and exits; launchd re-fires it on the next StartInterval tick.
#
# Relocating the meetings base is then just: edit murmur.toml (the import agent picks it up
# on the next tick — no restart needed).

source "$(dirname "$0")/_job-env.sh"

exec bun run "$REPO_DIR/src/cli.ts" import >>"$LOGDIR/import.out.log" 2>>"$LOGDIR/import.err.log"
