#!/usr/bin/env bash
set -euo pipefail

CONFIG="$HOME/.mnemo/config.json"

if [ ! -f "$CONFIG" ]; then
    echo "Config not found at $CONFIG"
    exit 1
fi

# Use node to read config since it's JSON
DB_PATH=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
  console.log(cfg.db_path.replace('~', process.env.HOME));
")

if [ ! -f "$DB_PATH" ]; then
    echo "Database not found at $DB_PATH"
    exit 1
fi

OUTPUT="${1:-mnemo-export-$(date +%Y%m%d-%H%M%S).json}"

echo "=== Mnemo Export ==="
echo "Database: $DB_PATH"
echo "Output:   $OUTPUT"

# Export all tables as JSON
node -e "
  const Database = require('better-sqlite3');
  const fs = require('fs');

  const db = new Database('$DB_PATH', { readonly: true });

  const tables = [
    'profile',
    'profile_history',
    'profile_builds',
    'episodes',
    'entities',
    'entity_relations',
    'sessions',
    'conversation_chunks',
    'scheduled_tasks',
    'task_runs',
    'messages',
    'mnemo_meta',
  ];

  const data = {
    exported_at: new Date().toISOString(),
    version: '0.1.0',
    tables: {},
  };

  for (const table of tables) {
    try {
      const rows = db.prepare('SELECT * FROM ' + table).all();
      data.tables[table] = rows;
      console.log('  ' + table + ': ' + rows.length + ' rows');
    } catch (e) {
      console.log('  ' + table + ': skipped (' + e.message + ')');
    }
  }

  fs.writeFileSync('$OUTPUT', JSON.stringify(data, null, 2));
  db.close();
  console.log('');
  console.log('Exported to $OUTPUT');
"

echo "=== Done ==="
