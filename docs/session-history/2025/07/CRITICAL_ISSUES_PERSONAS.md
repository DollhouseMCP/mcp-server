# Critical Issues: Persona Data Preservation

## Executive Summary

Two critical issues threaten user persona data during updates:

1. **Backup System Gap**: User-created personas are NOT included in backups
2. **edit_persona Flaw**: Modifies default personas in place, causing git conflicts

Both issues can result in **permanent data loss** and must be fixed before npm publication.

## Issue 1: Incomplete Backup System (#144)

### Current Behavior
```typescript
// BackupManager.ts uses git archive
await safeExec('git', ['archive', '--format=tar', 'HEAD'])
```
This only backs up git-tracked files.

### Impact
- User-created personas are NOT backed up
- Rollback operations lose all user personas
- No recovery possible after rollback

### Required Fix
```typescript
// After git archive, explicitly backup personas directory
const personasDir = path.join(this.rootDir, 'personas');
const allPersonas = await fs.readdir(personasDir);
for (const file of allPersonas) {
  if (file.endsWith('.md')) {
    await fs.copyFile(
      path.join(personasDir, file),
      path.join(backupPath, 'personas', file)
    );
  }
}
```

## Issue 2: edit_persona Modifies Defaults (#145)

### Current Behavior
```typescript
// src/index.ts:editPersona() - Modifies ANY file in place
await fs.writeFile(filePath, updatedContent, 'utf-8');
```

### Impact
- Editing default personas modifies the git-tracked files
- Creates merge conflicts on updates
- User changes may be lost
- No way to restore original defaults

### Required Fix
```typescript
const DEFAULT_PERSONAS = [
  'business-consultant.md',
  'creative-writer.md',
  'debug-detective.md',
  'eli5-explainer.md',
  'technical-analyst.md'
];

if (DEFAULT_PERSONAS.includes(persona.filename)) {
  // Create a copy instead of modifying original
  const uniqueId = generateUniqueId(persona.metadata.name, author);
  const newFilename = `${uniqueId}.md`;
  const newFilePath = path.join(this.personasDir, newFilename);
  
  // Copy original to new file
  await fs.copyFile(filePath, newFilePath);
  
  // Update the copy, not the original
  filePath = newFilePath;
}
```

## Risk Scenarios

### Scenario 1: Update After Editing Default
1. User: `edit_persona "Creative Writer" "instructions" "New content"`
2. System modifies `creative-writer.md` directly
3. User: `update_server true`
4. Git pull fails with merge conflict OR overwrites changes
5. **Result**: User loses their customizations

### Scenario 2: Rollback After Creating Personas
1. User creates 10 custom personas
2. Update fails for any reason
3. User: `rollback_update true`
4. System restores from backup (git-tracked only)
5. **Result**: All 10 custom personas permanently lost

## Immediate Workarounds

Until fixed, users should:

### 1. Manual Backup Before Updates
```bash
# Before any update or rollback
cp -r personas ~/dollhouse-persona-backup-$(date +%s)
```

### 2. Never Edit Default Personas
```bash
# Instead of editing defaults, copy first
cp personas/creative-writer.md personas/my-creative-writer.md
# Then edit the copy
```

### 3. Keep Personas Outside Project
```bash
# Maintain personas in separate directory
~/my-personas/
# Symlink or copy as needed
```

## Testing the Fixes

### Test 1: Backup Completeness
```bash
# Create test persona
echo "Test" > personas/test-persona.md

# Trigger backup
update_server true  # Or manual backup

# Check backup
ls ../dollhousemcp-backups/latest/personas/
# Should include test-persona.md
```

### Test 2: Default Protection
```bash
# Try to edit default
edit_persona "Creative Writer" "description" "Modified"

# Check results
ls personas/*creative*
# Should show: creative-writer.md (original)
#              creative-writer_TIMESTAMP_username.md (modified copy)
```

## Priority: CRITICAL

These issues pose immediate data loss risks:
- **Severity**: High - Permanent data loss
- **Likelihood**: High - Common user actions
- **Impact**: Critical - Destroys user work

Must be fixed before:
1. NPM publication
2. Any marketing/promotion
3. v1.3.0 release

## Implementation Checklist

### For Issue #144 (Backup)
- [ ] Modify BackupManager.createBackup()
- [ ] Include all .md files from personas/
- [ ] Update restoreBackup() to handle all personas
- [ ] Add tests for user persona backup
- [ ] Update documentation

### For Issue #145 (edit_persona)
- [ ] Add DEFAULT_PERSONAS constant
- [ ] Implement copy-on-write check
- [ ] Update response to indicate copy created
- [ ] Add tests for default protection
- [ ] Update user documentation

## Related Documentation
- `/docs/auto-update/persona-preservation.md` - Detailed behavior
- `/docs/development/EDIT_PERSONA_INVESTIGATION.md` - Discovery process
- Issue #144 - Backup enhancement
- Issue #145 - edit_persona protection
- Issue #146 - Full API audit