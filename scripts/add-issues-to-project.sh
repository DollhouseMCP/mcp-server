#!/bin/bash

# Script to add all open issues to a GitHub Project
# Requires: gh CLI with project permissions

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}GitHub Project Issue Linker${NC}"
echo "============================"

# Get project URL from user
echo -e "\n${GREEN}Please provide your project details:${NC}"
echo "1. Go to your project board"
echo "2. The URL should look like: https://github.com/users/mickdarling/projects/1"
echo ""
read -p "Enter your project NUMBER (just the number, e.g., 1): " PROJECT_NUMBER

# Validate input
if ! [[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Project number must be a number${NC}"
    exit 1
fi

# Get owner (username or organization)
OWNER=$(gh api user --jq .login)
echo -e "${GREEN}Detected owner: $OWNER${NC}"

# Get project ID using GraphQL
echo -e "\n${YELLOW}Finding project...${NC}"
# Convert to integer
PROJECT_NUM=$((PROJECT_NUMBER))
PROJECT_ID=$(gh api graphql -f query='
  query($owner: String!, $number: Int!) {
    user(login: $owner) {
      projectV2(number: $number) {
        id
      }
    }
  }
' -f owner="$OWNER" -F number=$PROJECT_NUM --jq .data.user.projectV2.id)

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "null" ]; then
    echo -e "${RED}Error: Could not find project #$PROJECT_NUMBER for user $OWNER${NC}"
    echo "Make sure the project exists and you have access to it."
    exit 1
fi

echo -e "${GREEN}Found project ID: $PROJECT_ID${NC}"

# Get repository node ID
REPO_OWNER=$(gh repo view --json owner --jq .owner.login)
REPO_NAME=$(gh repo view --json name --jq .name)
REPO_ID=$(gh api repos/$REPO_OWNER/$REPO_NAME --jq .node_id)

echo -e "${GREEN}Repository: $REPO_OWNER/$REPO_NAME${NC}"

# Get all open issues
echo -e "\n${YELLOW}Fetching open issues...${NC}"
ISSUES=$(gh issue list --limit 100 --state open --json number,title)
ISSUE_COUNT=$(echo "$ISSUES" | jq length)

echo -e "${GREEN}Found $ISSUE_COUNT open issues${NC}"

# Add each issue to the project
SUCCESS=0
FAILED=0

echo -e "\n${YELLOW}Adding issues to project...${NC}"
echo "$ISSUES" | jq -c '.[]' | while read -r issue; do
    NUMBER=$(echo "$issue" | jq -r .number)
    TITLE=$(echo "$issue" | jq -r .title)
    
    echo -n "Adding #$NUMBER: $TITLE... "
    
    # Get issue node ID
    ISSUE_ID=$(gh api repos/$REPO_OWNER/$REPO_NAME/issues/$NUMBER --jq .node_id)
    
    # Add to project using GraphQL
    RESULT=$(gh api graphql -f query='
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item {
            id
          }
        }
      }
    ' -f projectId="$PROJECT_ID" -f contentId="$ISSUE_ID" 2>&1)
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
        ((SUCCESS++)) || true
    else
        # Check if already in project
        if echo "$RESULT" | grep -q "already exists"; then
            echo -e "${YELLOW}Already in project${NC}"
            ((SUCCESS++)) || true
        else
            echo -e "${RED}✗${NC}"
            echo -e "${RED}  Error: $RESULT${NC}"
            ((FAILED++)) || true
        fi
    fi
done

# Summary
echo -e "\n${GREEN}=== Summary ===${NC}"
echo -e "Successfully added: ${GREEN}$SUCCESS${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [ $FAILED -eq 0 ]; then
    echo -e "\n${GREEN}All issues successfully added to project!${NC}"
    echo -e "\nView your project at: https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"
else
    echo -e "\n${YELLOW}Some issues could not be added. They may already be in the project.${NC}"
fi

echo -e "\n${GREEN}Tip:${NC} To manage your project board:"
echo "- Set up automation rules in project settings"
echo "- Create custom views for different workflows"
echo "- Use the project board URL above to access it quickly"