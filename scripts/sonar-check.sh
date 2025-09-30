#!/bin/bash
# On-demand SonarCloud status checker
# Uses SONAR_TOKEN environment variable or prompts for it
# Usage: ./scripts/sonar-check.sh [pr-number]

set -e

PROJECT_KEY="DollhouseMCP_mcp-server"
ORG="dollhousemcp"
SONAR_URL="https://sonarcloud.io"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check for token
if [ -z "$SONAR_TOKEN" ]; then
    echo -e "${YELLOW}⚠️  SONAR_TOKEN not set in environment${NC}"
    echo "Set it with: export SONAR_TOKEN=your-token"
    exit 1
fi

# Function to make API calls
sonar_api() {
    local endpoint=$1
    curl -s -u "$SONAR_TOKEN:" "$SONAR_URL/api/$endpoint"
}

# Check if PR number provided
PR_NUMBER=$1

echo -e "${BLUE}🔍 SonarCloud Status Check${NC}"
echo "Project: $PROJECT_KEY"
echo "---"

if [ -n "$PR_NUMBER" ]; then
    # Check PR-specific quality gate
    echo -e "${BLUE}Checking PR #$PR_NUMBER...${NC}"

    QG_RESPONSE=$(sonar_api "qualitygates/project_status?projectKey=$PROJECT_KEY&pullRequest=$PR_NUMBER")
    STATUS=$(echo "$QG_RESPONSE" | jq -r '.projectStatus.status')

    if [ "$STATUS" = "OK" ] || [ "$STATUS" = "PASSED" ]; then
        echo -e "${GREEN}✅ Quality Gate: PASSED${NC}"
    elif [ "$STATUS" = "ERROR" ] || [ "$STATUS" = "FAILED" ]; then
        echo -e "${RED}❌ Quality Gate: FAILED${NC}"
        echo ""
        echo "Failed conditions:"
        echo "$QG_RESPONSE" | jq -r '.projectStatus.conditions[] | select(.status=="ERROR") | "  - \(.metricKey): \(.actualValue) (threshold: \(.errorThreshold))"'
    else
        echo -e "${YELLOW}⏳ Quality Gate: $STATUS${NC}"
    fi

    # Get issue counts
    echo ""
    echo -e "${BLUE}Issues in PR:${NC}"
    ISSUES=$(sonar_api "issues/search?componentKeys=$PROJECT_KEY&pullRequest=$PR_NUMBER&resolved=false")

    BUGS=$(echo "$ISSUES" | jq '[.issues[] | select(.type=="BUG")] | length')
    VULNERABILITIES=$(echo "$ISSUES" | jq '[.issues[] | select(.type=="VULNERABILITY")] | length')
    CODE_SMELLS=$(echo "$ISSUES" | jq '[.issues[] | select(.type=="CODE_SMELL")] | length')

    echo "  🐛 Bugs: $BUGS"
    echo "  🔒 Vulnerabilities: $VULNERABILITIES"
    echo "  💡 Code Smells: $CODE_SMELLS"

    # Show top issues
    if [ "$BUGS" -gt 0 ] || [ "$VULNERABILITIES" -gt 0 ]; then
        echo ""
        echo -e "${YELLOW}Top Issues:${NC}"
        echo "$ISSUES" | jq -r '.issues[:5] | .[] | "  [\(.severity)] \(.message) - \(.component)"'
    fi

    echo ""
    echo -e "${BLUE}🔗 View on SonarCloud:${NC}"
    echo "   $SONAR_URL/project/pull_requests_list?id=$PROJECT_KEY"

else
    # Check main branch quality gate
    echo -e "${BLUE}Checking main branch...${NC}"

    QG_RESPONSE=$(sonar_api "qualitygates/project_status?projectKey=$PROJECT_KEY")
    STATUS=$(echo "$QG_RESPONSE" | jq -r '.projectStatus.status')

    if [ "$STATUS" = "OK" ] || [ "$STATUS" = "PASSED" ]; then
        echo -e "${GREEN}✅ Quality Gate: PASSED${NC}"
    elif [ "$STATUS" = "ERROR" ] || [ "$STATUS" = "FAILED" ]; then
        echo -e "${RED}❌ Quality Gate: FAILED${NC}"
    else
        echo -e "${YELLOW}⏳ Quality Gate: $STATUS${NC}"
    fi

    # Get project measures
    echo ""
    echo -e "${BLUE}Project Metrics:${NC}"
    MEASURES=$(sonar_api "measures/component?component=$PROJECT_KEY&metricKeys=bugs,vulnerabilities,code_smells,coverage,duplicated_lines_density,ncloc")

    echo "$MEASURES" | jq -r '.component.measures[] | "  \(.metric): \(.value)"' | while read line; do
        case $line in
            *bugs:*) echo -e "  🐛 $line" ;;
            *vulnerabilities:*) echo -e "  🔒 $line" ;;
            *code_smells:*) echo -e "  💡 $line" ;;
            *coverage:*) echo -e "  📊 $line%" ;;
            *duplicated_lines_density:*) echo -e "  📋 $line% duplicated" ;;
            *ncloc:*) echo -e "  📝 $line lines of code" ;;
            *) echo "  $line" ;;
        esac
    done

    echo ""
    echo -e "${BLUE}🔗 View on SonarCloud:${NC}"
    echo "   $SONAR_URL/dashboard?id=$PROJECT_KEY"
fi

echo ""
echo -e "${GREEN}✓ Done${NC}"