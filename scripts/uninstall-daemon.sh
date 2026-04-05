#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.mnemo.daemon.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=== Uninstalling Mnemo Daemon ==="

if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm "$PLIST_PATH"
    echo "Daemon uninstalled."
else
    echo "Daemon plist not found. Nothing to do."
fi
