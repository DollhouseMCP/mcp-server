#!/bin/bash

# Simple script to add issues to GitHub Project
# Usage: ./scripts/link-issues-to-project.sh <PROJECT_NUMBER>

set -e

PROJECT_NUMBER=${1:-1}

# Ensure PROJECT_NUMBER is an integer
if ! [[ "$PROJECT_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "Error: Project number must be a number, got: $PROJECT_NUMBER"
    echo "Usage: $0 <PROJECT_NUMBER>"
    exit 1
fi

# Convert to integer explicitly
PROJECT_NUM=$((PROJECT_NUMBER))

echo "Adding issues to project #$PROJECT_NUM..."
echo ""

# Get current user
OWNER=$(gh api user --jq .login)
echo "Project owner: $OWNER"

# Get project ID - use -F for integer field
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
    echo ""
    echo "Error: Could not find project #$PROJECT_NUMBER"
    echo ""
    echo "This could be because:"
    echo "1. The project doesn't exist at https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"
    echo "2. Your GitHub token needs additional permissions"
    echo ""
    echo "To fix token permissions:"
    echo "  gh auth refresh -s project"
    echo ""
    echo "Or if you see a permissions error above, run:"
    echo "  gh auth refresh -s read:project,project,write:org"
    echo ""
    exit 1
fi

echo "Found project ID: $PROJECT_ID"
echo ""

# Get repository info
REPO_OWNER=$(gh repo view --json owner --jq .owner.login)
REPO_NAME=$(gh repo view --json name --jq .name)

# Get all issue numbers
ISSUES=$(gh issue list --limit 100 --state open --json number --jq '.[].number')

SUCCESS=0
TOTAL=0

for ISSUE_NUMBER in $ISSUES; do
    TOTAL=$((TOTAL + 1))
    echo -n "Adding issue #$ISSUE_NUMBER... "
    
    # Get issue ID
    ISSUE_ID=$(gh api repos/$REPO_OWNER/$REPO_NAME/issues/$ISSUE_NUMBER --jq .node_id)
    
    # Add to project
    if gh api graphql -f query='
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item {
            id
          }
        }
      }
    ' -f projectId="$PROJECT_ID" -f contentId="$ISSUE_ID" >/dev/null 2>&1; then
        echo "✓"
        SUCCESS=$((SUCCESS + 1))
    else
        echo "✗ (may already be in project)"
    fi
done

echo ""
echo "Complete! Added $SUCCESS of $TOTAL issues to project."
echo "View at: https://github.com/users/$OWNER/projects/$PROJECT_NUMBER"