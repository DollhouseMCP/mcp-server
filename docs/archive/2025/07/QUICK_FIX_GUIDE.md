# Quick Fix Guide - Critical Persona Issues

## 🚨 Fix #1: edit_persona Protection (Issue #145)

### Location
`src/index.ts:785` - editPersona method

### Add This Code
```typescript
// After line ~820 (after finding the persona)
const DEFAULT_PERSONAS = [
  'business-consultant.md',
  'creative-writer.md', 
  'debug-detective.md',
  'eli5-explainer.md',
  'technical-analyst.md'
];

const isDefaultPersona = DEFAULT_PERSONAS.includes(persona.filename);
let createdCopy = false;

if (isDefaultPersona) {
  // Generate unique filename
  const author = process.env.DOLLHOUSE_USER || 'anon';
  const uniqueId = generateUniqueId(persona.metadata.name, author);
  const newFilename = `${uniqueId}.md`;
  const newFilePath = path.join(this.personasDir, newFilename);
  
  // Copy the default persona
  await fs.copyFile(filePath, newFilePath);
  
  // Update to use the copy
  filePath = newFilePath;
  createdCopy = true;
}
```

### Update Success Message
```typescript
// Around line ~900, in the success response
text: `${this.getPersonaIndicator()}✅ **Persona Updated Successfully!**\n\n` +
  (createdCopy ? `📋 **Note**: Created a copy of the default persona\n\n` : '') +
  // ... rest of message
```

### Test Command
```bash
# This should create a copy, not modify the original
edit_persona "Creative Writer" "description" "My custom version"
ls personas/*creative*
# Should show both files
```

## 🚨 Fix #2: Backup All Personas (Issue #144)

### Location
`src/update/BackupManager.ts:148` - After git archive

### Add This Code
```typescript
// After the git archive section (~line 148)
// Also backup ALL personas (including user-created ones)
const personasDir = path.join(this.rootDir, 'personas');
const backupPersonasDir = path.join(backupPath, 'personas');

try {
  await fs.mkdir(backupPersonasDir, { recursive: true });
  
  const personaFiles = await fs.readdir(personasDir);
  for (const file of personaFiles) {
    if (file.endsWith('.md')) {
      await fs.copyFile(
        path.join(personasDir, file),
        path.join(backupPersonasDir, file)
      );
    }
  }
  console.log(`Backed up ${personaFiles.filter(f => f.endsWith('.md')).length} personas`);
} catch (error) {
  console.error('Warning: Could not backup all personas:', error);
  // Don't fail the backup, but log the issue
}
```

### Test Commands
```bash
# Create a test persona
echo "---\nname: Test\n---\nTest persona" > personas/test-backup.md

# Trigger backup (or use update_server)
# Then check the backup includes it
ls ../dollhousemcp-backups/backup-*/personas/
# Should include test-backup.md
```

## Quick Verification Script

```bash
#!/bin/bash
echo "Testing edit_persona protection..."
# Test 1: Edit default persona
# Should create copy

echo -e "\nTesting backup completeness..."
# Test 2: Create user persona
echo "---\nname: TestUser\n---\nTest" > personas/test-user.md
# Trigger backup
# Check if included

echo -e "\nChecking for regressions..."
npm test -- --testNamePattern="persona|backup"
```

## Remember
- These fixes prevent DATA LOSS
- Test thoroughly before committing
- Both issues are CRITICAL priority
- Don't publish to npm until fixed!

Good luck! 🍀