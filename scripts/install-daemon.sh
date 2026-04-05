#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
DAEMON_DIR="$PLUGIN_DIR/daemon"
PLIST_NAME="com.mnemo.daemon.plist"
PLIST_SRC="$DAEMON_DIR/launchd/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=== Installing Mnemo Daemon ==="

# Build daemon
cd "$DAEMON_DIR"
npm install
npm run build

# Resolve node path
NODE_PATH=$(which node)

# Create plist with resolved paths
sed -e "s|MNEMO_DAEMON_DIR|$DAEMON_DIR|g" \
    -e "s|/usr/local/bin/node|$NODE_PATH|g" \
    "$PLIST_SRC" > "$PLIST_DST"

# Expand ~ in plist
sed -i '' "s|~/|$HOME/|g" "$PLIST_DST"

# Load
launchctl load "$PLIST_DST"

echo "Daemon installed and started."
echo "Check status: launchctl list | grep mnemo"
