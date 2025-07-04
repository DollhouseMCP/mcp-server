# GitHub Project Setup Guide

## Creating the Project Board

1. **Navigate to Projects**
   - Go to: https://github.com/mickdarling/DollhouseMCP/projects/new
   - Or: Repository → Projects tab → New project

2. **Choose Template**
   - Select "Team planning" template (recommended)
   - Or "Feature planning" for roadmap view
   - Name: "DollhouseMCP Roadmap"

3. **Configure Views**

### Board View Setup
Create columns:
```
📋 Backlog | 🔍 Triage | 📅 Ready | 🚧 In Progress | 👀 In Review | ✅ Done
```

### Table View Fields
Add custom fields:
- **Priority**: Single select (Critical, High, Medium, Low)
- **Area**: Single select (Docker, Testing, Platform, Marketplace, UX, Security)
- **Effort**: Single select (XS, S, M, L, XL)
- **Sprint**: Iteration field
- **Milestone**: Milestone field (link to repo milestones)

## Linking Existing Issues

Run these commands to add all issues to the project:

```bash
# First, get your project number (shown in URL after creation)
PROJECT_NUMBER=1  # Replace with your actual project number

# Add all open issues to project
gh issue list --limit 100 --state open --json number --jq '.[].number' | while read issue; do
  echo "Adding issue #$issue to project..."
  gh issue edit $issue --add-project "DollhouseMCP Roadmap"
done
```

## Automation Rules

In your project settings, add these automation rules:

### Item Added to Project
- Set status to "Backlog"

### Item Closed
- Set status to "Done"

### Pull Request Merged
- Set status to "Done"

### Label Added
When label "priority: critical" is added → Move to "Ready"
When label "status: in-progress" is added → Move to "In Progress"

## Workflow Integration

The project automation workflow (`.github/workflows/project-automation.yml`) will:
- Auto-add new issues to the project
- Update status based on issue/PR events
- Apply labels based on workflow

## Project Views

### 1. Current Sprint View
Filter: `milestone:"v1.1.0 - CI/CD Reliability"`
Group by: Priority
Sort by: Status

### 2. High Priority View
Filter: `label:"priority: high","priority: critical"`
Group by: Area
Sort by: Updated

### 3. My Tasks View
Filter: `assignee:@me`
Group by: Status
Sort by: Priority

### 4. Roadmap View
Layout: Roadmap
Date field: Milestone due date
Group by: Milestone

## Team Collaboration

### For Contributors
1. Check "Ready" column for available work
2. Assign yourself to an issue
3. Move to "In Progress"
4. Create PR when ready
5. Move to "In Review"

### For Maintainers
1. Triage new issues in "Triage" column
2. Add priority and area labels
3. Set milestone
4. Move to appropriate column

## Metrics to Track

- **Velocity**: Issues closed per week
- **Cycle Time**: Time from "In Progress" to "Done"
- **Priority Distribution**: Balance of critical/high/medium/low
- **Area Coverage**: Which areas need more attention

## Quick Links

- [Open Issues](https://github.com/mickdarling/DollhouseMCP/issues)
- [Milestones](https://github.com/mickdarling/DollhouseMCP/milestones)
- [Labels](https://github.com/mickdarling/DollhouseMCP/labels)
- [Contributors Guide](../CONTRIBUTING.md)