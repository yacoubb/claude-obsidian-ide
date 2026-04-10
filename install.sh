#!/usr/bin/env bash
set -euo pipefail

VAULT_DIR="${1:?Usage: ./deploy.sh <obsidian-vault-directory>}"
PLUGIN_ID="claude-code-obsidian"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$VAULT_DIR/.obsidian/plugins/$PLUGIN_ID"

# Validate vault
if [ ! -d "$VAULT_DIR/.obsidian" ]; then
	echo "Error: $VAULT_DIR does not look like an Obsidian vault (no .obsidian directory)" >&2
	exit 1
fi

# Build
echo "Building..."
cd "$SCRIPT_DIR"
npm run build

# Copy
mkdir -p "$TARGET_DIR"
cp main.js manifest.json "$TARGET_DIR/"
[ -f styles.css ] && cp styles.css "$TARGET_DIR/" || rm -f "$TARGET_DIR/styles.css"
echo "Deployed to $TARGET_DIR"
