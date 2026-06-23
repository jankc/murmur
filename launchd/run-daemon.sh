#!/usr/bin/env bash
# launchd entrypoint for the murmur daemon.
#
# launchd does no variable expansion in plists, so StandardOutPath/StandardErrorPath can't
# reference $MEETINGS_BASE. _job-env.sh resolves the config (murmur.toml) via `murmur print-env`
# and derives the log location from MEETINGS_BASE; this script then execs the daemon with
# stdout/stderr redirected there. `exec` replaces this shell with bun, so there's no lingering
# process and launchd's KeepAlive tracks the daemon directly.
#
# Relocating the meetings base is then just: edit murmur.toml + restart the daemon.

source "$(dirname "$0")/_job-env.sh"

exec bun run "$REPO_DIR/src/main.ts" >>"$LOGDIR/daemon.out.log" 2>>"$LOGDIR/daemon.err.log"
