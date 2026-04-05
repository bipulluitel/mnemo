/**
 * sqlite-vec integration layer.
 * Handles loading the extension, creating the virtual table,
 * and storing/querying vector embeddings.
 */

import Database from "better-sqlite3";
import { EMBEDDING_DIMENSIONS } from "./embedder.js";

let vecAvailable: boolean | null = null;

/**
 * Try to load the sqlite-vec extension into a database connection.
 * Returns true if successful, false if the extension is not available.
 * Result is cached after first call.
 */
export function loadVecExtension(db: Database.Database): boolean {
  if (vecAvailable !== null) return vecAvailable;

  try {
    // sqlite-vec ships as a loadable extension
    // Try the npm package first, then system paths
    const candidates = [
      () => {
        // Try to find via require.resolve (npm installed)
        const vecPath = require.resolve("sqlite-vec");
        db.loadExtension(vecPath.replace(/\.js$/, ""));
      },
      () => {
        // Try common extension name
        db.loadExtension("vec0");
      },
      () => {
        // Try with full path on macOS
        db.loadExtension("/usr/local/lib/vec0");
      },
      () => {
        // Homebrew ARM
        db.loadExtension("/opt/homebrew/lib/vec0");
      },
    ];

    for (const tryLoad of candidates) {
      try {
        tryLoad();
        vecAvailable = true;
        return true;
      } catch {
        continue;
      }
    }

    // If none of the extension loading approaches work,
    // try using sqlite-vec's Node.js API
    try {
      const sqliteVec = require("sqlite-vec");
      sqliteVec.load(db);
      vecAvailable = true;
      return true;
    } catch {
      // Not available
    }

    vecAvailable = false;
    return false;
  } catch {
    vecAvailable = false;
    return false;
  }
}

/**
 * Create the vec_memory virtual table if sqlite-vec is available.
 * Safe to call multiple times.
 */
export function initVecTable(db: Database.Database): boolean {
  if (!loadVecExtension(db)) return false;

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
        embedding float[${EMBEDDING_DIMENSIONS}],
        +source_table TEXT,
        +source_id TEXT,
        +created_at TEXT
      );
    `);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store an embedding in the vector table.
 */
export function storeEmbedding(
  db: Database.Database,
  sourceTable: string,
  sourceId: string | number,
  embedding: number[],
  createdAt?: string
): void {
  if (!vecAvailable) return;

  const ts = createdAt || new Date().toISOString();
  const idStr = String(sourceId);

  // Delete any existing embedding for this source
  db.prepare(
    `DELETE FROM vec_memory WHERE source_table = ? AND source_id = ?`
  ).run(sourceTable, idStr);

  // Insert new embedding
  db.prepare(
    `INSERT INTO vec_memory (embedding, source_table, source_id, created_at)
     VALUES (vec_f32(?), ?, ?, ?)`
  ).run(
    new Float32Array(embedding) as unknown as Buffer,
    sourceTable,
    idStr,
    ts
  );
}

/**
 * Query the vector table for similar embeddings.
 * Returns source_table, source_id, and distance (lower = more similar).
 */
export function queryVec(
  db: Database.Database,
  queryEmbedding: number[],
  sourceTable?: string,
  limit: number = 20
): Array<{ source_table: string; source_id: string; distance: number }> {
  if (!vecAvailable) return [];

  try {
    let sql = `
      SELECT source_table, source_id, distance
      FROM vec_memory
      WHERE embedding MATCH vec_f32(?)
    `;
    const params: unknown[] = [
      new Float32Array(queryEmbedding) as unknown as Buffer,
    ];

    if (sourceTable) {
      sql += ` AND source_table = ?`;
      params.push(sourceTable);
    }

    sql += ` ORDER BY distance LIMIT ?`;
    params.push(limit);

    return db.prepare(sql).all(...params) as Array<{
      source_table: string;
      source_id: string;
      distance: number;
    }>;
  } catch {
    return [];
  }
}

/** Check if vector search is available */
export function isVecAvailable(): boolean {
  return vecAvailable === true;
}

/** Reset cached state (for testing) */
export function resetVecState(): void {
  vecAvailable = null;
}
