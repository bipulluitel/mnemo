#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Mnemo Bootstrap ==="
echo ""

# Step 1: Check Node.js
echo "Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "ERROR: Node.js 20+ required. Found: $(node -v)"
    exit 1
fi
echo "  Node.js $(node -v) ✓"

# Step 2: Check/Install Ollama
echo "Checking Ollama..."
if ! command -v ollama &> /dev/null; then
    echo "  Ollama not found. Installing via Homebrew..."
    if command -v brew &> /dev/null; then
        brew install ollama
    else
        echo "ERROR: Neither Ollama nor Homebrew found."
        echo "Install Ollama from https://ollama.com/download"
        exit 1
    fi
fi
echo "  Ollama ✓"

# Step 3: Ensure Ollama is running and pull model
echo "Pulling nomic-embed-text model..."
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "  Starting Ollama..."
    ollama serve &
    sleep 3
fi
ollama pull nomic-embed-text
echo "  nomic-embed-text ✓"

# Step 4: Detect storage location
echo "Detecting storage location..."
DB_DIR=""
if [ -d "$HOME/Dropbox" ]; then
    DB_DIR="$HOME/Dropbox/Mnemo"
elif [ -d "$HOME/Google Drive/My Drive" ]; then
    DB_DIR="$HOME/Google Drive/My Drive/Mnemo"
elif [ -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
    DB_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Mnemo"
else
    DB_DIR="$HOME/.mnemo"
fi
mkdir -p "$DB_DIR"
echo "  Storage: $DB_DIR"

# Step 5: Build shared + MCP server
echo "Building packages..."
cd "$PLUGIN_DIR"
npm install
npm run build
echo "  Build ✓"

# Step 6: Initialize database
echo "Initializing database..."
DB_PATH="$DB_DIR/mnemo.db"
node -e "
  import('$PLUGIN_DIR/shared/dist/migrations.js').then(m => {
    m.initDatabase('$DB_PATH');
    console.log('  Database initialized at $DB_PATH ✓');
  });
"

# Step 7: Write config
echo "Writing config..."
CONFIG_DIR="$HOME/.mnemo"
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cat > "$CONFIG_DIR/config.json" << CONF
{
  "db_path": "$DB_PATH",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "nomic-embed-text",
  "cowork_data_dir": "~/Library/Application Support/Claude/cowork",
  "timezone": "UTC",
  "profile_build_interval": 5,
  "compression_keep_full_days": 7,
  "compression_keep_summary_days": 30,
  "telegram": {
    "enabled": false,
    "bot_token": "",
    "user_id": ""
  },
  "log_level": "info",
  "log_file": "$CONFIG_DIR/mnemo.log"
}
CONF
    echo "  Config written to $CONFIG_DIR/config.json ✓"
else
    echo "  Config already exists ✓"
fi

echo ""
echo "=== Mnemo bootstrap complete ==="
echo "Storage: $DB_PATH"
echo "Config:  $CONFIG_DIR/config.json"
echo ""
echo "Run /mnemo:setup in Claude Cowork to complete setup."
