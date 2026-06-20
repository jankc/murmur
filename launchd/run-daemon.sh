#!/usr/bin/env bash
# launchd entrypoint for the murmur daemon.
#
# launchd does no variable expansion in plists, so StandardOutPath/StandardErrorPath can't
# reference $MEETINGS_BASE. This wrapper resolves the config — murmur.toml (the single source of
# truth) or the legacy config.sh — via `murmur print-env`, derives the log location from
# MEETINGS_BASE, and execs the daemon with stdout/stderr redirected there. `exec` replaces this
# shell with bun, so there's no lingering process and launchd's KeepAlive tracks the daemon
# directly.
#
# Relocating the meetings base is then just: edit murmur.toml + restart the daemon.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR/src"

# Resolve bun robustly: prepend the stable mise shims (a version-pinned mise path in the plist
# can vanish when mise GCs an old bun) ahead of whatever the plist PATH provides.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:$PATH"

# Pull the resolved config in as env. Non-fatal on failure: the daemon's own loadConfig (in the
# exec below) re-reads the same config and surfaces any real error into the log.
ENV_EXPORTS="$(bun run "$REPO_DIR/src/cli.ts" print-env 2>/dev/null)" && eval "$ENV_EXPORTS"

BASE="${MEETINGS_BASE:-$HOME/Recordings/Meetings}"
LOGDIR="$BASE/logs"
mkdir -p "$LOGDIR"

exec bun run "$REPO_DIR/src/main.ts" >>"$LOGDIR/daemon.out.log" 2>>"$LOGDIR/daemon.err.log"
