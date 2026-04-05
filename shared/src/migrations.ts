import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { initVecTable } from "./vec.js";

function getSchema(): string {
  const __dir = dirname(fileURLToPath(import.meta.url));
  // In dev: shared/dist/../src/schema.sql → shared/src/schema.sql
  const paths = [
    resolve(__dir, "..", "src", "schema.sql"),
    resolve(__dir, "schema.sql"),
  ];
  for (const p of paths) {
    try {
      return readFileSync(p, "utf-8");
    } catch {}
  }
  throw new Error("schema.sql not found");
}

const SCHEMA_VERSION = 2;

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL and foreign keys
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Check current version
  let currentVersion = 0;
  try {
    const row = db
      .prepare("SELECT value FROM mnemo_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row) currentVersion = parseInt(row.value, 10);
  } catch {
    // Table doesn't exist yet — fresh DB
  }

  if (currentVersion < SCHEMA_VERSION) {
    applySchema(db);
    upsertMeta(db, "schema_version", String(SCHEMA_VERSION));
    upsertMeta(db, "sessions_since_profile_build", "0");
  }

  // Try to initialize vector table (non-fatal if sqlite-vec not available)
  const vecReady = initVecTable(db);
  upsertMeta(db, "vec_available", vecReady ? "true" : "false");

  return db;
}

function applySchema(db: Database.Database): void {
  const sql = getSchema();

  // Extract PRAGMAs (must run outside transactions)
  const lines = sql.split("\n");
  const pragmas: string[] = [];
  const rest: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith("PRAGMA")) {
      pragmas.push(trimmed);
    } else {
      rest.push(line);
    }
  }

  // Execute pragmas outside transaction
  for (const pragma of pragmas) {
    db.exec(pragma);
  }

  // Execute the rest as a single block — SQLite handles IF NOT EXISTS,
  // and this preserves trigger bodies that contain semicolons
  const schemaBlock = rest.join("\n");
  try {
    db.exec(schemaBlock);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      throw err;
    }
  }
}

function upsertMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO mnemo_meta (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Try to load sqlite-vec on every connection
  initVecTable(db);

  return db;
}
