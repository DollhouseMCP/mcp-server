# shellcheck shell=bash
# Source staging helpers for hosted-deploy.

detect_default_source_dir() {
  if [[ -n "${SOURCE_DIR}" ]]; then
    return 0
  fi
  if git -C "${HOSTED_DEPLOY_REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    SOURCE_DIR="${HOSTED_DEPLOY_REPO_ROOT}"
  fi

  return 0
}

unique_path() {
  local base="$1"
  local candidate="${base}"
  local suffix=1

  while [[ -e "${candidate}" ]]; do
    candidate="${base}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "${candidate}"

  return 0
}

redact_url() {
  local url="$1"

  if [[ "${url}" =~ ^(https?://)([^/@]+@)(.*)$ ]]; then
    printf '%s***@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
    return 0
  fi
  printf '%s\n' "${url}"

  return 0
}

stage_from_source_dir() {
  local incoming="$1"
  local revision

  [[ -d "${SOURCE_DIR}" ]] || die "DOLLHOUSE_HOSTED_SOURCE_DIR does not exist: ${SOURCE_DIR}"
  if ! git -C "${SOURCE_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "DOLLHOUSE_HOSTED_SOURCE_DIR is not a git checkout: ${SOURCE_DIR}"
  fi

  log "staging source from ${SOURCE_DIR}" >&2
  if ! git -C "${SOURCE_DIR}" archive --format=tar HEAD | tar -xf - -C "${incoming}"; then
    die "failed to archive HEAD from ${SOURCE_DIR}; check that it has a valid commit and that ${incoming} is writable"
  fi
  revision="$(git -C "${SOURCE_DIR}" rev-parse HEAD)" || \
    die "failed to resolve HEAD revision from ${SOURCE_DIR}"
  printf '%s\n' "${revision}"

  return 0
}

stage_from_remote_git() {
  local incoming="$1"
  local revision redacted_url

  validate_git_url_for_clone
  redacted_url="$(redact_url "${GIT_URL}")"
  log "cloning ${redacted_url} (${GIT_REF})" >&2
  rmdir "${incoming}" || die "failed to prepare incoming clone directory: ${incoming}"
  if ! git clone --depth 1 --branch "${GIT_REF}" "${GIT_URL}" "${incoming}"; then
    die "failed to clone ${redacted_url} at ref ${GIT_REF}; check DOLLHOUSE_HOSTED_GIT_URL, DOLLHOUSE_HOSTED_GIT_REF, network access, and git credentials"
  fi
  revision="$(git -C "${incoming}" rev-parse HEAD)" || \
    die "failed to resolve cloned revision from ${redacted_url}"
  printf '%s\n' "${revision}"

  return 0
}

stage_source() {
  local timestamp incoming revision previous_bundle
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  incoming="$(unique_path "${DEPLOY_DIR}/server.incoming-${timestamp}")"
  mkdir "${incoming}"

  detect_default_source_dir
  if [[ -n "${SOURCE_DIR}" ]]; then
    revision="$(stage_from_source_dir "${incoming}")"
  else
    revision="$(stage_from_remote_git "${incoming}")"
  fi

  if [[ -d "${SERVER_DIR}" ]]; then
    previous_bundle="$(unique_path "${DEPLOY_DIR}/server.prev-${timestamp}")"
    mv "${SERVER_DIR}" "${previous_bundle}" || die "failed to move current server bundle to ${previous_bundle}"
  fi
  mv "${incoming}" "${SERVER_DIR}" || die "failed to promote incoming server bundle to ${SERVER_DIR}"
  printf '%s\n' "${revision}" > "${DEPLOY_DIR}/DEPLOYED_REVISION"
  date -u +%Y-%m-%dT%H:%M:%SZ > "${DEPLOY_DIR}/DEPLOYED_AT"

  return 0
}

latest_previous_bundle() {
  [[ -d "${DEPLOY_DIR}" ]] || return 0
  find "${DEPLOY_DIR}" -maxdepth 1 -type d -name 'server.prev-*' -print | sort | tail -n 1

  return 0
}
