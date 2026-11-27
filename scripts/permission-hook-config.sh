#!/bin/bash
# permission-hook-config.sh — shared runtime configuration helpers for
# Dollhouse permission hook wrappers.

PERMISSION_HOOK_DEFAULT_AUTHORITY_CACHE_TTL_SECONDS=2
PERMISSION_HOOK_MIN_AUTHORITY_CACHE_TTL_SECONDS=0
PERMISSION_HOOK_MAX_AUTHORITY_CACHE_TTL_SECONDS=30

PERMISSION_HOOK_DEFAULT_MAX_RETRIES=2
PERMISSION_HOOK_MIN_MAX_RETRIES=0
PERMISSION_HOOK_MAX_MAX_RETRIES=5

PERMISSION_HOOK_DEFAULT_INITIAL_TIMEOUT=5
PERMISSION_HOOK_MIN_INITIAL_TIMEOUT=1
PERMISSION_HOOK_MAX_INITIAL_TIMEOUT=30
PERMISSION_HOOK_DEFAULT_REQUEST_BUDGET_SECONDS=15
PERMISSION_HOOK_MIN_REQUEST_BUDGET_SECONDS=1
PERMISSION_HOOK_MAX_REQUEST_BUDGET_SECONDS=20

permission_hook_resolve_bounded_int() {
  local raw_value="$1"
  local fallback_value="$2"
  local minimum_value="$3"
  local maximum_value="$4"

  if [[ ! "$raw_value" =~ ^[0-9]+$ ]]; then
    echo "$fallback_value"
    return 0
  fi

  if (( raw_value < minimum_value )); then
    echo "$minimum_value"
    return 0
  fi

  if (( raw_value > maximum_value )); then
    echo "$maximum_value"
    return 0
  fi

  echo "$raw_value"
  return 0
}

permission_hook_load_runtime_config() {
  AUTHORITY_CACHE_TTL_SECONDS="$(
    permission_hook_resolve_bounded_int \
      "${DOLLHOUSE_HOOK_AUTHORITY_CACHE_TTL_SECONDS:-$PERMISSION_HOOK_DEFAULT_AUTHORITY_CACHE_TTL_SECONDS}" \
      "$PERMISSION_HOOK_DEFAULT_AUTHORITY_CACHE_TTL_SECONDS" \
      "$PERMISSION_HOOK_MIN_AUTHORITY_CACHE_TTL_SECONDS" \
      "$PERMISSION_HOOK_MAX_AUTHORITY_CACHE_TTL_SECONDS"
  )"
  MAX_RETRIES="$(
    permission_hook_resolve_bounded_int \
      "${DOLLHOUSE_HOOK_MAX_RETRIES:-$PERMISSION_HOOK_DEFAULT_MAX_RETRIES}" \
      "$PERMISSION_HOOK_DEFAULT_MAX_RETRIES" \
      "$PERMISSION_HOOK_MIN_MAX_RETRIES" \
      "$PERMISSION_HOOK_MAX_MAX_RETRIES"
  )"
  INITIAL_TIMEOUT="$(
    permission_hook_resolve_bounded_int \
      "${DOLLHOUSE_HOOK_INITIAL_TIMEOUT:-$PERMISSION_HOOK_DEFAULT_INITIAL_TIMEOUT}" \
      "$PERMISSION_HOOK_DEFAULT_INITIAL_TIMEOUT" \
      "$PERMISSION_HOOK_MIN_INITIAL_TIMEOUT" \
      "$PERMISSION_HOOK_MAX_INITIAL_TIMEOUT"
  )"
  REQUEST_BUDGET_SECONDS="$(
    permission_hook_resolve_bounded_int \
      "${DOLLHOUSE_HOOK_REQUEST_BUDGET_SECONDS:-$PERMISSION_HOOK_DEFAULT_REQUEST_BUDGET_SECONDS}" \
      "$PERMISSION_HOOK_DEFAULT_REQUEST_BUDGET_SECONDS" \
      "$PERMISSION_HOOK_MIN_REQUEST_BUDGET_SECONDS" \
      "$PERMISSION_HOOK_MAX_REQUEST_BUDGET_SECONDS"
  )"
  local default_tools="bash powershell monitor write edit multiedit notebookedit webfetch"
  local default_mcp_read_only='^(get|list|read|search|query|find|view|describe|status)([_.:/-]|$)|^fetch[-_]without[-_]side[-_]effects$'
  OUTAGE_HIGH_RISK_TOOLS="${DOLLHOUSE_HOOK_OUTAGE_HIGH_RISK_TOOLS:-$default_tools}"
  if [[ -z "${OUTAGE_HIGH_RISK_TOOLS//[[:space:]]/}" ]]; then
    OUTAGE_HIGH_RISK_TOOLS="$default_tools"
  fi
  OUTAGE_MCP_READ_ONLY_PATTERN="${DOLLHOUSE_HOOK_OUTAGE_MCP_READ_ONLY_PATTERN:-$default_mcp_read_only}"
  # The original override can still promote a read-only name to high risk.
  OUTAGE_MCP_HIGH_RISK_PATTERN="${DOLLHOUSE_HOOK_OUTAGE_MCP_HIGH_RISK_PATTERN:-}"

  export AUTHORITY_CACHE_TTL_SECONDS MAX_RETRIES INITIAL_TIMEOUT REQUEST_BUDGET_SECONDS
  export OUTAGE_HIGH_RISK_TOOLS OUTAGE_MCP_READ_ONLY_PATTERN OUTAGE_MCP_HIGH_RISK_PATTERN
  return 0
}
