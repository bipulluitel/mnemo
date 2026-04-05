import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { resolve, dirname } from "path";
import { homedir, platform } from "os";
import { execSync, ExecSyncOptions } from "child_process";

const HOME = homedir();
const INSTALL_DIR = resolve(HOME, ".mnemo", "install");
const CONFIG_PATH = resolve(HOME, ".mnemo", "config.json");
const SENTINEL = resolve(INSTALL_DIR, ".setup-complete");
const PROGRESS_FILE = resolve(INSTALL_DIR, ".setup-progress");
const DEFAULT_REPO = "https://github.com/bipulluitel/mnemo.git";
const PLIST_NAME = "com.mnemo.daemon.plist";

export interface SetupOptions {
  force: boolean;
  repoUrl?: string;
  skipDaemon: boolean;
}

export interface SetupResult {
  success: boolean;
  report: string;
}

type StepName =
  | "prerequisites"
  | "clone"
  | "install"
  | "build"
  | "config"
  | "database"
  | "daemon";

interface Progress {
  completed: StepName[];
  started_at: string;
  last_step_at: string;
}

function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
    } catch {
      // corrupt, start fresh
    }
  }
  return {
    completed: [],
    started_at: new Date().toISOString(),
    last_step_at: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_step_at = new Date().toISOString();
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function run(
  cmd: string,
  opts?: ExecSyncOptions
): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: 300_000, // 5 minutes
    ...opts,
  }) as string;
}

/**
 * Run a command using the current Node binary (Claude Desktop's Node).
 * This ensures native addons compile against the correct ABI.
 */
function runWithCurrentNode(
  cmd: string,
  cwd: string
): string {
  const nodeExec = process.execPath;
  // Find npm relative to the current Node binary
  const nodeDir = dirname(nodeExec);
  const npmCli = resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npmCmd = existsSync(npmCli)
    ? `"${nodeExec}" "${npmCli}"`
    : "npm"; // fallback to PATH npm

  const fullCmd = cmd
    .replace(/^npm /, `${npmCmd} `)
    .replace(/^node /, `"${nodeExec}" `);

  return run(fullCmd, {
    cwd,
    env: {
      ...process.env,
      npm_node_execpath: nodeExec,
      npm_config_nodedir: "",
    },
  });
}

function detectSyncFolder(): string {
  const candidates = [
    resolve(HOME, "Dropbox", "Mnemo"),
    resolve(HOME, "Google Drive", "My Drive", "Mnemo"),
  ];

  if (platform() === "darwin") {
    candidates.push(
      resolve(
        HOME,
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
        "Mnemo"
      )
    );
    const cloudStorage = resolve(HOME, "Library", "CloudStorage");
    if (existsSync(cloudStorage)) {
      try {
        for (const dir of readdirSync(cloudStorage)) {
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
  }

  for (const c of candidates) {
    if (existsSync(resolve(c, ".."))) return c;
  }

  return resolve(HOME, ".mnemo");
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const lines: string[] = [];
  const log = (icon: string, msg: string) => {
    lines.push(`[${icon}] ${msg}`);
  };

  // If already installed and not forcing, short-circuit
  if (existsSync(SENTINEL) && !opts.force) {
    const sentinelData = readFileSync(SENTINEL, "utf-8").trim();
    return {
      success: true,
      report: `Mnemo is already installed (${sentinelData}).\nUse force=true to update.\n\nRestart Claude Desktop if tools aren't showing up.`,
    };
  }

  const progress = opts.force
    ? { completed: [] as StepName[], started_at: new Date().toISOString(), last_step_at: new Date().toISOString() }
    : loadProgress();

  const done = new Set(progress.completed);

  try {
    // ── Step 1: Prerequisites ──
    if (!done.has("prerequisites") || opts.force) {
      const nodeVersion = process.version;
      const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0], 10);
      if (nodeMajor < 20) {
        log("FAIL", `Node.js 20+ required. Found: ${nodeVersion}`);
        return { success: false, report: lines.join("\n") };
      }

      let gitVersion = "not found";
      try {
        gitVersion = run("git --version").trim();
      } catch {
        log("FAIL", "git is not installed. Please install git and try again.");
        return { success: false, report: lines.join("\n") };
      }

      log("OK", `Prerequisites: Node ${nodeVersion} (${process.execPath}), ${gitVersion}`);
      progress.completed.push("prerequisites");
      saveProgress(progress);
    } else {
      log("SKIP", "Prerequisites (already checked)");
    }

    // ── Step 2: Clone / Update Repository ──
    if (!done.has("clone") || opts.force) {
      const repoUrl = opts.repoUrl || process.env.MNEMO_REPO_URL || DEFAULT_REPO;

      if (existsSync(resolve(INSTALL_DIR, ".git"))) {
        // Existing repo — pull latest
        log("...", "Updating existing installation...");
        try {
          run("git pull --ff-only", { cwd: INSTALL_DIR });
          log("OK", "Repository updated");
        } catch {
          log("WARN", "git pull failed — continuing with existing code");
        }
      } else if (existsSync(INSTALL_DIR)) {
        // Directory exists but no .git — wipe and clone
        run(`rm -rf "${INSTALL_DIR}"`);
        log("...", `Cloning ${repoUrl}...`);
        run(`git clone "${repoUrl}" "${INSTALL_DIR}"`);
        log("OK", `Repository cloned to ${INSTALL_DIR}`);
      } else {
        log("...", `Cloning ${repoUrl}...`);
        mkdirSync(dirname(INSTALL_DIR), { recursive: true });
        run(`git clone "${repoUrl}" "${INSTALL_DIR}"`);
        log("OK", `Repository cloned to ${INSTALL_DIR}`);
      }

      progress.completed.push("clone");
      saveProgress(progress);
    } else {
      log("SKIP", "Clone (already done)");
    }

    // ── Step 3: Install Dependencies ──
    if (!done.has("install") || opts.force) {
      log("...", "Installing dependencies (this compiles native modules for this Node runtime)...");
      try {
        runWithCurrentNode("npm install", INSTALL_DIR);
        log("OK", "Dependencies installed (better-sqlite3 compiled for current Node ABI)");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log("FAIL", `npm install failed: ${msg}`);
        saveProgress(progress);
        return { success: false, report: lines.join("\n") };
      }

      progress.completed.push("install");
      saveProgress(progress);
    } else {
      log("SKIP", "Dependencies (already installed)");
    }

    // ── Step 4: Build ──
    if (!done.has("build") || opts.force) {
      log("...", "Building project...");
      try {
        runWithCurrentNode("npm run build", INSTALL_DIR);
        log("OK", "Project built successfully");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log("FAIL", `Build failed: ${msg}`);
        saveProgress(progress);
        return { success: false, report: lines.join("\n") };
      }

      progress.completed.push("build");
      saveProgress(progress);
    } else {
      log("SKIP", "Build (already done)");
    }

    // ── Step 5: Config ──
    if (!done.has("config") || opts.force) {
      if (existsSync(CONFIG_PATH) && !opts.force) {
        log("OK", `Config already exists: ${CONFIG_PATH}`);
      } else {
        const syncFolder = detectSyncFolder();
        mkdirSync(syncFolder, { recursive: true });
        mkdirSync(dirname(CONFIG_PATH), { recursive: true });

        const config = {
          db_path: resolve(syncFolder, "mnemo.db"),
          ollama_url: "http://localhost:11434",
          ollama_model: "nomic-embed-text",
          cowork_data_dir:
            platform() === "darwin"
              ? resolve(HOME, "Library", "Application Support", "Claude", "cowork")
              : resolve(HOME, ".config", "claude", "cowork"),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          profile_build_interval: 5,
          compression_keep_full_days: 7,
          compression_keep_summary_days: 30,
          telegram: { enabled: false, bot_token: "", user_id: "" },
          log_level: "info",
          log_file: resolve(HOME, ".mnemo", "mnemo.log"),
        };

        writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
        log("OK", `Config created: ${CONFIG_PATH}`);
      }

      progress.completed.push("config");
      saveProgress(progress);
    } else {
      log("SKIP", "Config (already exists)");
    }

    // ── Step 6: Database ──
    if (!done.has("database") || opts.force) {
      try {
        const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
        let dbPath: string = cfg.db_path;
        if (dbPath.startsWith("~/")) {
          dbPath = resolve(HOME, dbPath.slice(2));
        }
        mkdirSync(dirname(dbPath), { recursive: true });

        // Use the freshly-built shared module to init the DB
        const initScript = resolve(INSTALL_DIR, "shared", "dist", "migrations.js");
        if (existsSync(initScript)) {
          runWithCurrentNode(
            `node -e "import('${initScript}').then(m => m.initDatabase('${dbPath}'))"`,
            INSTALL_DIR
          );
          log("OK", `Database initialized: ${dbPath}`);
        } else {
          // Fallback: just ensure the directory exists, DB will self-init on first access
          log("OK", `Database directory ready: ${dirname(dbPath)} (will initialize on first use)`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log("WARN", `Database init: ${msg} (will initialize on first use)`);
      }

      progress.completed.push("database");
      saveProgress(progress);
    } else {
      log("SKIP", "Database (already initialized)");
    }

    // ── Step 7: Daemon ──
    if (!opts.skipDaemon && (!done.has("daemon") || opts.force)) {
      if (platform() !== "darwin") {
        log("SKIP", "Daemon: launchd only supported on macOS");
      } else {
        try {
          const daemonDir = resolve(INSTALL_DIR, "daemon");
          const plistSrc = resolve(daemonDir, "launchd", PLIST_NAME);
          const plistDst = resolve(HOME, "Library", "LaunchAgents", PLIST_NAME);

          if (!existsSync(plistSrc)) {
            log("WARN", "Daemon plist template not found — skipping daemon install");
          } else {
            // Unload existing if present
            try {
              run(`launchctl unload "${plistDst}" 2>/dev/null`);
            } catch {
              // not loaded, fine
            }

            // Read and configure plist
            let plist = readFileSync(plistSrc, "utf-8");
            plist = plist.replace(/MNEMO_DAEMON_DIR/g, daemonDir);
            plist = plist.replace(/\/usr\/local\/bin\/node/g, process.execPath);
            plist = plist.replace(/~\//g, `${HOME}/`);

            mkdirSync(resolve(HOME, "Library", "LaunchAgents"), {
              recursive: true,
            });
            writeFileSync(plistDst, plist);

            // Load
            run(`launchctl load "${plistDst}"`);
            log("OK", "Daemon installed and started");
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log("WARN", `Daemon install: ${msg} (you can install it manually later)`);
        }
      }

      progress.completed.push("daemon");
      saveProgress(progress);
    } else if (opts.skipDaemon) {
      log("SKIP", "Daemon (skipped by user)");
    } else {
      log("SKIP", "Daemon (already installed)");
    }

    // ── Done ──
    writeFileSync(SENTINEL, new Date().toISOString());

    // Check Ollama
    let ollamaStatus = "not detected (optional — for vector search)";
    try {
      const res = run("curl -s -o /dev/null -w '%{http_code}' http://localhost:11434/api/tags");
      if (res.trim() === "200") {
        ollamaStatus = "running";
      }
    } catch {
      // not available
    }

    log("OK", `Ollama: ${ollamaStatus}`);
    log("DONE", "Mnemo setup complete!");
    lines.push("");
    lines.push("IMPORTANT: Restart Claude Desktop to activate all Mnemo tools.");
    lines.push("The stub server will hand off to the full server on next launch.");

    return { success: true, report: lines.join("\n") };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("FAIL", `Unexpected error: ${msg}`);
    saveProgress(progress);
    return { success: false, report: lines.join("\n") };
  }
}
