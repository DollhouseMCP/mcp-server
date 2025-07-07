#!/bin/bash

# Example script showing the exact GraphQL mutations for updating priority field options
# This is a reference implementation showing the specific mutation format

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}=== GitHub Project Priority Field GraphQL Examples ===${NC}"
echo ""

# Example 1: Update a single option (as shown in the user's example)
echo -e "${YELLOW}Example 1: Update P0 to '🔴 High'${NC}"
echo "This mutation updates a single priority option:"
echo ""
cat << 'EOF'
gh api graphql -f query='
mutation {
  updateProjectV2SingleSelectField(
    input: {
      projectId: "PVT_kwHOAALP3s4A9HI_"
      fieldId: "PVTSSF_lAHOAALP3s4A9HI_zgw6V80"
      options: [{
        id: "cbf87afa"
        name: "🔴 High"
        color: RED
      }]
    }
  ) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        name
        options {
          id
          name
          color
        }
      }
    }
  }
}'
EOF

echo ""
echo -e "${YELLOW}Example 2: Update all three priority options at once${NC}"
echo "This mutation updates P0, P1, and P2 in a single call:"
echo ""
cat << 'EOF'
gh api graphql -f query='
mutation {
  updateProjectV2SingleSelectField(
    input: {
      projectId: "PVT_kwHOAALP3s4A9HI_"
      fieldId: "PVTSSF_lAHOAALP3s4A9HI_zgw6V80"
      options: [
        {
          id: "cbf87afa"
          name: "🔴 High"
          color: RED
        },
        {
          id: "option_id_for_p1"
          name: "🟡 Medium"
          color: YELLOW
        },
        {
          id: "option_id_for_p2"
          name: "🟢 Low"
          color: GREEN
        }
      ]
    }
  ) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        name
        options {
          id
          name
          color
        }
      }
    }
  }
}'
EOF

echo ""
echo -e "${YELLOW}Example 3: Query to find your option IDs${NC}"
echo "First, run this query to get your current option IDs:"
echo ""
cat << 'EOF'
gh api graphql -f query='
query {
  node(id: "PVT_kwHOAALP3s4A9HI_") {
    ... on ProjectV2 {
      field(name: "Priority") {
        ... on ProjectV2SingleSelectField {
          id
          name
          options {
            id
            name
            color
          }
        }
      }
    }
  }
}'
EOF

echo ""
echo -e "${YELLOW}Example 4: Working script to update options${NC}"
echo "Here's a complete working example:"
echo ""
cat << 'SCRIPT'
#!/bin/bash

# Your IDs
PROJECT_ID="PVT_kwHOAALP3s4A9HI_"
FIELD_ID="PVTSSF_lAHOAALP3s4A9HI_zgw6V80"

# Option IDs (replace with your actual IDs)
P0_ID="cbf87afa"
P1_ID="your_p1_id"
P2_ID="your_p2_id"

# Update all options
gh api graphql --field query=@- <<EOF
mutation {
  updateProjectV2SingleSelectField(
    input: {
      projectId: "$PROJECT_ID"
      fieldId: "$FIELD_ID"
      options: [
        { id: "$P0_ID", name: "🔴 High", color: RED },
        { id: "$P1_ID", name: "🟡 Medium", color: YELLOW },
        { id: "$P2_ID", name: "🟢 Low", color: GREEN }
      ]
    }
  ) {
    projectV2Field {
      ... on ProjectV2SingleSelectField {
        options {
          id
          name
          color
        }
      }
    }
  }
}
EOF
SCRIPT

echo ""
echo -e "${GREEN}Tips:${NC}"
echo "1. Replace the project ID, field ID, and option IDs with your actual values"
echo "2. You can update one option at a time or all at once"
echo "3. Valid colors: GRAY, BLUE, GREEN, YELLOW, ORANGE, RED, PURPLE, PINK"
echo "4. The mutation will preserve any options you don't include in the update"
echo ""
echo "To run any of these examples, copy the command and replace the IDs with your values."