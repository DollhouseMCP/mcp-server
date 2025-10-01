#!/bin/bash
# Mark evaluated test/archive/script hotspots as SAFE
# Categories: command-injection (2), dos (27), weak-cryptography (26)
# Total: 55 hotspots

set -e
TOKEN="$SONARQUBE_TOKEN"
PROJECT="DollhouseMCP_mcp-server"
MARKED=0
FAILED=0

mark_hotspot() {
    local key="$1"
    local comment="$2"
    
    result=$(curl -s -w "%{http_code}" -X POST "https://sonarcloud.io/api/hotspots/change_status" \
        -H "Authorization: Bearer $TOKEN" \
        -d "hotspot=$key" \
        -d "status=REVIEWED" \
        -d "resolution=SAFE" \
        -d "comment=$comment" \
        -o /dev/null)
    
    if [ "$result" = "204" ]; then
        echo "  ✓ $key"
        ((MARKED++))
    else
        echo "  ✗ $key (HTTP $result)"
        ((FAILED++))
    fi
    sleep 0.3  # Rate limiting
}

echo "=== Marking Test File Hotspots (55 total) ==="
echo ""

# Command Injection (2) - Test files with hardcoded/controlled commands
echo "1. Command Injection (2 hotspots)..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&securityCategory=command-injection&ps=10" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | select(.component | test("test/|archive/|scripts/")) | "\(.key)|\(.component)"' | \
    while IFS='|' read -r key file; do
        mark_hotspot "$key" "SAFE: Test file with hardcoded commands or system-generated paths. Not exposed to production runtime or user input."
    done

echo ""
echo "2. DOS/ReDoS (27 hotspots)..."
# Get first page (100 results)
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&securityCategory=dos&ps=100" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | select(.component | test("test/|archive/|scripts/")) | "\(.key)|\(.component)"' | \
    while IFS='|' read -r key file; do
        mark_hotspot "$key" "SAFE: Test file validating regex patterns or using patterns in controlled test environment. Not exposed to production runtime or user input."
    done

echo ""
echo "3. Weak Cryptography (26 hotspots)..."
# Get first page
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&securityCategory=weak-cryptography&ps=100" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | select(.component | test("test/|archive/|scripts/")) | "\(.key)|\(.component)"' | \
    while IFS='|' read -r key file; do
        mark_hotspot "$key" "SAFE: Test file using Math.random() or weak crypto for test data generation, not security. Controlled test environment, not production runtime."
    done

echo ""
echo "==================================="
echo "Summary: ✓$MARKED ✗$FAILED"
echo "==================================="
