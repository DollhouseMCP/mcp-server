# GitHub Project Priority Sync Scripts

This directory contains scripts to manage GitHub Project priority fields and sync them with issue labels.

## Scripts Overview

### 1. `update-priority-names.sh`
A focused script to update priority field option names from P0/P1/P2 to emoji-based names.

**Features:**
- Updates priority field options to: 🔴 High, 🟡 Medium, 🟢 Low
- Uses the GitHub GraphQL API's `updateProjectV2SingleSelectField` mutation
- Allows custom project and field IDs via environment variables

**Usage:**
```bash
# Using default IDs (will prompt if needed)
./scripts/update-priority-names.sh

# With custom IDs
PROJECT_ID="your_project_id" FIELD_ID="your_field_id" ./scripts/update-priority-names.sh
```

### 2. `sync-project-priorities.sh`
An enhanced script that automatically discovers projects and syncs issue labels with project fields.

**Features:**
- Lists all your GitHub projects
- Automatically finds the Priority field
- Updates field option names
- Syncs issues based on their priority labels (priority: high/medium/low)
- Adds issues to the project if they're not already there

**Usage:**
```bash
./scripts/sync-project-priorities.sh
```

### 3. `update-project-priorities.sh`
A comprehensive menu-driven script for managing project priorities.

**Features:**
- Interactive menu system
- View current priority field options
- Update field option names
- Sync issue labels with project fields
- Full update mode (names + sync)

**Usage:**
```bash
./scripts/update-project-priorities.sh
```

## Priority Label Mapping

The scripts sync GitHub issue labels with project field values:

| Issue Label | Project Field Value |
|------------|-------------------|
| `priority: high` | 🔴 High |
| `priority: medium` | 🟡 Medium |
| `priority: low` | 🟢 Low |

## Prerequisites

1. **GitHub CLI (gh)**: Must be installed and authenticated
   ```bash
   gh auth login
   ```

2. **Project Permissions**: Your GitHub token needs project permissions
   ```bash
   gh auth refresh -s project
   ```

3. **GraphQL API Access**: Required for project field mutations

## Getting Project and Field IDs

To find your project and field IDs:

```bash
# List your projects
gh api graphql -f query='
  query {
    viewer {
      projectsV2(first: 20) {
        nodes {
          id
          title
          number
        }
      }
    }
  }
'

# Get fields for a specific project
gh api graphql -f query='
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
              }
            }
          }
        }
      }
    }
  }
' -f projectId="YOUR_PROJECT_ID"
```

## Troubleshooting

### Permission Errors
If you get permission errors, refresh your GitHub CLI authentication:
```bash
gh auth refresh -s project,read:project,write:org
```

### Field Not Found
Make sure your project has a "Priority" field of type "Single Select".

### Issues Not Syncing
- Verify issues have the correct priority labels (priority: high/medium/low)
- Check that issues are open (closed issues are skipped)
- Ensure the issue is accessible in the repository

## Integration with Existing Scripts

These scripts complement the existing project management tools:
- `project-management.sh` - General project and issue management
- `add-issues-to-project.sh` - Add all issues to a project
- `link-issues-to-project.sh` - Quick issue linking

## Example Workflow

1. First, update your priority field names:
   ```bash
   ./scripts/update-priority-names.sh
   ```

2. Then sync all issues with priority labels:
   ```bash
   ./scripts/sync-project-priorities.sh
   ```

3. Or use the all-in-one script:
   ```bash
   ./scripts/update-project-priorities.sh
   # Select option 4 for full update
   ```