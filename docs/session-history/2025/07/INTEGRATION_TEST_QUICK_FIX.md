# Integration Test Framework - Quick Fix Guide

## Immediate Actions Required (PR #54)

### 1. Fix YAML Parsing (file-utils.ts:76-89)
```typescript
// DELETE the manual parsing logic (lines 76-89)
// REPLACE WITH:
import matter from 'gray-matter';

export async function readPersonaFile(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, 'utf-8');
  const parsed = matter(content);
  return {
    metadata: parsed.data,
    content: parsed.content.trim()
  };
}
```

### 2. Fix Concurrent Test (persona-lifecycle.test.ts:196-216)
```typescript
it('should handle concurrent edits gracefully', async () => {
  // Replace Promise.all with Promise.allSettled
  const results = await Promise.allSettled(edits);
  
  // Add synchronization delay
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Then verify - all should have succeeded
  results.forEach(result => {
    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') {
      expect(result.value.success).toBe(true);
    }
  });
  
  // Verify final state...
});
```

### 3. Fix Permission Test (persona-lifecycle.test.ts:232-245)
```typescript
it('should handle file system errors gracefully', async () => {
  await testServer.personaManager.createPersona(
    'Error Test',
    'Test persona',
    'general',
    'Test content'
  );
  
  const filePath = path.join(personasDir, 'error-test.md');
  const fs = await import('fs/promises');
  
  try {
    // Make read-only
    await fs.chmod(filePath, 0o444);
    
    // Try to edit (should fail gracefully)
    const result = await testServer.personaManager.editPersona(
      'Error Test',
      'description',
      'Updated description'
    );
    
    expect(result.success).toBe(false);
    expect(result.message).toContain('Failed to edit persona');
  } finally {
    // ALWAYS restore permissions
    await fs.chmod(filePath, 0o644);
  }
});
```

## Test Command
```bash
NODE_OPTIONS='--experimental-vm-modules' npm run test:integration
```

## Expected Results After Fixes
- All 11 tests should pass
- No more YAML parsing errors
- Concurrent operations properly synchronized
- File permissions always restored

## Next Steps After Fixes
1. Commit fixes
2. Push to PR
3. Request re-review
4. Move to Phase 2 (GitHub API tests, etc.)