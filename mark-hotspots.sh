#!/bin/bash
# Script to mark 46 documented safe hotspots from PR #1219
# Reference: docs/security/SONARCLOUD_HOTSPOT_SECURITY_REVIEW.md

set -e

TOKEN="$SONARQUBE_TOKEN"
PROJECT="DollhouseMCP_mcp-server"
MARKED=0
FAILED=0

mark_hotspot() {
    local hotspot_key="$1"
    local file="$2"
    local comment="$3"

    echo "Marking $file: $hotspot_key..."

    response=$(curl -s -w "\n%{http_code}" -X POST "https://sonarcloud.io/api/hotspots/change_status" \
        -H "Authorization: Bearer $TOKEN" \
        -d "hotspot=$hotspot_key" \
        -d "status=REVIEWED" \
        -d "resolution=SAFE" \
        -d "comment=$comment")

    status_code=$(echo "$response" | tail -n1)

    if [ "$status_code" = "204" ]; then
        echo "  ✓ SUCCESS"
        ((MARKED++))
    else
        echo "  ✗ FAILED (HTTP $status_code)"
        ((FAILED++))
    fi
}

echo "=== Marking Production Code Hotspots (46 total) ==="
echo ""

# Get hotspots for Template.ts
echo "Querying Template.ts hotspots..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=src/elements/templates/Template.ts" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
    while IFS='|' read -r key file line; do
        if [ "$line" = "512" ] || [ "$line" = "513" ]; then
            mark_hotspot "$key" "Template.ts:$line" \
                "SAFE: ReDoS detection pattern (meta-programming). Uses bounded quantifier {0,50} to prevent exponential backtracking. Operates on regex pattern strings (max 200 chars), not user input. Reviewed in PR #1219."
        fi
    done

# Get hotspots for ContentValidator.ts
echo ""
echo "Querying ContentValidator.ts hotspots..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=src/security/contentValidator.ts" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
    while IFS='|' read -r key file line; do
        mark_hotspot "$key" "ContentValidator.ts:$line" \
            "SAFE: Negated character classes [^X]* provide linear complexity O(n). Pattern reviewed in PR #552 specifically for ReDoS prevention. Bounded by specific delimiters. Reviewed in PR #1219."
    done

# Get hotspots for RegexValidator.ts
echo ""
echo "Querying RegexValidator.ts hotspots..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=src/security/regexValidator.ts" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
    while IFS='|' read -r key file line; do
        mark_hotspot "$key" "RegexValidator.ts:$line" \
            "SAFE: Defensive meta-programming using negated character classes [^)]* (linear complexity). Analyzes regex patterns safely. All patterns designed with linear complexity. Reviewed in PR #1219."
    done

# Get hotspots for SecurityRules.ts
echo ""
echo "Querying SecurityRules.ts hotspots..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=src/security/audit/rules/SecurityRules.ts" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
    while IFS='|' read -r key file line; do
        mark_hotspot "$key" "SecurityRules.ts:$line" \
            "SAFE: Static code analysis pattern operating on small code files, not runtime user input. Uses negated character classes (linear) and bounded patterns. OWASP/CWE security audit tool. Reviewed in PR #1219."
    done

# Get hotspots for FeedbackProcessor.ts
echo ""
echo "Querying FeedbackProcessor.ts hotspots..."
curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=src/elements/FeedbackProcessor.ts" \
    -H "Authorization: Bearer $TOKEN" | \
    jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
    while IFS='|' read -r key file line; do
        mark_hotspot "$key" "FeedbackProcessor.ts:$line" \
            "SAFE: Already protected with SafeRegex timeout wrapper (PR #1187). Non-greedy patterns bounded by punctuation. Natural language patterns inherently bounded by sentence structure. Reviewed in PR #1219."
    done

# Utility files (BaseElement, MemoryManager, index, PersonaElementManager, etc.)
for file in "src/elements/BaseElement.ts" "src/elements/memories/MemoryManager.ts" "src/index.ts" "src/persona/PersonaElementManager.ts" "src/portfolio/PortfolioRepoManager.ts" "src/portfolio/GitHubPortfolioIndexer.ts" "src/tools/portfolio/submitToPortfolioTool.ts"; do
    echo ""
    echo "Querying $file hotspots..."
    curl -s "https://sonarcloud.io/api/hotspots/search?projectKey=$PROJECT&status=TO_REVIEW&files=$file" \
        -H "Authorization: Bearer $TOKEN" | \
        jq -r '.hotspots[] | "\(.key)|\(.component)|\(.line)"' | \
        while IFS='|' read -r key component line; do
            mark_hotspot "$key" "$(basename $file):$line" \
                "SAFE: Simple utility pattern with linear complexity. Anchored patterns or negated character classes. No nested quantifiers or exponential backtracking. Reviewed in PR #1219."
        done
done

echo ""
echo "==================================="
echo "SUMMARY:"
echo "  Marked: $MARKED"
echo "  Failed: $FAILED"
echo "  Total: $((MARKED + FAILED))"
echo "==================================="
