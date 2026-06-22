#!/usr/bin/env bash

# DollhouseMCP hosted deployment helper.
#
# Thin entrypoint for the repo-owned precursor to a public one-line installer.
# Implementation lives in scripts/hosted-deploy/ so deployment concerns stay
# reviewable as the hosted, local/LAN, and enterprise paths grow.

set -euo pipefail

HOSTED_DEPLOY_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOSTED_DEPLOY_REPO_ROOT="$(cd "${HOSTED_DEPLOY_SCRIPT_DIR}/.." && pwd)"
HOSTED_DEPLOY_LIB_DIR="${HOSTED_DEPLOY_SCRIPT_DIR}/hosted-deploy"

# shellcheck source=scripts/hosted-deploy/logging.sh
. "${HOSTED_DEPLOY_LIB_DIR}/logging.sh"
# shellcheck source=scripts/hosted-deploy/config.sh
. "${HOSTED_DEPLOY_LIB_DIR}/config.sh"
# shellcheck source=scripts/hosted-deploy/modes.sh
. "${HOSTED_DEPLOY_LIB_DIR}/modes.sh"
# shellcheck source=scripts/hosted-deploy/validation.sh
. "${HOSTED_DEPLOY_LIB_DIR}/validation.sh"
# shellcheck source=scripts/hosted-deploy/env.sh
. "${HOSTED_DEPLOY_LIB_DIR}/env.sh"
# shellcheck source=scripts/hosted-deploy/render.sh
. "${HOSTED_DEPLOY_LIB_DIR}/render.sh"
# shellcheck source=scripts/hosted-deploy/source.sh
. "${HOSTED_DEPLOY_LIB_DIR}/source.sh"
# shellcheck source=scripts/hosted-deploy/runtime.sh
. "${HOSTED_DEPLOY_LIB_DIR}/runtime.sh"
# shellcheck source=scripts/hosted-deploy/dry-run.sh
. "${HOSTED_DEPLOY_LIB_DIR}/dry-run.sh"
# shellcheck source=scripts/hosted-deploy/actions.sh
. "${HOSTED_DEPLOY_LIB_DIR}/actions.sh"

hosted_deploy_main "$@"
