#!/usr/bin/env bash
set -euo pipefail
# Remove murmur's installed bits. Leaves your data, config, venv, and the ownscribe binary
# in place (remove those by hand if you really want them gone — see the note below).

LABEL="com.jank.murmur.daemon"

echo "==> stopping + removing the daemon"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "    (daemon was not loaded)"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"

echo "==> removing the CLI symlink"
rm -f "$HOME/.local/bin/murmur"

echo
echo "==> done. Left in place (remove by hand if desired):"
echo "    - recordings/transcripts/summaries:  \$MEETINGS_BASE"
echo "    - config:                            murmur.toml"
echo "    - ASR venv:                          ~/.local/share/murmur/asr-venv"
echo "    - capture binary:                    ~/.local/bin/ownscribe-audio"
