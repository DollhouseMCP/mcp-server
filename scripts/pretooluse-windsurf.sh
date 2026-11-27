#!/bin/bash
# pretooluse-windsurf.sh — windsurf hook entry point for DollhouseMCP

export DOLLHOUSE_HOOK_PLATFORM="windsurf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/pretooluse-dollhouse.sh"
