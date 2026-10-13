#!/usr/bin/env bash
# Aria IDE - Install CLI Command ('aria .') into user's PATH
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SOURCE="$SCRIPT_DIR/bin/aria.js"
TARGET_DIR="$HOME/.local/bin"
TARGET_BIN="$TARGET_DIR/aria"

echo -e "\033[1;36m[Aria IDE]\033[0m Installing 'aria' command into PATH..."

# Ensure target directory exists
mkdir -p "$TARGET_DIR"

# Ensure source file is executable
chmod +x "$BIN_SOURCE"

# Create symlink
ln -sf "$BIN_SOURCE" "$TARGET_BIN"

echo -e "\033[1;32m✓ Successfully installed:\033[0m $TARGET_BIN -> $BIN_SOURCE"

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$TARGET_DIR:"* ]]; then
  echo -e "\033[1;33mNotice:\033[0m $TARGET_DIR is not yet in your current PATH."
  echo "Add the following line to your ~/.bashrc or ~/.zshrc:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo -e "\033[1;32mYou can now open any folder in Aria IDE using:\033[0m"
echo "  aria ."
echo "  aria /path/to/project"
