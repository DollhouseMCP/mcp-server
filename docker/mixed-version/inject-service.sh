#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/docker-compose.mixed-version.yml"

if [[ $# -lt 1 ]]; then
  echo "Usage:" >&2
  echo "  $0 current-local --rebuild" >&2
  echo "  $0 <stable-226|legacy-225|legacy-219> <npm-spec>" >&2
  exit 1
fi

SERVICE="$1"
shift

case "${SERVICE}" in
  current-local)
    if [[ "${1:-}" != "--rebuild" ]]; then
      echo "current-local only supports --rebuild" >&2
      exit 1
    fi
    docker compose -f "${COMPOSE_FILE}" up -d --build --force-recreate current-local
    ;;
  stable-226)
    SPEC="${1:?Provide an npm package spec such as @dollhousemcp/mcp-server@2.0.26}"
    MIXED_VERSION_STABLE_SPEC="${SPEC}" docker compose -f "${COMPOSE_FILE}" up -d --force-recreate stable-226
    ;;
  legacy-225)
    SPEC="${1:?Provide an npm package spec such as @dollhousemcp/mcp-server@2.0.25}"
    MIXED_VERSION_LEGACY_ONE_SPEC="${SPEC}" docker compose -f "${COMPOSE_FILE}" up -d --force-recreate legacy-225
    ;;
  legacy-219)
    SPEC="${1:?Provide an npm package spec such as @dollhousemcp/mcp-server@2.0.19}"
    MIXED_VERSION_LEGACY_TWO_SPEC="${SPEC}" docker compose -f "${COMPOSE_FILE}" up -d --force-recreate legacy-219
    ;;
  *)
    echo "Unknown service: ${SERVICE}" >&2
    exit 1
    ;;
esac
