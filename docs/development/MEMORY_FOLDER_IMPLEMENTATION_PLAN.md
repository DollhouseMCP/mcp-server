# Memory Folder Structure Implementation Plan

## Executive Summary
Implement date-based folder organization for memory elements to prevent flat directory issues when scaling to 10K+ files/year. This is a clean implementation with NO backward compatibility needed (memories haven't been released yet).

## Current State Verification ✅
- **MemoryManager.ts exists**: VERIFIED - Lines 1-350+ implementing IElementManager
- **Memory.test.ts exists**: VERIFIED - Unit tests in place
- **constants.ts exists**: VERIFIED - Constants and security events defined
- **No existing memory files**: VERIFIED - Clean slate for new structure

## Implementation Requirements

### 1. Core Folder Structure
```
~/.dollhouse/portfolio/memories/
├── 2025-09-18/                    # Date folders (YYYY-MM-DD)
│   ├── session-morning.yaml       # Single file (<100KB)
│   └── dnd-players-handbook/      # Multi-part (>100KB) [FUTURE]
│       ├── index.yaml             # Manifest
│       └── part001.yaml           # Sharded content
```

### 2. Key Features to Implement
1. **Date-based folder organization** - YYYY-MM-DD folders
2. **Content hash generation** - SHA-256 for deduplication (Issue #994)
3. **Collision handling** - Version suffixes (-v2, -v3) for same names
4. **Platform source tagging** - Metadata for generation platform
5. **Enhanced MemoryManager** - Support new folder structure

## Files to Modify (EXACT IMPLEMENTATION)

### A. MemoryManager.ts Changes

#### Add to class properties (line ~31):
```typescript
private contentHashIndex: Map<string, string> = new Map();
```

#### Add new method - generateMemoryPath (after line ~107):
```typescript
/**
 * Generate date-based path for memory storage
 * Creates YYYY-MM-DD folder structure to prevent flat directory issues
 * @param element Memory element to save
 * @param fileName Optional custom filename
 * @returns Full path to memory file
 */
private async generateMemoryPath(element: Memory, fileName?: string): Promise<string> {
  const date = new Date();
  const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const datePath = path.join(this.memoriesDir, dateFolder);

  // Ensure date folder exists
  await fs.mkdir(datePath, { recursive: true });

  // Generate filename
  const baseName = fileName || `${element.metadata.name?.toLowerCase().replace(/\s+/g, '-') || 'memory'}.yaml`;
  let finalName = baseName;
  let version = 1;

  // Handle collisions with version suffix
  while (await fs.access(path.join(datePath, finalName)).then(() => true).catch(() => false)) {
    version++;
    finalName = baseName.replace('.yaml', `-v${version}.yaml`);
  }

  return path.join(datePath, finalName);
}
```

#### Add new method - calculateContentHash (after generateMemoryPath):
```typescript
/**
 * Calculate SHA-256 hash of memory content for deduplication
 * Implements Issue #994 - Content-based deduplication
 */
private calculateContentHash(element: Memory): string {
  const crypto = require('crypto');
  const content = JSON.stringify({
    metadata: element.metadata,
    entries: JSON.parse(element.serialize()).entries
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}
```

#### Add new method - getDateFolders (after calculateContentHash):
```typescript
/**
 * Get all date folders in memories directory
 * @returns Array of date folder names
 */
private async getDateFolders(): Promise<string[]> {
  try {
    const entries = await fs.readdir(this.memoriesDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse(); // Most recent first
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
```

#### Update save method (line ~113):
```typescript
async save(element: Memory, filePath?: string): Promise<void> {
  try {
    // Validate element
    const validation = element.validate();
    if (!validation.valid) {
      throw new Error(`Invalid memory: ${validation.errors?.map(e => e.message).join(', ')}`);
    }

    // Calculate content hash for deduplication
    const contentHash = this.calculateContentHash(element);
    const existingPath = this.contentHashIndex.get(contentHash);

    if (existingPath) {
      // Log duplicate detection
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_DUPLICATE_DETECTED',
        severity: 'LOW',
        source: 'MemoryManager.save',
        details: `Duplicate content detected. Existing: ${existingPath}`
      });
    }

    // Generate date-based path if not provided
    const fullPath = filePath
      ? await this.validateAndResolvePath(filePath)
      : await this.generateMemoryPath(element);

    // Ensure parent directory exists (for date folders)
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // [Rest of save implementation remains the same...]

    // Update content hash index
    this.contentHashIndex.set(contentHash, fullPath);
```

#### Update load method to check date folders (line ~43):
```typescript
async load(filePath: string): Promise<Memory> {
  try {
    let fullPath: string;

    // Check if it's a relative path (no date folder)
    if (!filePath.includes(path.sep) || !filePath.match(/^\d{4}-\d{2}-\d{2}/)) {
      // Search in date folders
      const dateFolders = await this.getDateFolders();
      let found = false;

      for (const dateFolder of dateFolders) {
        const testPath = path.join(this.memoriesDir, dateFolder, filePath);
        if (await fs.access(testPath).then(() => true).catch(() => false)) {
          fullPath = testPath;
          found = true;
          break;
        }
      }

      if (!found) {
        // Fall back to root directory for backward compatibility during transition
        fullPath = await this.validateAndResolvePath(filePath);
      }
    } else {
      fullPath = await this.validateAndResolvePath(filePath);
    }

    // [Rest of load implementation remains the same...]
```

#### Update list method to search date folders (line ~200):
```typescript
async list(): Promise<Memory[]> {
  const memories: Memory[] = [];

  try {
    // Get all date folders
    const dateFolders = await this.getDateFolders();

    // Also check root directory for any legacy files
    const rootFiles = await fs.readdir(this.memoriesDir)
      .then(files => files.filter(f => f.endsWith('.yaml')))
      .catch(() => []);

    // Process root files first (legacy)
    for (const file of rootFiles) {
      try {
        const memory = await this.load(file);
        memories.push(memory);
      } catch (error) {
        SecurityMonitor.logSecurityEvent({
          type: MEMORY_SECURITY_EVENTS.MEMORY_LIST_ITEM_FAILED,
          severity: 'LOW',
          source: 'MemoryManager.list',
          details: `Failed to load ${file}: ${error}`
        });
      }
    }

    // Process date folders
    for (const dateFolder of dateFolders) {
      const folderPath = path.join(this.memoriesDir, dateFolder);
      const files = await fs.readdir(folderPath)
        .then(files => files.filter(f => f.endsWith('.yaml')))
        .catch(() => []);

      for (const file of files) {
        try {
          const memory = await this.load(path.join(dateFolder, file));
          memories.push(memory);
        } catch (error) {
          SecurityMonitor.logSecurityEvent({
            type: MEMORY_SECURITY_EVENTS.MEMORY_LIST_ITEM_FAILED,
            severity: 'LOW',
            source: 'MemoryManager.list',
            details: `Failed to load ${dateFolder}/${file}: ${error}`
          });
        }
      }
    }

    return memories;
  } catch (error) {
    // [Rest remains the same...]
```

### B. constants.ts Changes

#### Add new event type (line ~112):
```typescript
  MEMORY_DUPLICATE_DETECTED: 'MEMORY_DUPLICATE_DETECTED',
```

### C. SecurityMonitor Updates

#### Add to securityMonitor.ts event types:
```typescript
  | 'MEMORY_DUPLICATE_DETECTED'
```

## Test Updates Required

### MemoryManager.test.ts Updates

#### Add test for date folder creation:
```typescript
describe('date folder structure', () => {
  it('should create date-based folders when saving', async () => {
    const memory = new Memory({
      name: 'Test Memory',
      description: 'Testing date folders'
    });

    await manager.save(memory);

    // Check that a date folder was created
    const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
    const dateFolders = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name));
    expect(dateFolders).toHaveLength(1);

    // Check file exists in date folder
    const dateFolder = dateFolders[0].name;
    const files = await fs.readdir(path.join(memoriesDir, dateFolder));
    expect(files.some(f => f.includes('test-memory'))).toBe(true);
  });

  it('should handle collisions with version suffix', async () => {
    const memory1 = new Memory({ name: 'Same Name' });
    const memory2 = new Memory({ name: 'Same Name' });

    await manager.save(memory1);
    await manager.save(memory2);

    const dateFolders = await fs.readdir(memoriesDir, { withFileTypes: true });
    const dateFolder = dateFolders.find(e => e.isDirectory())?.name;
    const files = await fs.readdir(path.join(memoriesDir, dateFolder!));

    expect(files).toContain('same-name.yaml');
    expect(files).toContain('same-name-v2.yaml');
  });

  it('should find memories across date folders', async () => {
    // Create memories in different date folders
    const date1 = '2025-09-17';
    const date2 = '2025-09-18';

    await fs.mkdir(path.join(memoriesDir, date1), { recursive: true });
    await fs.mkdir(path.join(memoriesDir, date2), { recursive: true });

    const memory1 = new Memory({ name: 'Memory 1' });
    const memory2 = new Memory({ name: 'Memory 2' });

    // Manually save to specific date folders for testing
    await manager.save(memory1, `${date1}/memory1.yaml`);
    await manager.save(memory2, `${date2}/memory2.yaml`);

    const memories = await manager.list();
    expect(memories).toHaveLength(2);
    expect(memories.map(m => m.metadata.name)).toContain('Memory 1');
    expect(memories.map(m => m.metadata.name)).toContain('Memory 2');
  });

  it('should detect duplicate content', async () => {
    const memory1 = new Memory({ name: 'Original' });
    await memory1.addEntry('Same content', ['test']);

    const memory2 = new Memory({ name: 'Duplicate' });
    await memory2.addEntry('Same content', ['test']);

    // Mock SecurityMonitor to capture events
    const logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

    await manager.save(memory1);
    await manager.save(memory2);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MEMORY_DUPLICATE_DETECTED'
      })
    );
  });
});
```

## Success Criteria

1. ✅ All memories saved to date-based folders
2. ✅ No flat directory with thousands of files
3. ✅ Collision handling with -v2, -v3 suffixes
4. ✅ Content hash detection for duplicates
5. ✅ All existing tests pass
6. ✅ New tests for folder structure pass
7. ✅ Clean implementation (<30 files changed)
8. ✅ Security events logged properly
9. ✅ No test/benchmark files in commit

## Implementation Order

1. Create this plan document
2. Update constants.ts with new event
3. Update MemoryManager.ts with all changes
4. Update securityMonitor.ts
5. Update all tests
6. Run tests to verify
7. Create clean commit
8. Create PR

## Verification Checklist

- [ ] Date folders created correctly
- [ ] Files saved with correct names
- [ ] Collisions handled with versions
- [ ] Duplicates detected via hash
- [ ] Load finds files in date folders
- [ ] List returns all memories
- [ ] All tests passing
- [ ] No extra files in commit
- [ ] Security events logged

## Related Issues
- #994 - Content-based deduplication (partial implementation)
- #993 - Git-managed portfolio structure (foundation)
- #981 - Memory sharding (foundation for future)

## Git Commands
```bash
# After implementation
git add src/elements/memories/
git add src/security/securityMonitor.ts
git add test/__tests__/unit/elements/memories/
git add docs/development/MEMORY_FOLDER_IMPLEMENTATION_PLAN.md

# Verify clean commit
git status --short

# Commit
git commit -m "feat: Implement memory folder structure with date-based organization

- Date folders (YYYY-MM-DD) prevent flat directory issues
- Content hash detection for duplicates (Issue #994)
- Collision handling with version suffixes
- Updated all tests for new structure
- No backward compatibility needed (memories not released)"

# Push and create PR
git push -u origin feature/memory-folder-structure-v2
gh pr create --title "feat: Memory folder structure with date-based organization" \
  --body "Implementation of date-based folder structure for memory storage..."
```