# GitHub Project Permissions Setup

## Quick Fix

To use GitHub Projects with the `gh` CLI, you need to grant additional permissions:

```bash
# Grant project permissions
gh auth refresh -s project

# Or for full project access
gh auth refresh -s read:project,project,write:org
```

## Manual Method (GitHub Web UI)

If you prefer to manually add issues to your project:

1. **Go to your project board**
   - https://github.com/users/YOUR_USERNAME/projects/PROJECT_NUMBER

2. **Add issues manually**
   - Click the "+" button in any column
   - Type `#` to search for issues
   - Select issues to add
   - Or drag and drop from the issues page

3. **Bulk add from issues page**
   - Go to repository Issues tab
   - Select multiple issues with checkboxes
   - Click "Projects" → Select your project

## Understanding Permissions

### Required Scopes
- `read:project` - Read project boards
- `project` - Full project access
- `write:org` - Modify organization projects (if applicable)

### Current Token Scopes
Check your current permissions:
```bash
gh auth status
```

### Regenerate Token
If refresh doesn't work:
```bash
gh auth login --scopes project,read:project,repo
```

## Alternative: Use GitHub Web UI

While setting up permissions, you can:

1. **Use the web interface** to add issues to projects
2. **Set up automation rules** so new issues auto-add to the board
3. **Use the project board's built-in features** for organization

## Automation Setup (No Scripts Needed)

In your project settings, configure:

1. **Auto-add new issues**
   - Settings → Workflows → Item added to project
   - Set status to "Backlog"

2. **Auto-add labeled issues**
   - When label "priority: high" → Move to "Ready"
   - When assigned → Move to "In Progress"

3. **Auto-close completed**
   - When PR merged → Move to "Done"
   - When issue closed → Move to "Done"

This way, you don't need scripts for basic project management!