#!/bin/bash

# Script to update GitHub Project priority field options and sync with issue labels
# This script:
# 1. Updates priority field option names from P0/P1/P2 to emoji-based names
# 2. Syncs issues with priority labels to the project priority field

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== GitHub Project Priority Field Updater ===${NC}"
echo ""

# Configuration - Update these with your actual project IDs
PROJECT_ID="PVT_kwHOAALP3s4A9HI_"
PRIORITY_FIELD_ID="PVTSSF_lAHOAALP3s4A9HI_zgw6V80"

# Get project owner and repository info
OWNER=$(gh api user --jq .login)
REPO_OWNER=$(gh repo view --json owner --jq .owner.login)
REPO_NAME=$(gh repo view --json name --jq .name)

echo -e "${GREEN}Repository: $REPO_OWNER/$REPO_NAME${NC}"
echo -e "${GREEN}Project Owner: $OWNER${NC}"
echo ""

# Function to get current priority field options
get_field_options() {
    echo -e "${YELLOW}Fetching current priority field options...${NC}"
    
    FIELD_OPTIONS=$(gh api graphql -f query='
      query($projectId: ID!, $fieldId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            field(name: "Priority") {
              ... on ProjectV2SingleSelectField {
                id
                name
                options {
                  id
                  name
                  color
                  description
                }
              }
            }
          }
        }
      }
    ' -f projectId="$PROJECT_ID" -f fieldId="$PRIORITY_FIELD_ID" 2>&1)
    
    if [ $? -eq 0 ]; then
        echo "$FIELD_OPTIONS" | jq -r '.data.node.field.options[] | "\(.id) - \(.name)"'
    else
        echo -e "${RED}Error fetching field options${NC}"
        echo "$FIELD_OPTIONS"
        exit 1
    fi
}

# Function to update a field option name
update_field_option() {
    local OPTION_ID=$1
    local NEW_NAME=$2
    local COLOR=$3
    
    echo -n "Updating option to '$NEW_NAME'... "
    
    RESULT=$(gh api graphql -f query='
      mutation($projectId: ID!, $fieldId: ID!, $optionId: String!, $name: String!, $color: ProjectV2SingleSelectFieldOptionColor!) {
        updateProjectV2SingleSelectField(
          input: {
            projectId: $projectId
            fieldId: $fieldId
            options: [{
              id: $optionId
              name: $name
              color: $color
            }]
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
    ' -f projectId="$PROJECT_ID" -f fieldId="$PRIORITY_FIELD_ID" -f optionId="$OPTION_ID" -f name="$NEW_NAME" -f color="$COLOR" 2>&1)
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
        echo -e "${RED}Error: $RESULT${NC}"
    fi
}

# Function to sync issue labels with project priority field
sync_issue_priorities() {
    echo -e "\n${YELLOW}Syncing issue priorities with project field...${NC}"
    
    # Map of label to field option ID (you'll need to update these IDs)
    declare -A PRIORITY_MAP
    # These IDs need to be fetched from your actual project
    # Run get_field_options first to see the actual IDs
    
    # Get issues with priority labels
    for priority in "high" "medium" "low"; do
        echo -e "\n${BLUE}Processing priority: $priority${NC}"
        
        ISSUES=$(gh issue list --label "priority: $priority" --limit 100 --json number,title --jq '.[]')
        
        if [ -z "$ISSUES" ]; then
            echo "No issues found with label 'priority: $priority'"
            continue
        fi
        
        echo "$ISSUES" | while IFS= read -r issue; do
            NUMBER=$(echo "$issue" | jq -r .number)
            TITLE=$(echo "$issue" | jq -r .title)
            
            echo -n "Issue #$NUMBER: $TITLE... "
            
            # Get issue's project item ID
            ISSUE_NODE_ID=$(gh api repos/$REPO_OWNER/$REPO_NAME/issues/$NUMBER --jq .node_id)
            
            # Get the item ID in the project
            ITEM_ID=$(gh api graphql -f query='
              query($projectId: ID!, $contentId: ID!) {
                node(id: $projectId) {
                  ... on ProjectV2 {
                    items(first: 100) {
                      nodes {
                        id
                        content {
                          ... on Issue {
                            id
                          }
                        }
                      }
                    }
                  }
                }
              }
            ' -f projectId="$PROJECT_ID" -f contentId="$ISSUE_NODE_ID" | jq -r ".data.node.items.nodes[] | select(.content.id == \"$ISSUE_NODE_ID\") | .id")
            
            if [ -z "$ITEM_ID" ]; then
                echo -e "${YELLOW}Not in project${NC}"
                continue
            fi
            
            # Update priority field based on label
            case $priority in
                "high")
                    OPTION_ID="${HIGH_OPTION_ID:-}"
                    ;;
                "medium")
                    OPTION_ID="${MEDIUM_OPTION_ID:-}"
                    ;;
                "low")
                    OPTION_ID="${LOW_OPTION_ID:-}"
                    ;;
            esac
            
            if [ -z "$OPTION_ID" ]; then
                echo -e "${YELLOW}Option ID not configured${NC}"
                continue
            fi
            
            # Update the field value
            UPDATE_RESULT=$(gh api graphql -f query='
              mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: String!) {
                updateProjectV2ItemFieldValue(
                  input: {
                    projectId: $projectId
                    itemId: $itemId
                    fieldId: $fieldId
                    value: {
                      singleSelectOptionId: $value
                    }
                  }
                ) {
                  projectV2Item {
                    id
                  }
                }
              }
            ' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$PRIORITY_FIELD_ID" -f value="$OPTION_ID" 2>&1)
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓${NC}"
            else
                echo -e "${RED}✗${NC}"
                echo -e "${RED}  Error: $UPDATE_RESULT${NC}"
            fi
        done
    done
}

# Main menu
show_menu() {
    echo -e "${BLUE}Select an action:${NC}"
    echo "1. View current priority field options"
    echo "2. Update priority field option names"
    echo "3. Sync issue labels with project priority field"
    echo "4. Run full update (update names + sync)"
    echo "5. Exit"
}

# Main execution
while true; do
    show_menu
    read -p "Enter choice: " choice
    
    case $choice in
        1)
            get_field_options
            ;;
        2)
            echo -e "\n${YELLOW}First, let's see the current options:${NC}"
            get_field_options
            echo ""
            echo -e "${YELLOW}To update options, you'll need the option IDs from above.${NC}"
            echo "Enter the option details (or 'skip' to skip):"
            
            read -p "P0/High option ID: " HIGH_OPTION_ID
            if [ "$HIGH_OPTION_ID" != "skip" ] && [ -n "$HIGH_OPTION_ID" ]; then
                # Validate option ID format
                if ! [[ "$HIGH_OPTION_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                    echo -e "${RED}Error: Invalid option ID format${NC}"
                else
                    update_field_option "$HIGH_OPTION_ID" "🔴 High" "RED"
                fi
            fi
            
            read -p "P1/Medium option ID: " MEDIUM_OPTION_ID
            if [ "$MEDIUM_OPTION_ID" != "skip" ] && [ -n "$MEDIUM_OPTION_ID" ]; then
                # Validate option ID format
                if ! [[ "$MEDIUM_OPTION_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                    echo -e "${RED}Error: Invalid option ID format${NC}"
                else
                    update_field_option "$MEDIUM_OPTION_ID" "🟡 Medium" "YELLOW"
                fi
            fi
            
            read -p "P2/Low option ID: " LOW_OPTION_ID
            if [ "$LOW_OPTION_ID" != "skip" ] && [ -n "$LOW_OPTION_ID" ]; then
                # Validate option ID format
                if ! [[ "$LOW_OPTION_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                    echo -e "${RED}Error: Invalid option ID format${NC}"
                else
                    update_field_option "$LOW_OPTION_ID" "🟢 Low" "GREEN"
                fi
            fi
            ;;
        3)
            echo -e "\n${YELLOW}To sync priorities, we need the option IDs.${NC}"
            get_field_options
            echo ""
            read -p "High priority option ID (🔴 High): " HIGH_OPTION_ID
            read -p "Medium priority option ID (🟡 Medium): " MEDIUM_OPTION_ID
            read -p "Low priority option ID (🟢 Low): " LOW_OPTION_ID
            
            # Validate all option IDs before proceeding
            local valid=true
            for id_name in "HIGH_OPTION_ID" "MEDIUM_OPTION_ID" "LOW_OPTION_ID"; do
                local id_value="${!id_name}"
                if [ -z "$id_value" ] || ! [[ "$id_value" =~ ^[a-zA-Z0-9_-]+$ ]]; then
                    echo -e "${RED}Error: Invalid ${id_name//_OPTION_ID/ priority} option ID format${NC}"
                    valid=false
                fi
            done
            
            if [ "$valid" = true ]; then
                sync_issue_priorities
            else
                echo -e "${RED}Please provide valid option IDs${NC}"
            fi
            ;;
        4)
            echo -e "\n${YELLOW}Running full update...${NC}"
            echo "This will update field names and sync all issues."
            read -p "Continue? (y/n): " confirm
            
            if [ "$confirm" = "y" ]; then
                # First get current options
                echo -e "\n${YELLOW}Current field options:${NC}"
                get_field_options
                
                # Update names
                echo -e "\n${YELLOW}Please provide option IDs to update:${NC}"
                read -p "P0/High option ID: " HIGH_OPTION_ID
                read -p "P1/Medium option ID: " MEDIUM_OPTION_ID
                read -p "P2/Low option ID: " LOW_OPTION_ID
                
                if [ -n "$HIGH_OPTION_ID" ]; then
                    update_field_option "$HIGH_OPTION_ID" "🔴 High" "RED"
                fi
                if [ -n "$MEDIUM_OPTION_ID" ]; then
                    update_field_option "$MEDIUM_OPTION_ID" "🟡 Medium" "YELLOW"
                fi
                if [ -n "$LOW_OPTION_ID" ]; then
                    update_field_option "$LOW_OPTION_ID" "🟢 Low" "GREEN"
                fi
                
                # Then sync issues
                echo -e "\n${YELLOW}Now syncing issues...${NC}"
                sync_issue_priorities
            fi
            ;;
        5)
            echo -e "${GREEN}Goodbye!${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid choice${NC}"
            ;;
    esac
    
    echo -e "\nPress Enter to continue..."
    read
    clear
done