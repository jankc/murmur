#!/usr/bin/env bash
set -euo pipefail
# Remove murmur's installed bits. Leaves your data, config, venv, and the ownscribe binary
# in place (remove those by hand if you really want them gone — see the note below).

echo "==> stopping + removing the LaunchAgents (daemon + import)"
for LABEL in com.jank.murmur.daemon com.jank.murmur.import; do
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || echo "    ($LABEL was not loaded)"
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
done

echo "==> removing the CLI symlink"
rm -f "$HOME/.local/bin/murmur"

echo
echo "==> done. Left in place (remove by hand if desired):"
echo "    - recordings/transcripts/summaries:  \$MEETINGS_BASE"
echo "    - config:                            murmur.toml"
echo "    - ASR venv:                          ~/.local/share/murmur/asr-venv"
echo "    - capture binary:                    ~/.local/bin/ownscribe-audio"
