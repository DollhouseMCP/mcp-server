#!/bin/bash
# pretooluse-gemini.sh — Manual Gemini CLI hook wrapper for DollhouseMCP

export DOLLHOUSE_HOOK_PLATFORM="gemini"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/pretooluse-dollhouse.sh"
