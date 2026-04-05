---
name: setup
description: First-run bootstrap. Installs Ollama, embedding model, initializes
  the database, starts the background daemon, and optionally configures Telegram.
  Run this once after installing the plugin.
---

# Mnemo Setup

Walk the user through initial setup. Execute each step, reporting progress.

## Step 1: Check Prerequisites

```bash
node --version    # Need 20+
```

If Node.js is missing or too old, tell the user to install it from nodejs.org
and try again.

## Step 2: Install Ollama

```bash
which ollama
```

If missing:
```bash
brew install ollama
```

If brew is missing, direct user to https://ollama.com/download

## Step 3: Pull Embedding Model

```bash
ollama pull nomic-embed-text
```

Verify:
```bash
curl -s http://localhost:11434/api/tags | grep nomic-embed-text
```

If Ollama is not running:
```bash
ollama serve &
```

## Step 4: Detect Storage Location

Check for sync folders in order. Use the first one found:

1. `~/Dropbox/Mnemo/`
2. `~/Google Drive/My Drive/Mnemo/`
3. `~/Library/CloudStorage/GoogleDrive-*/My Drive/Mnemo/`
4. `~/Library/Mobile Documents/com~apple~CloudDocs/Mnemo/`
5. `~/.mnemo/` (fallback)

Create the directory if it does not exist. Tell the user which location was
selected and ask if they want to change it.

## Step 5: Initialize Database

Run the bootstrap script from the plugin directory:

```bash
cd <plugin-dir> && npm run build:shared
node -e "require('./shared/dist/migrations').initDatabase('<db-path>/mnemo.db')"
```

## Step 6: Write Configuration

Create `~/.mnemo/config.json`:

```json
{
  "db_path": "<detected-path>/mnemo.db",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "nomic-embed-text",
  "cowork_data_dir": "~/Library/Application Support/Claude/cowork",
  "timezone": "<ask user>",
  "profile_build_interval": 5,
  "compression_keep_full_days": 7,
  "compression_keep_summary_days": 30,
  "telegram": {
    "enabled": false,
    "bot_token": "",
    "user_id": ""
  }
}
```

## Step 7: Build MCP Server

```bash
cd <plugin-dir> && npm install && npm run build
```

## Step 8: Install and Start Daemon

```bash
cd <plugin-dir>/daemon && npm install && npm run build
cp <plugin-dir>/daemon/launchd/com.mnemo.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mnemo.daemon.plist
```

Verify the daemon is running:
```bash
launchctl list | grep mnemo
```

## Step 9: Telegram (Optional)

Ask the user: "Would you like to connect Telegram so I can message you
when you're away from the computer?"

If yes, guide them through:
1. Open Telegram, search for @BotFather, send /newbot
2. Copy the bot token
3. Search for @userinfobot to get their user ID
4. Update config.json with token and user_id, set enabled: true
5. Restart daemon: `launchctl kickstart -k gui/$(id -u)/com.mnemo.daemon`

## Step 10: Verify

Use the `mnemo_profile` tool to confirm the MCP server can read the database.
Store a test fact:

```
mnemo_remember(category="identity", key="setup_complete", value="true", confidence=1.0, source="explicit")
```

Tell the user: "Mnemo is ready. I'll remember everything from here on out.
Tell me about yourself — your name, what you do, how you like to work."
