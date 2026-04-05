#!/usr/bin/env node
/**
 * Mnemo Setup Script
 *
 * Configures Mnemo after `npm install` (which also builds via postinstall).
 * - Creates ~/.mnemo/config.json with defaults
 * - Initializes the SQLite database
 * - Adds the MCP server to Claude Code and/or Claude Desktop config
 *
 * Usage:
 *   npm run setup                          # interactive defaults
 *   npm run setup -- --claude-code         # configure for Claude Code only
 *   npm run setup -- --claude-desktop      # configure for Claude Desktop only
 *   npm run setup -- --skip-config         # skip Claude config, just init DB
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const HOME = homedir();
const PLATFORM = platform();

// ── Helpers ──────────────────────────────────────────────────────────────

function ask(question, defaultVal) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

function log(msg) {
  console.log(`  ${msg}`);
}

function heading(msg) {
  console.log(`\n=== ${msg} ===\n`);
}

// ── Detect sync folder ──────────────────────────────────────────────────

function detectSyncFolder() {
  const candidates = [
    resolve(HOME, "Dropbox", "Mnemo"),
    resolve(HOME, "Google Drive", "My Drive", "Mnemo"),
  ];

  if (PLATFORM === "darwin") {
    candidates.push(
      resolve(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "Mnemo")
    );
    // Google Drive via CloudStorage
    const cloudStorage = resolve(HOME, "Library", "CloudStorage");
    if (existsSync(cloudStorage)) {
      try {
        for (const dir of readdirSync(cloudStorage)) {
          if (dir.startsWith("GoogleDrive-")) {
            candidates.splice(2, 0, resolve(cloudStorage, dir, "My Drive", "Mnemo"));
          }
        }
      } catch {}
    }
  }

  for (const c of candidates) {
    if (existsSync(resolve(c, ".."))) return c;
  }

  return resolve(HOME, ".mnemo");
}

// ── Config creation ─────────────────────────────────────────────────────

function createConfig(configPath, dbPath) {
  const config = {
    db_path: dbPath,
    ollama_url: "http://localhost:11434",
    ollama_model: "nomic-embed-text",
    cowork_data_dir:
      PLATFORM === "darwin"
        ? "~/Library/Application Support/Claude/cowork"
        : PLATFORM === "win32"
          ? "%APPDATA%/Claude/cowork"
          : "~/.config/claude/cowork",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    profile_build_interval: 5,
    compression_keep_full_days: 7,
    compression_keep_summary_days: 30,
    telegram: {
      enabled: false,
      bot_token: "",
      user_id: "",
    },
    log_level: "info",
    log_file: resolve(HOME, ".mnemo", "mnemo.log"),
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return config;
}

// ── Database initialization ─────────────────────────────────────────────

async function initDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { initDatabase } = await import("../shared/dist/migrations.js");
  initDatabase(dbPath);
}

// ── Claude Code config ──────────────────────────────────────────────────

function configureClaude(target) {
  const mcpEntry = {
    command: "node",
    args: [resolve(PROJECT_ROOT, "mcp-servers", "mnemo-mcp", "dist", "index.js")],
    env: {
      MNEMO_CONFIG_PATH: resolve(HOME, ".mnemo", "config.json"),
    },
  };

  if (target === "claude-code" || target === "both") {
    // Claude Code: ~/.claude.json or settings
    const claudeSettingsDir = resolve(HOME, ".claude");
    const claudeSettingsFile = resolve(claudeSettingsDir, "settings.json");

    let settings = {};
    if (existsSync(claudeSettingsFile)) {
      try {
        settings = JSON.parse(readFileSync(claudeSettingsFile, "utf-8"));
      } catch {}
    }

    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers["mnemo"] = mcpEntry;

    mkdirSync(claudeSettingsDir, { recursive: true });
    writeFileSync(claudeSettingsFile, JSON.stringify(settings, null, 2) + "\n");
    log("Claude Code: Added mnemo MCP server to ~/.claude/settings.json");
  }

  if (target === "claude-desktop" || target === "both") {
    // Claude Desktop config location
    let configPath;
    if (PLATFORM === "darwin") {
      configPath = resolve(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    } else if (PLATFORM === "win32") {
      configPath = resolve(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
    } else {
      configPath = resolve(HOME, ".config", "claude", "claude_desktop_config.json");
    }

    let config = {};
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {}
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers["mnemo"] = mcpEntry;

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    log(`Claude Desktop: Added mnemo MCP server to ${configPath}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const skipConfig = args.includes("--skip-config");
  const claudeCodeOnly = args.includes("--claude-code");
  const claudeDesktopOnly = args.includes("--claude-desktop");

  heading("Mnemo Setup");

  // 1. Check Node version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion < 20) {
    console.error(`ERROR: Node.js 20+ required. Found: ${process.version}`);
    process.exit(1);
  }
  log(`Node.js ${process.version} OK`);

  // 2. Check that build output exists
  const mcpDist = resolve(PROJECT_ROOT, "mcp-servers", "mnemo-mcp", "dist", "index.js");
  if (!existsSync(mcpDist)) {
    console.error("ERROR: Build output not found. Run `npm run build` first.");
    process.exit(1);
  }
  log("Build output found");

  // 3. Create config if needed
  const configPath = resolve(HOME, ".mnemo", "config.json");
  let dbPath;

  if (existsSync(configPath)) {
    log(`Config already exists: ${configPath}`);
    const existing = JSON.parse(readFileSync(configPath, "utf-8"));
    dbPath = existing.db_path;
    if (dbPath.startsWith("~")) dbPath = resolve(HOME, dbPath.slice(2));
  } else {
    const syncFolder = detectSyncFolder();
    dbPath = resolve(syncFolder, "mnemo.db");
    log(`Detected storage: ${dirname(dbPath)}`);

    createConfig(configPath, dbPath);
    log(`Config created: ${configPath}`);
  }

  // 4. Initialize database
  log("Initializing database...");
  await initDb(dbPath);
  log(`Database ready: ${dbPath}`);

  // 5. Configure Claude
  if (!skipConfig) {
    const target = claudeCodeOnly
      ? "claude-code"
      : claudeDesktopOnly
        ? "claude-desktop"
        : "both";
    configureClaude(target);
  }

  // 6. Check Ollama (optional)
  heading("Optional: Ollama (for vector search)");
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) {
      log("Ollama detected - vector search will be available");
    } else {
      throw new Error();
    }
  } catch {
    log("Ollama not detected - that's fine, Mnemo works without it");
    log("For vector search later: https://ollama.com/download");
    log("Then run: ollama pull nomic-embed-text");
  }

  heading("Setup Complete!");
  console.log(`  Config:   ${configPath}`);
  console.log(`  Database: ${dbPath}`);
  console.log(`  Server:   ${mcpDist}`);
  console.log("");
  console.log("  Restart Claude Code / Claude Desktop to activate Mnemo.");
  console.log("");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
