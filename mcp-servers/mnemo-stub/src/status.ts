import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const HOME = homedir();
const INSTALL_DIR = resolve(HOME, ".mnemo", "install");
const CONFIG_PATH = resolve(HOME, ".mnemo", "config.json");
const SENTINEL = resolve(INSTALL_DIR, ".setup-complete");
const PROGRESS_FILE = resolve(INSTALL_DIR, ".setup-progress");
const FULL_SERVER = resolve(
  INSTALL_DIR,
  "mcp-servers",
  "mnemo-mcp",
  "dist",
  "index.js"
);

export interface MnemoStatus {
  installed: boolean;
  install_path: string;
  config_exists: boolean;
  db_exists: boolean;
  db_path: string | null;
  daemon_loaded: boolean;
  full_server_ready: boolean;
  setup_in_progress: boolean;
  version: string | null;
  node_version: string;
  node_exec_path: string;
}

export async function getStatus(): Promise<MnemoStatus> {
  const installed = existsSync(SENTINEL);
  const configExists = existsSync(CONFIG_PATH);

  let dbPath: string | null = null;
  let dbExists = false;
  if (configExists) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      dbPath = cfg.db_path;
      if (dbPath) {
        const expanded = dbPath.startsWith("~/")
          ? resolve(HOME, dbPath.slice(2))
          : dbPath;
        dbExists = existsSync(expanded);
      }
    } catch {
      // corrupt config
    }
  }

  let daemonLoaded = false;
  try {
    const out = execSync("launchctl list 2>/dev/null", { encoding: "utf-8" });
    daemonLoaded = out.includes("com.mnemo.daemon");
  } catch {
    // launchctl not available or failed
  }

  let version: string | null = null;
  const pkgJson = resolve(INSTALL_DIR, "package.json");
  if (existsSync(pkgJson)) {
    try {
      version = JSON.parse(readFileSync(pkgJson, "utf-8")).version;
    } catch {
      // ignore
    }
  }

  return {
    installed,
    install_path: INSTALL_DIR,
    config_exists: configExists,
    db_exists: dbExists,
    db_path: dbPath,
    daemon_loaded: daemonLoaded,
    full_server_ready: existsSync(FULL_SERVER),
    setup_in_progress: !installed && existsSync(PROGRESS_FILE),
    version,
    node_version: process.version,
    node_exec_path: process.execPath,
  };
}
