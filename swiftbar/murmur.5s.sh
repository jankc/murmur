#!/usr/bin/env bash
# SwiftBar plugin for murmur. The daemon renders the entire menu (status + actions)
# at GET /swiftbar, so this is just a fetch. Change PORT if you set MEETING_AI_PORT.
PORT=7461
OUT="$(curl -fsS "http://127.0.0.1:$PORT/swiftbar" 2>/dev/null || true)"
if [[ -n "$OUT" ]]; then
  echo "$OUT"
else
  printf '⚪\n---\nmurmur daemon offline\n'
fi
