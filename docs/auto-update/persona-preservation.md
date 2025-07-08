# Persona Preservation During Updates

## Overview

This document explains how the DollhouseMCP auto-update system handles persona files during updates and rollbacks to ensure user data is preserved.

## How Updates Handle Personas

### During Normal Updates (`update_server`)

The update process uses `git pull origin main` to update files, which means:

1. **Default Personas** (tracked in git):
   - `business-consultant.md`
   - `creative-writer.md`
   - `debug-detective.md`
   - `eli5-explainer.md`
   - `technical-analyst.md`
   
   These files **WILL BE UPDATED** if changes exist in the repository. Any local modifications to these files may be overwritten or cause merge conflicts.

2. **User-Created Personas** (not in git):
   - Any persona files you create are **PRESERVED**
   - Git pull only affects tracked files
   - Your custom personas remain untouched

3. **Modified Default Personas**:
   - If you modify a default persona AND the repository also updates it, git will attempt to merge
   - If merge fails, the update will stop with an error about uncommitted changes
   - You'll need to resolve the conflict manually

### During Backup Creation

The backup process uses `git archive` which:
- **ONLY backs up git-tracked files**
- User-created personas are **NOT included in backups**
- This is a limitation of the current backup system

### During Rollback (`rollback_update`)

The rollback process:
1. Moves current files to a temporary directory (except .git, node_modules, dist)
2. Copies files from the backup to the root directory
3. Since backups only contain git-tracked files, **user personas are temporarily moved but then lost**

## ⚠️ Important Limitations

1. **User personas are NOT backed up** by the auto-update system
2. **Rollback may lose user-created personas** if not manually backed up
3. **Modified default personas** may cause update conflicts

## Best Practices for Persona Preservation

### 1. Create a Separate Personas Directory

Create a directory outside the project for your custom personas:
```bash
mkdir ~/my-dollhouse-personas
```

Then symlink or copy them as needed.

### 2. Manual Backup Before Updates

Before running updates, manually backup your personas:
```bash
# Create a backup directory with timestamp
mkdir -p ~/dollhouse-persona-backups/$(date +%Y%m%d_%H%M%S)

# Copy all personas
cp personas/*.md ~/dollhouse-persona-backups/$(date +%Y%m%d_%H%M%S)/
```

### 3. Use Git for Custom Personas

Track your custom personas in your own git repository:
```bash
cd personas
git init
git add my-custom-*.md
git commit -m "Backup custom personas"
git remote add backup https://github.com/yourusername/my-personas.git
git push backup main
```

### 4. Avoid Modifying Default Personas

Instead of modifying default personas:
1. Copy them to a new name: `cp creative-writer.md my-creative-writer.md`
2. Modify the copy
3. Use your custom version

## Recommended Workflow

### Before Updating

```bash
# 1. Check for uncommitted changes
git status

# 2. Backup custom personas
cp personas/*.md ~/persona-backup/

# 3. Run update
update_server true
```

### After Updating

```bash
# 1. Verify personas are intact
ls personas/

# 2. Restore any missing custom personas
cp ~/persona-backup/my-*.md personas/

# 3. Test personas
list_personas
```

## Future Improvements

The following improvements are being considered:

1. **Enhanced Backup System**: Include all files in personas/ directory, not just git-tracked ones
2. **Persona Protection**: Automatically backup user personas before updates
3. **Conflict Resolution**: Better handling of modified default personas
4. **Separate User Directory**: Use `personas/user/` for custom personas

## Technical Details

### Current Backup Implementation

```typescript
// BackupManager.ts - Current implementation
await safeExec('git', [
  'archive',
  '--format=tar',
  'HEAD'
], { cwd: this.rootDir })
```

This only includes git-tracked files.

### Proposed Enhancement

```typescript
// Enhanced backup to include all personas
const personasDir = path.join(this.rootDir, 'personas');
const allPersonas = await fs.readdir(personasDir);

// Backup all persona files, not just git-tracked ones
for (const persona of allPersonas) {
  if (persona.endsWith('.md')) {
    await fs.copyFile(
      path.join(personasDir, persona),
      path.join(backupPath, 'personas', persona)
    );
  }
}
```

## Summary

- **User-created personas**: Preserved during updates, NOT backed up automatically
- **Default personas**: Updated from repository, changes may be lost
- **Rollback risk**: May lose user personas if not manually backed up
- **Best practice**: Manually backup personas before updates

Always backup your custom personas before running updates or rollbacks!