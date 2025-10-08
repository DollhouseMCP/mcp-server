# File Locking TODO - Next Steps

## Immediate Tasks for Next Session

### 1. Fix Current Integration
The createPersona method has been partially updated but needs testing:
- Lines 851-870 have the file locking integration
- Need to verify it compiles and works correctly

### 2. Complete editPersona Integration
```typescript
// Around line 1068, wrap the file write:
return await FileLockManager.withLock(`persona:${persona.metadata.name}`, async () => {
  // Existing code for file write
  await FileLockManager.atomicWriteFile(filePath, updatedContent);
  await this.loadPersonas();
  // Return success response
});
```

### 3. Add Locking to Other Operations

#### loadPersonas method
- Consider if read locking is needed
- May want to use atomicReadFile for consistency

#### BackupManager operations
- createBackup method needs locking
- Restore operations need locking
- File copy operations need atomic handling

#### Import/Export operations
- PersonaExporter needs locking
- PersonaImporter needs locking
- PersonaSharer might need locking

### 4. Integration Testing Needed
Create tests for:
- Concurrent persona creation
- Concurrent persona editing
- Backup during active edit
- Import during active operations

### 5. Create PR
Once integration is complete:
1. Run all tests
2. Fix any issues
3. Create PR for Issue #204
4. Reference the security impact

## Code Locations to Update
- `src/index.ts` - Main persona operations
- `src/update/BackupManager.ts` - Backup operations
- `src/persona/export-import/PersonaExporter.ts` - Export operations
- `src/persona/export-import/PersonaImporter.ts` - Import operations

## Testing Commands
```bash
# Test file locking specifically
npm test -- __tests__/unit/security/fileLockManager.test.ts

# Test all
npm test

# Check types
npx tsc --noEmit
```