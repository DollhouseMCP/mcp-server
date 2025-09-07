# Deleted Project Automation Workflow

**Date Deleted**: September 7, 2025
**Reason**: Workflow was in wrong repository (belongs in collection repo, not mcp-server)

## Original Purpose

This workflow was likely accidentally created in mcp-server when it should have been in the collection repository. The collection repo has the correct version at `.github/workflows/project-integration.yml`.

## What It Did

### Triggered On:
- Issues: opened, closed, assigned, unassigned, labeled
- Pull requests: opened, closed, ready_for_review, converted_to_draft

### Job 1: Add to Project
- **When**: New issues opened
- **Action**: Added issue to `https://github.com/users/mickdarling/projects/1`
- **Problem**: This user project doesn't exist (should use org project)

### Job 2: Auto-label Management
- **When**: Any issue event
- **Actions**:
  1. New issues → Added `status: needs-triage` label
  2. Issue assigned → Removed `needs-triage`, added `status: in-progress`

## Original Content

```yaml
---
name: Project Automation

on:
  issues:
    types: [opened, closed, assigned, unassigned, labeled]
  pull_request:
    types: [opened, closed, ready_for_review, converted_to_draft]

permissions:
  issues: write
  pull-requests: write
  repository-projects: write

jobs:
  add-to-project:
    name: Add to project
    runs-on: ubuntu-latest
    if: github.event_name == 'issues' && github.event.action == 'opened'
    steps:
      - name: Add issue to project
        uses: actions/add-to-project@v0.5.0
        with:
          # You'll need to create the project first and update this URL
          project-url: https://github.com/users/mickdarling/projects/1
          github-token: ${{ secrets.GITHUB_TOKEN }}

  manage-labels:
    name: Auto-label management
    runs-on: ubuntu-latest
    if: github.event_name == 'issues'
    steps:
      - name: Add triage label to new issues
        if: github.event.action == 'opened'
        uses: actions/github-script@v7
        with:
          script: |
            github.rest.issues.addLabels({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              labels: ['status: needs-triage']
            })

      - name: Add in-progress label when assigned
        if: github.event.action == 'assigned'
        uses: actions/github-script@v7
        with:
          script: |
            // Remove needs-triage if present
            try {
              await github.rest.issues.removeLabel({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                name: 'status: needs-triage'
              })
            } catch (e) {
              // Label might not exist, that's okay
            }
            
            // Add in-progress
            github.rest.issues.addLabels({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              labels: ['status: in-progress']
            })
```

## Why Deleted

1. **Wrong repository** - This belongs in the collection repo for element submissions
2. **Wrong project URL** - Points to user project instead of org project
3. **Causing CI failures** - Failed on every issue creation since Sept 2
4. **Not needed** - MCP-server doesn't need automated project management

## If Needed Again

The correct version exists in the collection repository at:
`/active/collection/.github/workflows/project-integration.yml`

If project automation is needed for mcp-server:
1. Create an org-level project at https://github.com/orgs/DollhouseMCP/projects/
2. Use the collection's workflow as a template
3. Update the project URL to point to the new project