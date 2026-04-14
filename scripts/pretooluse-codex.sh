#!/bin/bash
# pretooluse-codex.sh — Manual Codex hook wrapper for DollhouseMCP

export DOLLHOUSE_HOOK_PLATFORM="codex"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/pretooluse-dollhouse.sh"
