#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ]; then
    echo "Usage: import.sh <export-file.json>"
    exit 1
fi

INPUT="$1"
CONFIG="$HOME/.mnemo/config.json"

if [ ! -f "$INPUT" ]; then
    echo "Import file not found: $INPUT"
    exit 1
fi

if [ ! -f "$CONFIG" ]; then
    echo "Config not found at $CONFIG. Run /mnemo:setup first."
    exit 1
fi

DB_PATH=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf-8'));
  console.log(cfg.db_path.replace('~', process.env.HOME));
")

echo "=== Mnemo Import ==="
echo "Source:   $INPUT"
echo "Database: $DB_PATH"
echo ""
echo "WARNING: This will MERGE data into the existing database."
echo "Existing rows with matching IDs will be skipped."
read -p "Continue? (y/N) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

node -e "
  const Database = require('better-sqlite3');
  const fs = require('fs');

  const data = JSON.parse(fs.readFileSync('$INPUT', 'utf-8'));
  const db = new Database('$DB_PATH');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  console.log('Import file from: ' + data.exported_at);
  console.log('');

  // Import order matters for foreign keys
  const importOrder = [
    'mnemo_meta',
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
  ];

  for (const table of importOrder) {
    const rows = data.tables[table];
    if (!rows || rows.length === 0) {
      console.log('  ' + table + ': no data');
      continue;
    }

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + placeholders + ')'
    );

    let imported = 0;
    const tx = db.transaction(() => {
      for (const row of rows) {
        const values = cols.map(c => row[c]);
        const result = stmt.run(...values);
        if (result.changes > 0) imported++;
      }
    });

    tx();
    console.log('  ' + table + ': ' + imported + '/' + rows.length + ' rows imported');
  }

  db.close();
  console.log('');
  console.log('Import complete.');
"

echo "=== Done ==="
