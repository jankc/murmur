#!/usr/bin/env bash
# Thin wrapper kept for backwards compatibility — delegates to process.sh.
set -euo pipefail
exec "$(dirname "$0")/process.sh" "$@"