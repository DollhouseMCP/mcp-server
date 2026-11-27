#!/bin/bash
# pretooluse-vscode.sh — vscode hook entry point for DollhouseMCP

export DOLLHOUSE_HOOK_PLATFORM="vscode"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/pretooluse-dollhouse.sh"
