# Critical Context: Security Audit Suppression PR #260

## THE PROBLEM
CI is failing with 172 security findings, but locally we only have 32. This is blocking all PRs.

## WHAT'S BEEN DONE
1. Created comprehensive suppression system in `src/security/audit/config/suppressions.ts`
2. Fixed CodeQL issue (regex injection)
3. Added unit tests
4. Improved code quality significantly

## WHAT'S NOT WORKING
1. **Test file suppressions in CI** - The patterns aren't matching test files in CI environment
2. **Path resolution** - CI paths like `/home/runner/work/mcp-server/mcp-server/src/file.ts` aren't being converted to `src/file.ts` correctly
3. **Some unit tests failing** - Path normalization and glob pattern tests

## THE CRITICAL FIX NEEDED

### In `suppressions.ts` around line 399:
The `getRelativePath()` function needs to correctly extract relative paths from CI absolute paths.

### Current Implementation Has Issues:
- It's looking for `/mcp-server/` but might need to handle variations
- Windows path handling needs work
- The regex matching is fragile

### Test Files Not Being Suppressed:
In CI, we're seeing tons of findings in test files for:
- Hardcoded secrets (OWASP-A01-001) 
- SQL injection patterns (CWE-89-001)
- Command injection (OWASP-A03-002)

These should ALL be suppressed by:
```typescript
{ rule: '*', file: '__tests__/**/*' }
{ rule: '*', file: '**/*.test.ts' }
```

## QUICK DEBUG STEPS

1. **See what paths CI is using**:
   Look at the security audit failure - it shows full paths

2. **Test path resolution**:
   ```typescript
   console.log(getRelativePath('/home/runner/work/mcp-server/mcp-server/__tests__/unit/test.ts'));
   // Should return: __tests__/unit/test.ts
   ```

3. **Test glob patterns**:
   ```typescript
   console.log(globToRegex('__tests__/**/*').test('__tests__/unit/test.ts'));
   // Should return: true
   ```

## SUCCESS CRITERIA
When you run `npm run security:audit`:
- Locally: ~32 findings (legitimate ones)
- In CI: Same ~32 findings (not 172!)

The difference is ALL test file false positives that should be suppressed.

## REMEMBER
The reviewer wants QUALITY:
- Robust path handling
- Proper caching
- Clear code
- Good tests
- Works everywhere

Don't just make it work - make it excellent!