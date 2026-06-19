#!/usr/bin/env bash
# SwiftBar plugin for murmur. Rendering + actions live in the CLI (`murmur swiftbar`),
# which reads state from disk and works whether or not the daemon is running.
MURMUR="$(command -v murmur || echo "$HOME/.local/bin/murmur")"
OUT="$("$MURMUR" swiftbar 2>/dev/null || true)"
if [[ -n "$OUT" ]]; then
  printf '%s' "$OUT"
else
  printf '⚪\n---\nmurmur unavailable\n'
fi
