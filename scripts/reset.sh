#!/usr/bin/env bash
set -euo pipefail

CONFIG="$HOME/.mnemo/config.json"

if [ ! -f "$CONFIG" ]; then
    echo "Config not found at $CONFIG. Nothing to reset."
    exit 1
fi

DB_PATH=$(node -e "console.log(require('$CONFIG').db_path.replace('~', process.env.HOME))")

echo "=== Mnemo Reset ==="
echo "This will DELETE the database at: $DB_PATH"
echo "Config will be preserved."
read -p "Are you sure? (y/N) " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm -f "$DB_PATH" "${DB_PATH}-wal" "${DB_PATH}-shm"
    echo "Database deleted. Run /mnemo:setup to reinitialize."
else
    echo "Cancelled."
fi
