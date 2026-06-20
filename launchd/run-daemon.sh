#!/usr/bin/env bash
# launchd entrypoint for the murmur daemon.
#
# launchd does no variable expansion in plists, so StandardOutPath/StandardErrorPath
# can't reference $MEETINGS_BASE. Instead, this wrapper sources config.sh — the single
# source of truth — derives the log location from MEETINGS_BASE, and execs the daemon
# with stdout/stderr redirected there. `exec` replaces this shell with bun, so there's
# no lingering process and launchd's KeepAlive tracks the daemon directly.
#
# Relocating the meetings base is then just: edit config.sh + restart the daemon.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Source config.sh the same lenient way config.ts does (no set -e: a benign non-zero
# line, e.g. an absent secrets cache, must not abort startup).
# shellcheck source=/dev/null
[ -f "$REPO_DIR/config.sh" ] && . "$REPO_DIR/config.sh"

BASE="${MEETINGS_BASE:-$HOME/Recordings/Meetings}"
LOGDIR="$BASE/logs"
mkdir -p "$LOGDIR"

cd "$REPO_DIR/src"
# bun resolves from the PATH set in the plist's EnvironmentVariables.
exec bun run "$REPO_DIR/src/main.ts" >>"$LOGDIR/daemon.out.log" 2>>"$LOGDIR/daemon.err.log"
