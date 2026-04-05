import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import type { MnemoConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = resolve(homedir(), ".mnemo", "config.json");

function expandHome(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

function createDefaultConfig(configPath: string): MnemoConfig {
  const syncFolder = detectSyncFolder();
  mkdirSync(syncFolder, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });

  const config: MnemoConfig = {
    db_path: resolve(syncFolder, "mnemo.db"),
    ollama_url: "http://localhost:11434",
    ollama_model: "nomic-embed-text",
    cowork_data_dir: resolve(homedir(), "Library", "Application Support", "Claude", "cowork"),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    profile_build_interval: 5,
    compression_keep_full_days: 7,
    compression_keep_summary_days: 30,
    telegram: {
      enabled: false,
      bot_token: "",
      user_id: "",
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return config;
}

export function loadConfig(
  configPath?: string
): MnemoConfig {
  const p = configPath || process.env.MNEMO_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const resolved = expandHome(p);

  if (!existsSync(resolved)) {
    return createDefaultConfig(resolved);
  }

  const raw = JSON.parse(readFileSync(resolved, "utf-8")) as MnemoConfig;

  // Expand ~ in paths
  raw.db_path = expandHome(raw.db_path);
  raw.cowork_data_dir = expandHome(raw.cowork_data_dir);
  if (raw.log_file) raw.log_file = expandHome(raw.log_file);

  return raw;
}

/** Detect the best sync folder for mnemo.db */
export function detectSyncFolder(): string {
  const home = homedir();
  const candidates = [
    resolve(home, "Dropbox", "Mnemo"),
    resolve(home, "Google Drive", "My Drive", "Mnemo"),
    resolve(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Mnemo"),
  ];

  // Also check CloudStorage for Google Drive variants
  const cloudStorage = resolve(home, "Library", "CloudStorage");
  if (existsSync(cloudStorage)) {
    try {
      const { readdirSync } = require("fs");
      for (const dir of readdirSync(cloudStorage) as string[]) {
        if (dir.startsWith("GoogleDrive-")) {
          candidates.splice(
            2,
            0,
            resolve(cloudStorage, dir, "My Drive", "Mnemo")
          );
        }
      }
    } catch {
      // ignore
    }
  }

  for (const candidate of candidates) {
    const parent = resolve(candidate, "..");
    if (existsSync(parent)) {
      return candidate;
    }
  }

  // Fallback
  return resolve(home, ".mnemo");
}
