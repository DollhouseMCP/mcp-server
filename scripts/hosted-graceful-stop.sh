#!/usr/bin/env bash
# No Docker/Compose stop escalation is permitted after a refused memory drain.
set -euo pipefail
exec python3 "$(dirname -- "$0")/hosted-graceful-stop.py" "$@"
