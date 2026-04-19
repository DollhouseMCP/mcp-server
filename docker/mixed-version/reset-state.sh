#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_ROOT="${REPO_ROOT}/tmp/mixed-version"

rm -rf "${STATE_ROOT}"
mkdir -p "${STATE_ROOT}/home" "${STATE_ROOT}/logs"

echo "Reset mixed-version harness state under ${STATE_ROOT}"
