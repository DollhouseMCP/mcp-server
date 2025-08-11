#!/bin/bash
# Integration test script for collection submission workflow
# This script verifies the complete workflow from portfolio upload to collection submission

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test configuration
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TEST_PERSONA_MANUAL="Test-Manual-${TIMESTAMP}"
TEST_PERSONA_AUTO="Test-Auto-${TIMESTAMP}"
GITHUB_USER="${GITHUB_USER:-mickdarling}"
PORTFOLIO_REPO="dollhouse-portfolio"

# Function to print colored output
print_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Pre-flight checks
print_test "Running pre-flight checks..."

if ! command_exists gh; then
    print_error "GitHub CLI (gh) is not installed"
    echo "Please install: brew install gh"
    exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
    print_error "Not authenticated with GitHub"
    echo "Please run: gh auth login"
    exit 1
fi

print_success "Pre-flight checks passed"

# Test 1: Check GitHub portfolio repository
print_test "Checking GitHub portfolio repository..."
if gh repo view "${GITHUB_USER}/${PORTFOLIO_REPO}" >/dev/null 2>&1; then
    print_success "Portfolio repository exists: https://github.com/${GITHUB_USER}/${PORTFOLIO_REPO}"
else
    print_error "Portfolio repository not found (will be created on first submission)"
fi

# Test 2: Check collection repository access
print_test "Checking collection repository access..."
if gh repo view "DollhouseMCP/collection" >/dev/null 2>&1; then
    print_success "Collection repository accessible"
else
    print_error "Cannot access DollhouseMCP/collection repository"
fi

# Test 3: Create test personas locally
print_test "Creating test personas in local portfolio..."

# Create test persona for manual submission
cat > "$HOME/.dollhouse/portfolio/personas/${TEST_PERSONA_MANUAL}.md" << EOF
---
name: ${TEST_PERSONA_MANUAL}
description: Test persona for manual collection submission
category: testing
author: ${GITHUB_USER}
version: 1.0.0
created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
---

# ${TEST_PERSONA_MANUAL}

This is a test persona created for integration testing of the collection submission workflow.

## Purpose
- Test portfolio upload without auto-submission
- Verify manual submission workflow
- Validate error messages and user guidance

## Instructions
You are a helpful test assistant designed to validate the DollhouseMCP collection submission workflow.
EOF

print_success "Created test persona: ${TEST_PERSONA_MANUAL}"

# Create test persona for auto submission
cat > "$HOME/.dollhouse/portfolio/personas/${TEST_PERSONA_AUTO}.md" << EOF
---
name: ${TEST_PERSONA_AUTO}
description: Test persona for automatic collection submission
category: testing
author: ${GITHUB_USER}
version: 1.0.0
created: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
---

# ${TEST_PERSONA_AUTO}

This is a test persona created for integration testing of the automatic collection submission feature.

## Purpose
- Test portfolio upload with auto-submission enabled
- Verify GitHub issue creation in collection repository
- Validate complete end-to-end workflow

## Instructions
You are an automated test assistant that helps verify the complete collection submission workflow.
EOF

print_success "Created test persona: ${TEST_PERSONA_AUTO}"

# Test 4: Check environment variables
print_test "Checking environment configuration..."
if [ -z "$DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION" ]; then
    echo "  DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION is not set (defaults to false)"
else
    echo "  DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = $DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION"
fi

# Test 5: Test manual submission (auto-submit disabled)
print_test "Testing manual submission workflow (auto-submit disabled)..."
export DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=false
echo "  Set DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=false"
echo "  To test: submit_content \"${TEST_PERSONA_MANUAL}\""
echo "  Expected: Upload to portfolio only, no collection issue"

# Test 6: Test automatic submission (auto-submit enabled)
print_test "Testing automatic submission workflow (auto-submit enabled)..."
export DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=true
echo "  Set DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=true"
echo "  To test: submit_content \"${TEST_PERSONA_AUTO}\""
echo "  Expected: Upload to portfolio AND create collection issue"

# Test 7: Check recent issues in collection
print_test "Checking recent issues in collection repository..."
echo "Recent issues in DollhouseMCP/collection:"
gh issue list --repo DollhouseMCP/collection --limit 5 --json number,title,labels,author --jq '.[] | "  #\(.number): \(.title) by @\(.author.login)"'

# Test 8: Verify portfolio contents
print_test "Checking portfolio repository contents..."
if gh repo view "${GITHUB_USER}/${PORTFOLIO_REPO}" >/dev/null 2>&1; then
    echo "Recent commits in portfolio:"
    gh api "repos/${GITHUB_USER}/${PORTFOLIO_REPO}/commits" --jq '.[0:3] | .[] | "  \(.sha[0:7]): \(.commit.message | split("\n")[0])"' 2>/dev/null || echo "  No commits yet"
fi

# Summary
echo ""
echo "========================================="
echo "Integration Test Setup Complete"
echo "========================================="
echo ""
echo "Test Personas Created:"
echo "  1. ${TEST_PERSONA_MANUAL} (for manual submission)"
echo "  2. ${TEST_PERSONA_AUTO} (for auto submission)"
echo ""
echo "Next Steps:"
echo "  1. Open Claude Desktop"
echo "  2. Test manual submission:"
echo "     - Run: configure_collection_submission autoSubmit: false"
echo "     - Run: submit_content \"${TEST_PERSONA_MANUAL}\""
echo "     - Verify: Portfolio upload only"
echo ""
echo "  3. Test auto submission:"
echo "     - Run: configure_collection_submission autoSubmit: true"
echo "     - Run: submit_content \"${TEST_PERSONA_AUTO}\""
echo "     - Verify: Portfolio upload + collection issue"
echo ""
echo "  4. Check results:"
echo "     - Portfolio: https://github.com/${GITHUB_USER}/${PORTFOLIO_REPO}"
echo "     - Collection: https://github.com/DollhouseMCP/collection/issues"
echo ""

# Cleanup reminder
print_test "Remember to clean up test data after testing:"
echo "  rm ~/.dollhouse/portfolio/personas/${TEST_PERSONA_MANUAL}.md"
echo "  rm ~/.dollhouse/portfolio/personas/${TEST_PERSONA_AUTO}.md"
echo "  Close any test issues in the collection repository"

# Reset environment
unset DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION
print_success "Environment reset to default state"