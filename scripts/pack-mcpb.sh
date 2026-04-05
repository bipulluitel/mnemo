#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
STAGE_DIR="$PROJECT_ROOT/.mcpb-stage"
OUTPUT="$PROJECT_ROOT/mnemo.mcpb"

echo "=== Packaging Mnemo .mcpb ==="

# Clean previous staging
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/mcp-servers/mnemo-stub"

# Build the stub if not already built
echo "Building stub server..."
cd "$PROJECT_ROOT"
npm run build:stub

# Copy manifest and launcher
cp "$PROJECT_ROOT/manifest.json" "$STAGE_DIR/"
cp "$PROJECT_ROOT/launcher.js" "$STAGE_DIR/"

# Copy stub dist (compiled JS only, no source)
cp -r "$PROJECT_ROOT/mcp-servers/mnemo-stub/dist" "$STAGE_DIR/mcp-servers/mnemo-stub/"
cp "$PROJECT_ROOT/mcp-servers/mnemo-stub/package.json" "$STAGE_DIR/mcp-servers/mnemo-stub/"

# Install only stub dependencies (no native modules)
cd "$STAGE_DIR/mcp-servers/mnemo-stub"
npm install --omit=dev --ignore-scripts 2>/dev/null

# Pack with mcpb
echo "Running mcpb pack..."
cd "$STAGE_DIR"
mcpb pack . "$OUTPUT"

# Clean staging
rm -rf "$STAGE_DIR"

echo ""
echo "Bundle created: $OUTPUT"
echo "Size: $(du -h "$OUTPUT" | cut -f1)"
