/**
 * Sync folder validation and conflict handling.
 *
 * When mnemo.db lives in a synced folder (Dropbox, Google Drive, iCloud),
 * we need to handle:
 * - WAL mode: ensure -wal and -shm files are checkpointed before sync
 * - Lock conflicts: detect if another device has the DB open
 * - Stale locks: clean up leftover lock files from unclean shutdowns
 */

import { existsSync, statSync, unlinkSync } from "fs";
import Database from "better-sqlite3";

export interface SyncStatus {
  dbPath: string;
  exists: boolean;
  sizeBytes: number;
  walExists: boolean;
  walSizeBytes: number;
  shmExists: boolean;
  syncFolder: string | null;
  syncProvider: "dropbox" | "google-drive" | "icloud" | "local" | "unknown";
  lastModified: string;
  healthy: boolean;
  issues: string[];
}

/** Detect which sync provider hosts this path */
export function detectSyncProvider(
  dbPath: string
): "dropbox" | "google-drive" | "icloud" | "local" | "unknown" {
  const lower = dbPath.toLowerCase();
  if (lower.includes("dropbox")) return "dropbox";
  if (lower.includes("google drive") || lower.includes("googledrive"))
    return "google-drive";
  if (lower.includes("mobile documents") || lower.includes("icloud"))
    return "icloud";
  if (lower.includes(".mnemo")) return "local";
  return "unknown";
}

/** Get comprehensive sync status for the database */
export function getSyncStatus(dbPath: string): SyncStatus {
  const issues: string[] = [];
  const walPath = dbPath + "-wal";
  const shmPath = dbPath + "-shm";

  const dbExists = existsSync(dbPath);
  const walExists = existsSync(walPath);
  const shmExists = existsSync(shmPath);

  let sizeBytes = 0;
  let walSizeBytes = 0;
  let lastModified = "";

  if (dbExists) {
    const stat = statSync(dbPath);
    sizeBytes = stat.size;
    lastModified = stat.mtime.toISOString();
  } else {
    issues.push("Database file does not exist");
  }

  if (walExists) {
    const stat = statSync(walPath);
    walSizeBytes = stat.size;

    // Large WAL files can cause sync issues
    if (walSizeBytes > 10 * 1024 * 1024) {
      issues.push(
        `WAL file is large (${(walSizeBytes / 1024 / 1024).toFixed(1)}MB). Consider running a checkpoint.`
      );
    }
  }

  const syncProvider = detectSyncProvider(dbPath);

  // Extract sync folder (parent directory)
  const syncFolder = dbPath.replace(/\/[^/]+$/, "");

  // Check for sync conflict files (Dropbox creates "conflicted copy" files)
  if (dbExists) {
    try {
      const { readdirSync } = require("fs");
      const dir = syncFolder;
      const files = readdirSync(dir) as string[];
      const conflicts = files.filter(
        (f: string) =>
          f.includes("conflicted") ||
          f.includes("conflict") ||
          f.match(/mnemo.*\(\d+\)\.db/)
      );
      if (conflicts.length > 0) {
        issues.push(
          `Sync conflict files detected: ${conflicts.join(", ")}. ` +
            `These should be manually resolved and removed.`
        );
      }
    } catch {
      // ignore
    }
  }

  return {
    dbPath,
    exists: dbExists,
    sizeBytes,
    walExists,
    walSizeBytes,
    shmExists,
    syncFolder,
    syncProvider,
    lastModified,
    healthy: issues.length === 0 && dbExists,
    issues,
  };
}

/**
 * Checkpoint WAL file — merges WAL back into main DB file.
 * This is important for sync: sync providers can't reliably sync
 * DB + WAL + SHM as an atomic unit.
 *
 * Call this periodically (e.g., after session processing) or before
 * the daemon shuts down.
 */
export function checkpointWal(dbPath: string): {
  walPages: number;
  checkpointed: number;
} {
  const db = new Database(dbPath);
  try {
    // TRUNCATE mode: checkpoint and then truncate the WAL file
    const result = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;

    const row = result[0] || { log: 0, checkpointed: 0 };
    return { walPages: row.log, checkpointed: row.checkpointed };
  } finally {
    db.close();
  }
}

/**
 * Clean up stale lock files that might have been left by
 * an unclean shutdown on another device.
 */
export function cleanStaleLocks(dbPath: string): boolean {
  const shmPath = dbPath + "-shm";

  // Only clean up if the main DB exists but isn't currently open
  if (!existsSync(dbPath)) return false;

  try {
    // Try opening the DB exclusively — if it works, any existing
    // lock files are stale
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.close();

    // If -shm exists but DB opened fine, it's safe
    return true;
  } catch {
    // DB is locked by another process — don't touch anything
    return false;
  }
}
