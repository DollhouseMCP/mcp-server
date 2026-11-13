#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
source "$root/scripts/hosted-deploy/runtime.sh"
SERVER_DIR="$fixture/server"
die() { printf '%s\n' "$*" >&2; return 1; }
mkdir -p "$SERVER_DIR/docker" "$SERVER_DIR/src/cli"
printf 'FROM production AS migration\n' > "$SERVER_DIR/docker/Dockerfile"
: > "$SERVER_DIR/src/cli/migrate-database.ts"
require_slim_maintenance_source
printf 'FROM production AS migration\n' >> "$SERVER_DIR/docker/Dockerfile"
if (require_slim_maintenance_source) >"$fixture/error" 2>&1; then exit 1; fi
grep -Fq 'roll forward to a supported source' "$fixture/error"
printf 'FROM production\n' > "$SERVER_DIR/docker/Dockerfile"
if (require_slim_maintenance_source) >"$fixture/error" 2>&1; then exit 1; fi
grep -Fq 'roll forward to a supported source' "$fixture/error"
printf 'FROM production AS migration\n' > "$SERVER_DIR/docker/Dockerfile"
rm "$SERVER_DIR/src/cli/migrate-database.ts"
if (require_slim_maintenance_source) >"$fixture/error" 2>&1; then exit 1; fi
echo 'maintenance source guard passed'
