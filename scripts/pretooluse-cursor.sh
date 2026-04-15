#!/bin/bash
# pretooluse-cursor.sh — Manual Cursor hook wrapper for DollhouseMCP

export DOLLHOUSE_HOOK_PLATFORM="cursor"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/pretooluse-dollhouse.sh"
