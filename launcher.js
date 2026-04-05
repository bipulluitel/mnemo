/**
 * Mnemo Launcher
 *
 * Routes to either the full MCP server (if installed) or the stub bootstrapper.
 * This is the entry point referenced by the .mcpb manifest.
 *
 * - Full server: ~/.mnemo/install/mcp-servers/mnemo-mcp/dist/index.js
 * - Stub server: bundled alongside this file in the .mcpb
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const HOME = homedir();

const INSTALL_DIR = resolve(HOME, ".mnemo", "install");
const FULL_SERVER = resolve(
  INSTALL_DIR,
  "mcp-servers",
  "mnemo-mcp",
  "dist",
  "index.js"
);
const SENTINEL = resolve(INSTALL_DIR, ".setup-complete");
const STUB_SERVER = resolve(
  __dirname,
  "mcp-servers",
  "mnemo-stub",
  "dist",
  "index.js"
);

if (existsSync(SENTINEL) && existsSync(FULL_SERVER)) {
  await import(FULL_SERVER);
} else {
  await import(STUB_SERVER);
}
