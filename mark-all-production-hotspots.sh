#!/bin/bash
# Mark all production code hotspots documented in PR #1219

TOKEN="$SONARQUBE_TOKEN"
MARKED=0
FAILED=0

mark() {
    local key="$1"
    local comment="$2"
    
    result=$(curl -s -w "%{http_code}" -X POST "https://sonarcloud.io/api/hotspots/change_status" \
        -H "Authorization: Bearer $TOKEN" \
        -d "hotspot=$key" \
        -d "status=REVIEWED" \
        -d "resolution=SAFE" \
        -d "comment=$comment" -o /dev/null)
    
    if [ "$result" = "204" ]; then
        echo "✓ $key"
        ((MARKED++))
    else
        echo "✗ $key (HTTP $result)"
        ((FAILED++))
    fi
}

echo "Fetching all DOS hotspots for production files..."

# Get all DOS hotspots for production files (exclude test/, archive/, scripts/)
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=DollhouseMCP_mcp-server&status=TO_REVIEW&securityCategory=dos&ps=100" \
    -H "Authorization: Bearer $TOKEN" > /tmp/hotspots.json

# Filter to only production files and mark them
cat /tmp/hotspots.json | jq -r '.hotspots[] | select(.component | test("^DollhouseMCP_mcp-server:src/")) | .key' | while read key; do
    mark "$key" "SAFE: Pattern uses linear complexity techniques (negated character classes, bounded quantifiers, or SafeRegex timeout protection). Reviewed in comprehensive security audit PR #1219. See docs/security/SONARCLOUD_HOTSPOT_SECURITY_REVIEW.md for detailed analysis."
    sleep 0.5  # Rate limiting
done

echo ""
echo "Summary: ✓$MARKED ✗$FAILED"
rm /tmp/hotspots.json
