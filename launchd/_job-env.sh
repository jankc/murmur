#!/usr/bin/env bash
# Shared launchd-job bootstrap, sourced by run-daemon.sh and run-import.sh so the
# bun-resolution + config-resolution + logdir contract lives in exactly one place (it used to
# be copy-pasted into both entrypoints and drifted independently). Sets REPO_DIR, PATH, BASE,
# and LOGDIR (and creates LOGDIR); the caller then execs its entrypoint with stdout/stderr
# redirected into $LOGDIR.
#
# Sourced, not run: it relies on the caller's $0 to locate the repo, so the caller does
# `source "$(dirname "$0")/_job-env.sh"` and $0 stays the entrypoint's own path.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR/src"

# Resolve bun robustly: prepend the stable mise shims (a version-pinned mise path in the plist
# can vanish when mise GCs an old bun) ahead of whatever the plist PATH provides.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# Pull the resolved config in as env. Non-fatal on failure: the engine's own loadConfig (in the
# exec the caller runs) re-reads the same config and surfaces any real error into the log.
ENV_EXPORTS="$(bun run "$REPO_DIR/src/cli.ts" print-env 2>/dev/null)" && eval "$ENV_EXPORTS"

BASE="${MEETINGS_BASE:-$HOME/Recordings/Meetings}"
LOGDIR="$BASE/logs"
mkdir -p "$LOGDIR"
