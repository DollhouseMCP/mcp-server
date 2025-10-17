#!/usr/bin/env bash
#
# MCP Registry Workflow Validation Script
#
# This script validates the MCP registry publishing workflow configuration
# without actually publishing. It checks:
# - Workflow YAML syntax
# - server.json existence and validity
# - Version consistency across files
# - Required fields in server.json
# - Namespace casing
# - Package.json files array
#
# Exit codes:
#   0 - All validations passed
#   1 - Validation failure
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Project root (2 levels up from test/workflows/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# File paths
WORKFLOW_FILE="${PROJECT_ROOT}/.github/workflows/publish-mcp-registry.yml"
SERVER_JSON="${PROJECT_ROOT}/server.json"
PACKAGE_JSON="${PROJECT_ROOT}/package.json"

# Test results counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Print functions
print_header() {
    echo ""
    echo "=========================================="
    echo "$1"
    echo "=========================================="
}

print_test() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo -n "  Test ${TESTS_RUN}: $1 ... "
}

print_pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}PASS${NC}"
}

print_fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "${RED}FAIL${NC}"
    if [ -n "${1:-}" ]; then
        echo -e "    ${RED}Error: $1${NC}"
    fi
}

print_info() {
    echo -e "    ${YELLOW}Info: $1${NC}"
}

# Validation functions
validate_file_exists() {
    local file="$1"
    local name="$2"

    print_test "$name exists"
    if [ -f "$file" ]; then
        print_pass
        return 0
    else
        print_fail "$name not found at $file"
        return 1
    fi
}

validate_json_syntax() {
    local file="$1"
    local name="$2"

    print_test "$name is valid JSON"
    if jq empty "$file" 2>/dev/null; then
        print_pass
        return 0
    else
        print_fail "$name has invalid JSON syntax"
        return 1
    fi
}

validate_yaml_syntax() {
    local file="$1"
    local name="$2"

    print_test "$name is valid YAML"
    # Try to parse YAML using python or ruby if available
    if command -v python3 &> /dev/null; then
        if python3 -c "import yaml; yaml.safe_load(open('$file'))" 2>/dev/null; then
            print_pass
            return 0
        else
            print_fail "$name has invalid YAML syntax"
            return 1
        fi
    elif command -v ruby &> /dev/null; then
        if ruby -e "require 'yaml'; YAML.load_file('$file')" 2>/dev/null; then
            print_pass
            return 0
        else
            print_fail "$name has invalid YAML syntax"
            return 1
        fi
    else
        print_info "No YAML parser available (python3 or ruby), skipping syntax check"
        print_pass
        return 0
    fi
}

validate_version_consistency() {
    print_test "Versions match between server.json and package.json"

    local server_version=$(jq -r '.version' "$SERVER_JSON")
    local package_version=$(jq -r '.version' "$PACKAGE_JSON")

    if [ "$server_version" = "$package_version" ]; then
        print_pass
        print_info "Version: $server_version"
        return 0
    else
        print_fail "server.json version ($server_version) != package.json version ($package_version)"
        return 1
    fi
}

validate_server_json_required_fields() {
    local field="$1"
    local description="$2"

    print_test "server.json has required field: $field"

    local value=$(jq -r ".$field" "$SERVER_JSON")

    if [ "$value" != "null" ] && [ -n "$value" ]; then
        print_pass
        print_info "$description: $value"
        return 0
    else
        print_fail "server.json missing or empty field: $field"
        return 1
    fi
}

validate_namespace_casing() {
    print_test "Namespace uses correct casing (DollhouseMCP)"

    local name=$(jq -r '.name' "$SERVER_JSON")

    if echo "$name" | grep -q "DollhouseMCP"; then
        print_pass
        print_info "Name: $name"
        return 0
    else
        print_fail "Expected 'DollhouseMCP' (correct casing) in name: $name"
        return 1
    fi
}

validate_packages_array() {
    print_test "server.json has packages array with at least one entry"

    local packages_count=$(jq '.packages | length' "$SERVER_JSON")

    if [ "$packages_count" -gt 0 ]; then
        print_pass
        print_info "Package count: $packages_count"
        return 0
    else
        print_fail "server.json packages array is empty"
        return 1
    fi
}

validate_npm_package_in_packages() {
    print_test "server.json packages includes NPM package"

    local npm_identifier=$(jq -r '.packages[] | select(.registryType == "npm") | .identifier' "$SERVER_JSON")
    local package_name=$(jq -r '.name' "$PACKAGE_JSON")

    if [ "$npm_identifier" = "$package_name" ]; then
        print_pass
        print_info "NPM package: $npm_identifier"
        return 0
    else
        print_fail "NPM package identifier mismatch: $npm_identifier != $package_name"
        return 1
    fi
}

validate_server_json_in_files() {
    print_test "server.json is in package.json files array"

    local in_files=$(jq '.files[] | select(. == "server.json")' "$PACKAGE_JSON")

    if [ -n "$in_files" ]; then
        print_pass
        return 0
    else
        print_fail "server.json not found in package.json files array"
        return 1
    fi
}

validate_workflow_oidc_permissions() {
    print_test "Workflow has correct OIDC permissions"

    if grep -q "id-token: write" "$WORKFLOW_FILE" && grep -q "contents: read" "$WORKFLOW_FILE"; then
        print_pass
        return 0
    else
        print_fail "Workflow missing required OIDC permissions (id-token: write, contents: read)"
        return 1
    fi
}

validate_workflow_uses_pinned_version() {
    print_test "Workflow uses pinned mcp-publisher version (not latest)"

    if grep -q "releases/download/v[0-9]" "$WORKFLOW_FILE"; then
        local version=$(grep -o "releases/download/v[0-9]\.[0-9]\.[0-9]" "$WORKFLOW_FILE" | head -1)
        print_pass
        print_info "Using pinned version: $version"
        return 0
    else
        print_fail "Workflow not using pinned version (should use releases/download/vX.Y.Z, not latest)"
        return 1
    fi
}

validate_workflow_has_dry_run() {
    print_test "Workflow has dry-run capability"

    if grep -q "dry_run" "$WORKFLOW_FILE" || grep -q "dry-run" "$WORKFLOW_FILE"; then
        print_pass
        return 0
    else
        print_fail "Workflow missing dry-run capability"
        return 1
    fi
}

# Main execution
main() {
    print_header "MCP Registry Workflow Validation"

    echo "Project Root: $PROJECT_ROOT"
    echo ""

    # File existence checks
    print_header "File Existence Checks"
    validate_file_exists "$WORKFLOW_FILE" "Workflow file" || true
    validate_file_exists "$SERVER_JSON" "server.json" || true
    validate_file_exists "$PACKAGE_JSON" "package.json" || true

    # If critical files don't exist, exit early
    if [ ! -f "$SERVER_JSON" ] || [ ! -f "$PACKAGE_JSON" ]; then
        echo ""
        echo -e "${RED}Critical files missing. Cannot continue validation.${NC}"
        exit 1
    fi

    # Syntax validation
    print_header "Syntax Validation"
    validate_yaml_syntax "$WORKFLOW_FILE" "Workflow YAML" || true
    validate_json_syntax "$SERVER_JSON" "server.json" || true
    validate_json_syntax "$PACKAGE_JSON" "package.json" || true

    # Version consistency
    print_header "Version Consistency"
    validate_version_consistency || true

    # server.json structure
    print_header "server.json Structure"
    validate_server_json_required_fields "name" "Name" || true
    validate_server_json_required_fields "version" "Version" || true
    validate_server_json_required_fields "description" "Description" || true
    validate_namespace_casing || true
    validate_packages_array || true
    validate_npm_package_in_packages || true

    # package.json structure
    print_header "package.json Structure"
    validate_server_json_in_files || true

    # Workflow validation
    print_header "Workflow Configuration"
    validate_workflow_oidc_permissions || true
    validate_workflow_uses_pinned_version || true
    validate_workflow_has_dry_run || true

    # Results summary
    print_header "Test Results Summary"
    echo "  Total tests run: $TESTS_RUN"
    echo -e "  Tests passed:    ${GREEN}$TESTS_PASSED${NC}"
    echo -e "  Tests failed:    ${RED}$TESTS_FAILED${NC}"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}All validations passed!${NC}"
        exit 0
    else
        echo -e "${RED}Some validations failed. Please review the errors above.${NC}"
        exit 1
    fi
}

# Run main function
main
