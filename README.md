# Mnemo

Persistent memory, personality profiling, task scheduling, and messaging for Claude.

Mnemo gives Claude persistent memory across conversations using a local SQLite database. It stores profile facts, episodic memories, entity tracking (people, projects, tools), session summaries, and scheduled tasks.

## Quick Start

```bash
git clone https://github.com/bipulluitel/mnemo.git
cd mnemo
npm install    # installs dependencies + builds all packages
npm run setup  # creates config, initializes DB, configures Claude
```

Restart Claude Code or Claude Desktop. Mnemo's 23 tools are now available.

## What `npm install` does

1. Installs all dependencies across workspaces
2. Compiles `better-sqlite3` native module **for your Node version**
3. Builds all TypeScript packages (`shared` -> `mcp-server` -> `daemon`)

No pre-built binaries are shipped. Everything compiles on your machine.

## What `npm run setup` does

1. Creates `~/.mnemo/config.json` with sensible defaults
2. Auto-detects cloud storage (Dropbox, Google Drive, iCloud) for the database
3. Initializes the SQLite database with the full schema
4. Adds the MCP server to Claude Code (`~/.claude/settings.json`) and Claude Desktop (`claude_desktop_config.json`)

### Setup options

```bash
npm run setup                     # configure both Claude Code and Claude Desktop
npm run setup -- --claude-code    # Claude Code only
npm run setup -- --claude-desktop # Claude Desktop only
npm run setup -- --skip-config    # just init DB, don't touch Claude config
```

## Requirements

- **Node.js 20+** (for building `better-sqlite3`)
- **Claude Code** or **Claude Desktop**
- **Ollama** (optional, for vector search) — install from [ollama.com](https://ollama.com), then `ollama pull nomic-embed-text`

## Architecture

```
mnemo/
├── shared/                    # Core library (types, SQLite schema, config, embedder)
├── mcp-servers/mnemo-mcp/   # MCP server (23 tools, 3 resources, 2 prompts)
├── daemon/                    # Background service (session watcher, task runner, Telegram)
├── scripts/                   # Setup and utility scripts
├── commands/                  # Claude Code slash commands
└── skills/                    # Claude Code skills
```

**npm workspaces** manages the monorepo. The `shared` package is used by both `mcp-server` and `daemon` via workspace linking — no `file:` hacks or pre-bundling needed.

## MCP Tools

| Category | Tools |
|----------|-------|
| Memory Read | `mnemo_recall`, `mnemo_profile`, `mnemo_episodes`, `mnemo_sessions`, `mnemo_entity` |
| Memory Write | `mnemo_remember`, `mnemo_record_episode`, `mnemo_track_entity`, `mnemo_relate`, `mnemo_forget` |
| Entities | `mnemo_search_entities`, `mnemo_profile_history` |
| Sessions | `mnemo_save_session` |
| Scheduling | `mnemo_schedule`, `mnemo_list_tasks`, `mnemo_update_task`, `mnemo_delete_task`, `mnemo_task_history` |
| Messaging | `mnemo_send_message`, `mnemo_check_messages` |
| System | `mnemo_configure`, `mnemo_sync_status`, `mnemo_system_stats` |

## Configuration

Config lives at `~/.mnemo/config.json`:

```json
{
  "db_path": "~/Dropbox/Mnemo/mnemo.db",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "nomic-embed-text",
  "timezone": "America/Chicago",
  "telegram": {
    "enabled": false,
    "bot_token": "",
    "user_id": ""
  }
}
```

## Daemon (optional)

The daemon provides background services: session watching, profile building, task scheduling, and Telegram messaging.

```bash
# macOS (launchd)
bash scripts/install-daemon.sh

# Manual
node daemon/dist/index.js
```

## Development

```bash
npm run build          # build all packages
npm run build:shared   # build shared only
npm run build:mcp      # build MCP server only
npm run build:daemon   # build daemon only
npm run clean          # remove all build output
```

## License

MIT
