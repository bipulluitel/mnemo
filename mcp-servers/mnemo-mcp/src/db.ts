import Database from "better-sqlite3";
import { existsSync } from "fs";
import { loadConfig, initDatabase, openDatabase } from "@mnemo/shared";
import type { MnemoConfig } from "@mnemo/shared";

let db: Database.Database | null = null;
let config: MnemoConfig | null = null;

export function getConfig(): MnemoConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

export function getDb(): Database.Database {
  if (!db) {
    const cfg = getConfig();
    if (!existsSync(cfg.db_path)) {
      db = initDatabase(cfg.db_path);
    } else {
      db = openDatabase(cfg.db_path);
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
