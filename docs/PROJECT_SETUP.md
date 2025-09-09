# GitHub Project Setup Guide

## Creating the Project Board

1. **Navigate to Projects**
   - Go to: https://github.com/DollhouseMCP/mcp-server/projects/new
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

We've created a script to add all issues to your project. Run:

```bash
# Run the interactive script
./scripts/add-issues-to-project.sh

# The script will:
# 1. Ask for your project number (from the URL)
# 2. Find all open issues
# 3. Add them to your project board
# 4. Show a summary of results
```

**Alternative manual method:**
1. Go to your project board
2. Click "+ Add item" 
3. Search for issues to add
4. Or drag issues from the repository issues page

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

Note: The project automation workflow has been removed from this repository as it was misplaced. 
For element submission automation, see the collection repository's workflow at:
`.github/workflows/project-integration.yml`

Manual project management can be done through GitHub's built-in project automation rules.

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

- [Open Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- [Milestones](https://github.com/DollhouseMCP/mcp-server/milestones)
- [Labels](https://github.com/DollhouseMCP/mcp-server/labels)
- [Contributors Guide](../CONTRIBUTING.md)