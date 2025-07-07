#!/bin/bash

# Direct script to update GitHub Project priority field option names
# Uses the updateProjectV2SingleSelectField mutation

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Update Priority Field Names ===${NC}"
echo ""

# Configuration - Update these with your actual IDs
PROJECT_ID="${PROJECT_ID:-PVT_kwHOAALP3s4A9HI_}"
FIELD_ID="${FIELD_ID:-PVTSSF_lAHOAALP3s4A9HI_zgw6V80}"

# If not set, prompt for IDs
if [ "$PROJECT_ID" = "PVT_kwHOAALP3s4A9HI_" ]; then
    echo -e "${YELLOW}Using default project ID. To use a different project, set PROJECT_ID environment variable.${NC}"
    read -p "Enter your project ID (or press Enter to use default): " CUSTOM_PROJECT_ID
    [ -n "$CUSTOM_PROJECT_ID" ] && PROJECT_ID="$CUSTOM_PROJECT_ID"
fi

if [ "$FIELD_ID" = "PVTSSF_lAHOAALP3s4A9HI_zgw6V80" ]; then
    echo -e "${YELLOW}Using default field ID. To use a different field, set FIELD_ID environment variable.${NC}"
    read -p "Enter your priority field ID (or press Enter to use default): " CUSTOM_FIELD_ID
    [ -n "$CUSTOM_FIELD_ID" ] && FIELD_ID="$CUSTOM_FIELD_ID"
fi

echo ""
echo -e "${GREEN}Project ID: $PROJECT_ID${NC}"
echo -e "${GREEN}Field ID: $FIELD_ID${NC}"
echo ""

# First, get current field options
echo -e "${YELLOW}Fetching current priority field options...${NC}"

CURRENT_OPTIONS=$(gh api graphql -f query='
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
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
    }
  }
' -f projectId="$PROJECT_ID" 2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}Error fetching project fields${NC}"
    echo "$CURRENT_OPTIONS"
    exit 1
fi

# Display current options
echo "$CURRENT_OPTIONS" | jq -r '.data.node.fields.nodes[] | select(.id == "'$FIELD_ID'") | .options[] | "  \(.name) - ID: \(.id) (Color: \(.color))"'

echo ""
echo -e "${YELLOW}Please identify the option IDs for each priority level:${NC}"
echo "(Look for options like P0, P1, P2, or High, Medium, Low)"
echo ""

read -p "Enter ID for P0/High priority option: " P0_ID
read -p "Enter ID for P1/Medium priority option: " P1_ID
read -p "Enter ID for P2/Low priority option: " P2_ID

# Update the field options
echo ""
echo -e "${YELLOW}Updating priority field options...${NC}"

# Build the options array
OPTIONS_JSON="["

if [ -n "$P0_ID" ]; then
    OPTIONS_JSON+="{\"id\": \"$P0_ID\", \"name\": \"🔴 High\", \"color\": \"RED\"}"
fi

if [ -n "$P1_ID" ]; then
    [ "$OPTIONS_JSON" != "[" ] && OPTIONS_JSON+=","
    OPTIONS_JSON+="{\"id\": \"$P1_ID\", \"name\": \"🟡 Medium\", \"color\": \"YELLOW\"}"
fi

if [ -n "$P2_ID" ]; then
    [ "$OPTIONS_JSON" != "[" ] && OPTIONS_JSON+=","
    OPTIONS_JSON+="{\"id\": \"$P2_ID\", \"name\": \"🟢 Low\", \"color\": \"GREEN\"}"
fi

OPTIONS_JSON+="]"

# Execute the mutation
RESULT=$(gh api graphql -f query='
  mutation($projectId: ID!, $fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2SingleSelectField(
      input: {
        projectId: $projectId
        fieldId: $fieldId
        options: $options
      }
    ) {
      projectV2Field {
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
' -f projectId="$PROJECT_ID" -f fieldId="$FIELD_ID" -f options="$OPTIONS_JSON" 2>&1)

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Successfully updated priority field options!${NC}"
    echo ""
    echo "Updated options:"
    echo "$RESULT" | jq -r '.data.updateProjectV2SingleSelectField.projectV2Field.options[] | "  \(.name) (Color: \(.color))"'
else
    echo -e "${RED}✗ Error updating field options${NC}"
    echo "$RESULT"
    exit 1
fi

echo ""
echo -e "${GREEN}Done!${NC}"
echo ""
echo "Next steps:"
echo "1. Run sync-project-priorities.sh to sync issue labels with the new field values"
echo "2. Or manually update issues in your project board"