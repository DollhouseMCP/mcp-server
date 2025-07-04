#!/bin/bash

# DollhouseMCP Project Management Script
# This script helps manage GitHub issues and project boards

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to display menu
show_menu() {
    echo -e "${BLUE}=== DollhouseMCP Project Management ===${NC}"
    echo "1. View all issues by priority"
    echo "2. View issues by milestone"
    echo "3. Create new issue from todo"
    echo "4. Assign issue to myself"
    echo "5. Move issue to in-progress"
    echo "6. View my assigned issues"
    echo "7. View project metrics"
    echo "8. Update issue labels"
    echo "9. Exit"
}

# View issues by priority
view_by_priority() {
    echo -e "${YELLOW}Critical Priority Issues:${NC}"
    gh issue list --label "priority: critical" --limit 50
    
    echo -e "\n${YELLOW}High Priority Issues:${NC}"
    gh issue list --label "priority: high" --limit 50
    
    echo -e "\n${YELLOW}Medium Priority Issues:${NC}"
    gh issue list --label "priority: medium" --limit 50
}

# View issues by milestone
view_by_milestone() {
    echo -e "${BLUE}Select milestone:${NC}"
    echo "1. v1.1.0 - CI/CD Reliability"
    echo "2. v1.2.0 - Universal Platform Support"
    echo "3. v1.3.0 - Enhanced UX"
    echo "4. v1.4.0 - Marketplace Evolution"
    read -p "Choice: " milestone_choice
    
    case $milestone_choice in
        1) milestone="v1.1.0 - CI/CD Reliability" ;;
        2) milestone="v1.2.0 - Universal Platform Support" ;;
        3) milestone="v1.3.0 - Enhanced UX" ;;
        4) milestone="v1.4.0 - Marketplace Evolution" ;;
        *) echo "Invalid choice"; return ;;
    esac
    
    gh issue list --milestone "$milestone" --limit 50
}

# Create new issue
create_issue() {
    echo -e "${GREEN}Create new issue${NC}"
    read -p "Issue title: " title
    read -p "Issue type (bug/feature/task/research): " type
    read -p "Priority (critical/high/medium/low): " priority
    read -p "Area (docker/testing/platform-compat/marketplace/ux/security): " area
    
    # Select milestone
    echo "Select milestone:"
    echo "1. v1.1.0 - CI/CD Reliability"
    echo "2. v1.2.0 - Universal Platform Support"
    echo "3. v1.3.0 - Enhanced UX"
    echo "4. v1.4.0 - Marketplace Evolution"
    read -p "Choice: " milestone_choice
    
    case $milestone_choice in
        1) milestone="v1.1.0 - CI/CD Reliability" ;;
        2) milestone="v1.2.0 - Universal Platform Support" ;;
        3) milestone="v1.3.0 - Enhanced UX" ;;
        4) milestone="v1.4.0 - Marketplace Evolution" ;;
        *) milestone="" ;;
    esac
    
    # Create labels string
    labels="type: $type,priority: $priority,area: $area"
    
    # Create issue
    if [ -n "$milestone" ]; then
        gh issue create --title "[$type] $title" --body "Created from project management script" --label "$labels" --milestone "$milestone"
    else
        gh issue create --title "[$type] $title" --body "Created from project management script" --label "$labels"
    fi
}

# Assign issue to self
assign_to_me() {
    read -p "Issue number to assign: #" issue_num
    gh issue edit $issue_num --add-assignee @me
    echo -e "${GREEN}Issue #$issue_num assigned to you${NC}"
}

# Move to in-progress
move_to_progress() {
    read -p "Issue number to move: #" issue_num
    gh issue edit $issue_num --remove-label "status: needs-triage" --add-label "status: in-progress" 2>/dev/null || true
    echo -e "${GREEN}Issue #$issue_num moved to in-progress${NC}"
}

# View my issues
view_my_issues() {
    echo -e "${BLUE}Your assigned issues:${NC}"
    gh issue list --assignee @me --limit 50
}

# View metrics
view_metrics() {
    echo -e "${BLUE}Project Metrics:${NC}"
    
    # Total open issues
    total_open=$(gh issue list --limit 1000 --json number --jq 'length')
    echo "Total open issues: $total_open"
    
    # By priority
    critical=$(gh issue list --label "priority: critical" --limit 100 --json number --jq 'length')
    high=$(gh issue list --label "priority: high" --limit 100 --json number --jq 'length')
    medium=$(gh issue list --label "priority: medium" --limit 100 --json number --jq 'length')
    low=$(gh issue list --label "priority: low" --limit 100 --json number --jq 'length')
    
    echo -e "\nBy Priority:"
    echo "  Critical: $critical"
    echo "  High: $high"
    echo "  Medium: $medium"
    echo "  Low: $low"
    
    # By area
    echo -e "\nBy Area:"
    for area in docker testing platform-compat marketplace ux security; do
        count=$(gh issue list --label "area: $area" --limit 100 --json number --jq 'length')
        echo "  $area: $count"
    done
    
    # Recent activity
    echo -e "\nRecent Activity (last 7 days):"
    gh issue list --limit 10 --sort updated
}

# Update labels
update_labels() {
    read -p "Issue number to update: #" issue_num
    
    echo "Current issue:"
    gh issue view $issue_num
    
    echo -e "\n${YELLOW}Update labels:${NC}"
    echo "1. Change priority"
    echo "2. Change area"
    echo "3. Add custom label"
    echo "4. Remove label"
    read -p "Choice: " label_choice
    
    case $label_choice in
        1)
            read -p "New priority (critical/high/medium/low): " new_priority
            # Remove old priority labels
            for p in critical high medium low; do
                gh issue edit $issue_num --remove-label "priority: $p" 2>/dev/null || true
            done
            # Add new priority
            gh issue edit $issue_num --add-label "priority: $new_priority"
            ;;
        2)
            read -p "New area (docker/testing/platform-compat/marketplace/ux/security): " new_area
            # Remove old area labels
            for a in docker testing platform-compat marketplace ux security; do
                gh issue edit $issue_num --remove-label "area: $a" 2>/dev/null || true
            done
            # Add new area
            gh issue edit $issue_num --add-label "area: $new_area"
            ;;
        3)
            read -p "Label to add: " new_label
            gh issue edit $issue_num --add-label "$new_label"
            ;;
        4)
            read -p "Label to remove: " remove_label
            gh issue edit $issue_num --remove-label "$remove_label"
            ;;
    esac
}

# Main loop
while true; do
    show_menu
    read -p "Enter choice: " choice
    
    case $choice in
        1) view_by_priority ;;
        2) view_by_milestone ;;
        3) create_issue ;;
        4) assign_to_me ;;
        5) move_to_progress ;;
        6) view_my_issues ;;
        7) view_metrics ;;
        8) update_labels ;;
        9) echo -e "${GREEN}Goodbye!${NC}"; exit 0 ;;
        *) echo -e "${RED}Invalid choice${NC}" ;;
    esac
    
    echo -e "\nPress Enter to continue..."
    read
    clear
done