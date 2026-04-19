#!/bin/bash

set -euo pipefail

SESSION_NAME="${SESSION_NAME:?SESSION_NAME is required}"
MCP_SERVER_TARGET="${MCP_SERVER_TARGET:?MCP_SERVER_TARGET is required}"
LOG_DIR="${HARNESS_LOG_DIR:-/logs}"
HOME_DIR="${HOME:-/dollhouse-home}"
APP_HOME="${DOLLHOUSE_HOME_DIR:-$HOME_DIR}"
RUN_DIR="${APP_HOME}/.dollhouse/run"
PORTFOLIO_DIR="${DOLLHOUSE_PORTFOLIO_DIR:-${APP_HOME}/.dollhouse/portfolio}"
CACHE_DIR="${DOLLHOUSE_CACHE_DIR:-${APP_HOME}/.dollhouse/cache}"
FILE_LOG_DIR="${APP_HOME}/.dollhouse/logs"
LOG_FILE="${LOG_DIR}/${SESSION_NAME}.log"

mkdir -p "${RUN_DIR}" "${PORTFOLIO_DIR}" "${CACHE_DIR}" "${FILE_LOG_DIR}" "${LOG_DIR}"
touch "${LOG_FILE}"
exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[mixed-version] session=${SESSION_NAME} target=${MCP_SERVER_TARGET}"
echo "[mixed-version] home=${APP_HOME} port=${DOLLHOUSE_WEB_CONSOLE_PORT:-41715}"

run_local_worktree() {
  cd /workspace

  local lock_hash_file="/workspace/node_modules/.mixed-version-package-lock.sha256"
  local install_lock_dir="/workspace/.mixed-version-npm-ci.lock"
  local current_hash
  local original_node_env="${NODE_ENV:-}"
  current_hash="$(sha256sum package-lock.json | awk '{print $1}')"

  # The local-worktree harness needs the full dev toolchain to build the current
  # branch inside the container. The production default is still useful for the
  # published-package services, so only override it in this local path.
  export NODE_ENV=development

  if [[ ! -d /workspace/node_modules ]] || [[ ! -f "${lock_hash_file}" ]] || [[ "$(cat "${lock_hash_file}" 2>/dev/null || true)" != "${current_hash}" ]]; then
    # Multiple harness containers can share the same mounted workspace. Use a
    # simple mkdir lock so only one of them runs npm ci at a time.
    until mkdir "${install_lock_dir}" 2>/dev/null; do
      echo "[mixed-version] waiting for dependency install lock"
      sleep 1
    done

    trap 'rmdir "'"${install_lock_dir}"'" 2>/dev/null || true' RETURN

    if [[ ! -d /workspace/node_modules ]] || [[ ! -f "${lock_hash_file}" ]] || [[ "$(cat "${lock_hash_file}" 2>/dev/null || true)" != "${current_hash}" ]]; then
      echo "[mixed-version] installing local workspace dependencies"
      npm ci --include=dev --no-audit --no-fund
      echo "${current_hash}" > "${lock_hash_file}"
    else
      echo "[mixed-version] dependencies already installed by another container"
    fi
  fi

  echo "[mixed-version] building local workspace"
  npm run build

  local version
  version="$(node -p "require('./package.json').version")"
  echo "[mixed-version] local workspace version=${version}"

  if [[ -n "${original_node_env}" ]]; then
    export NODE_ENV="${original_node_env}"
  else
    unset NODE_ENV
  fi

  rmdir "${install_lock_dir}" 2>/dev/null || true
  trap - RETURN

  # Keep stdin open forever so the stdio MCP server remains connected long enough
  # to exercise deferred console setup, leader election, and follower forwarding.
  tail -f /dev/null | node dist/index.js
  return 0
}

run_built_worktree() {
  cd /workspace

  local version
  version="$(node -p "require('./package.json').version")"
  echo "[mixed-version] image worktree version=${version}"

  tail -f /dev/null | node dist/index.js
  return 0
}

run_published_package() {
  echo "[mixed-version] starting published package ${MCP_SERVER_TARGET}"

  # npx installs the requested version into the shared npm cache volume after the
  # first run, which keeps subsequent reproductions much faster.
  tail -f /dev/null | npx -y "${MCP_SERVER_TARGET}"
  return 0
}

case "${MCP_SERVER_TARGET}" in
  local-worktree)
    run_local_worktree
    ;;
  image-worktree)
    run_built_worktree
    ;;
  *)
    run_published_package
    ;;
esac
