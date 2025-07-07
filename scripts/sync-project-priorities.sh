#!/bin/bash

# Enhanced script to automatically discover and update GitHub Project priority fields
# This script:
# 1. Automatically finds your project and priority field
# 2. Updates priority field option names from P0/P1/P2 to emoji-based names
# 3. Syncs issues with priority labels to the project priority field

set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}=== GitHub Project Priority Sync Tool ===${NC}"
echo ""

# Get current user and repo info
OWNER=$(gh api user --jq .login)
REPO_OWNER=$(gh repo view --json owner --jq .owner.login)
REPO_NAME=$(gh repo view --json name --jq .name)

echo -e "${GREEN}Repository: $REPO_OWNER/$REPO_NAME${NC}"
echo -e "${GREEN}User: $OWNER${NC}"
echo ""

# Function to list user's projects
list_projects() {
    echo -e "${YELLOW}Fetching your projects...${NC}"
    
    PROJECTS=$(gh api graphql -f query='
      query($login: String!) {
        user(login: $login) {
          projectsV2(first: 20) {
            nodes {
              id
              title
              number
            }
          }
        }
      }
    ' -f login="$OWNER" --jq '.data.user.projectsV2.nodes[]')
    
    if [ -z "$PROJECTS" ]; then
        echo -e "${RED}No projects found${NC}"
        return 1
    fi
    
    echo -e "${CYAN}Your projects:${NC}"
    echo "$PROJECTS" | jq -r '"\(.number). \(.title) (ID: \(.id))"'
}

# Function to get project fields
get_project_fields() {
    local PROJECT_ID=$1
    
    FIELDS=$(gh api graphql -f query='
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                ... on ProjectV2Field {
                  id
                  name
                  dataType
                }
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
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
    ' -f projectId="$PROJECT_ID" --jq '.data.node.fields.nodes[] | select(.dataType == "SINGLE_SELECT")')
    
    echo "$FIELDS"
}

# Function to find priority field
find_priority_field() {
    local PROJECT_ID=$1
    
    echo -e "${YELLOW}Looking for Priority field...${NC}"
    
    PRIORITY_FIELD=$(gh api graphql -f query='
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  dataType
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
    ' -f projectId="$PROJECT_ID" --jq '.data.node.fields.nodes[] | select(.name == "Priority" or .name == "priority" or (.options[]?.name | test("P[0-2]|High|Medium|Low"; "i")))')
    
    if [ -z "$PRIORITY_FIELD" ]; then
        echo -e "${RED}No Priority field found${NC}"
        return 1
    fi
    
    echo "$PRIORITY_FIELD" | jq -r '"Found field: \(.name) (ID: \(.id))"'
    echo "$PRIORITY_FIELD"
}

# Function to update field options
update_priority_options() {
    local PROJECT_ID=$1
    local FIELD_ID=$2
    local FIELD_DATA=$3
    
    echo -e "\n${YELLOW}Current priority options:${NC}"
    echo "$FIELD_DATA" | jq -r '.options[] | "  \(.name) (ID: \(.id), Color: \(.color))"'
    
    # Extract option IDs
    local OPTIONS=$(echo "$FIELD_DATA" | jq -r '.options[]')
    
    # Try to identify P0/P1/P2 or High/Medium/Low options
    local HIGH_OPTION=""
    local MEDIUM_OPTION=""
    local LOW_OPTION=""
    
    while IFS= read -r option; do
        local NAME=$(echo "$option" | jq -r '.name')
        local ID=$(echo "$option" | jq -r '.id')
        
        # Match patterns for high/medium/low priorities
        if [[ "$NAME" =~ P0|Critical|Urgent|High ]] || [[ "$NAME" == "High" ]]; then
            HIGH_OPTION=$ID
        elif [[ "$NAME" =~ P1|Medium ]] || [[ "$NAME" == "Medium" ]]; then
            MEDIUM_OPTION=$ID
        elif [[ "$NAME" =~ P2|Low ]] || [[ "$NAME" == "Low" ]]; then
            LOW_OPTION=$ID
        fi
    done <<< "$OPTIONS"
    
    echo -e "\n${CYAN}Detected mappings:${NC}"
    [ -n "$HIGH_OPTION" ] && echo "  High Priority: ID $HIGH_OPTION"
    [ -n "$MEDIUM_OPTION" ] && echo "  Medium Priority: ID $MEDIUM_OPTION"
    [ -n "$LOW_OPTION" ] && echo "  Low Priority: ID $LOW_OPTION"
    
    echo -e "\n${YELLOW}Update option names? (y/n)${NC}"
    read -p "> " confirm
    
    if [ "$confirm" != "y" ]; then
        return 0
    fi
    
    # Build options array for mutation
    local OPTIONS_JSON="["
    local FIRST=true
    
    if [ -n "$HIGH_OPTION" ]; then
        [ "$FIRST" = true ] && FIRST=false || OPTIONS_JSON+=","
        OPTIONS_JSON+="{\"id\": \"$HIGH_OPTION\", \"name\": \"🔴 High\", \"color\": \"RED\"}"
    fi
    
    if [ -n "$MEDIUM_OPTION" ]; then
        [ "$FIRST" = true ] && FIRST=false || OPTIONS_JSON+=","
        OPTIONS_JSON+="{\"id\": \"$MEDIUM_OPTION\", \"name\": \"🟡 Medium\", \"color\": \"YELLOW\"}"
    fi
    
    if [ -n "$LOW_OPTION" ]; then
        [ "$FIRST" = true ] && FIRST=false || OPTIONS_JSON+=","
        OPTIONS_JSON+="{\"id\": \"$LOW_OPTION\", \"name\": \"🟢 Low\", \"color\": \"GREEN\"}"
    fi
    
    OPTIONS_JSON+="]"
    
    echo -e "\n${YELLOW}Updating field options...${NC}"
    
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
        echo -e "${GREEN}✓ Field options updated successfully!${NC}"
        echo "$RESULT" | jq -r '.data.updateProjectV2SingleSelectField.projectV2Field.options[] | "  \(.name) (Color: \(.color))"'
    else
        echo -e "${RED}✗ Error updating field options${NC}"
        echo "$RESULT"
        return 1
    fi
    
    # Return the option IDs for syncing
    echo "$HIGH_OPTION|$MEDIUM_OPTION|$LOW_OPTION"
}

# Function to sync issues
sync_issues_to_project() {
    local PROJECT_ID=$1
    local FIELD_ID=$2
    local HIGH_ID=$3
    local MEDIUM_ID=$4
    local LOW_ID=$5
    
    echo -e "\n${YELLOW}Syncing issues with priority labels...${NC}"
    
    # Process each priority level
    for priority in "high:$HIGH_ID:🔴 High" "medium:$MEDIUM_ID:🟡 Medium" "low:$LOW_ID:🟢 Low"; do
        IFS=':' read -r LABEL OPTION_ID DISPLAY_NAME <<< "$priority"
        
        if [ -z "$OPTION_ID" ] || [ "$OPTION_ID" = "null" ]; then
            echo -e "\n${YELLOW}Skipping $DISPLAY_NAME (no option ID)${NC}"
            continue
        fi
        
        echo -e "\n${BLUE}Processing $DISPLAY_NAME issues...${NC}"
        
        # Get issues with this priority label
        ISSUES=$(gh issue list --label "priority: $LABEL" --limit 100 --json number,title,state --jq '.[] | select(.state == "OPEN")')
        
        if [ -z "$ISSUES" ]; then
            echo "  No open issues with label 'priority: $LABEL'"
            continue
        fi
        
        local COUNT=0
        local SUCCESS=0
        
        echo "$ISSUES" | while IFS= read -r issue; do
            NUMBER=$(echo "$issue" | jq -r .number)
            TITLE=$(echo "$issue" | jq -r .title)
            COUNT=$((COUNT + 1))
            
            echo -n "  Issue #$NUMBER: ${TITLE:0:50}... "
            
            # Get issue node ID
            ISSUE_NODE_ID=$(gh api repos/$REPO_OWNER/$REPO_NAME/issues/$NUMBER --jq .node_id 2>/dev/null)
            
            if [ -z "$ISSUE_NODE_ID" ]; then
                echo -e "${RED}✗ (couldn't get issue ID)${NC}"
                continue
            fi
            
            # Check if issue is in project and get item ID
            ITEM_DATA=$(gh api graphql -f query='
              query($projectId: ID!, $issueId: ID!) {
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
            ' -f projectId="$PROJECT_ID" -f issueId="$ISSUE_NODE_ID" 2>/dev/null)
            
            ITEM_ID=$(echo "$ITEM_DATA" | jq -r ".data.node.items.nodes[] | select(.content.id == \"$ISSUE_NODE_ID\") | .id" 2>/dev/null)
            
            if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
                # Add to project first
                ADD_RESULT=$(gh api graphql -f query='
                  mutation($projectId: ID!, $contentId: ID!) {
                    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
                      item {
                        id
                      }
                    }
                  }
                ' -f projectId="$PROJECT_ID" -f contentId="$ISSUE_NODE_ID" 2>/dev/null)
                
                ITEM_ID=$(echo "$ADD_RESULT" | jq -r '.data.addProjectV2ItemById.item.id' 2>/dev/null)
                
                if [ -z "$ITEM_ID" ] || [ "$ITEM_ID" = "null" ]; then
                    echo -e "${YELLOW}✗ (couldn't add to project)${NC}"
                    continue
                fi
            fi
            
            # Update priority field
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
            ' -f projectId="$PROJECT_ID" -f itemId="$ITEM_ID" -f fieldId="$FIELD_ID" -f value="$OPTION_ID" 2>&1)
            
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}✓${NC}"
                SUCCESS=$((SUCCESS + 1))
            else
                echo -e "${RED}✗${NC}"
            fi
        done
        
        echo "  Processed $COUNT issues, $SUCCESS updated successfully"
    done
    
    echo -e "\n${GREEN}Sync complete!${NC}"
}

# Main execution
main() {
    # Step 1: List and select project
    list_projects
    echo ""
    read -p "Enter project number: " PROJECT_NUM
    
    # Get project ID
    PROJECT_ID=$(gh api graphql -f query='
      query($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) {
            id
            title
          }
        }
      }
    ' -f login="$OWNER" -F number=$PROJECT_NUM --jq '.data.user.projectV2.id')
    
    if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "null" ]; then
        echo -e "${RED}Project not found${NC}"
        exit 1
    fi
    
    PROJECT_TITLE=$(gh api graphql -f query='
      query($login: String!, $number: Int!) {
        user(login: $login) {
          projectV2(number: $number) {
            title
          }
        }
      }
    ' -f login="$OWNER" -F number=$PROJECT_NUM --jq '.data.user.projectV2.title')
    
    echo -e "${GREEN}Selected project: $PROJECT_TITLE${NC}"
    
    # Step 2: Find priority field
    FIELD_DATA=$(find_priority_field "$PROJECT_ID")
    if [ -z "$FIELD_DATA" ]; then
        echo -e "${RED}No priority field found in this project${NC}"
        exit 1
    fi
    
    FIELD_ID=$(echo "$FIELD_DATA" | jq -r '.id' | head -n1)
    
    # Step 3: Update field options
    echo -e "\n${CYAN}Step 1: Update Priority Field Options${NC}"
    OPTION_IDS=$(update_priority_options "$PROJECT_ID" "$FIELD_ID" "$FIELD_DATA" | tail -n1)
    
    # Parse option IDs
    IFS='|' read -r HIGH_ID MEDIUM_ID LOW_ID <<< "$OPTION_IDS"
    
    # Step 4: Sync issues
    echo -e "\n${CYAN}Step 2: Sync Issues with Priority Labels${NC}"
    read -p "Sync issues now? (y/n): " sync_confirm
    
    if [ "$sync_confirm" = "y" ]; then
        sync_issues_to_project "$PROJECT_ID" "$FIELD_ID" "$HIGH_ID" "$MEDIUM_ID" "$LOW_ID"
    fi
    
    echo -e "\n${GREEN}All done!${NC}"
    echo -e "View your project at: https://github.com/users/$OWNER/projects/$PROJECT_NUM"
}

# Run main function
main