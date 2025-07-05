# Integration Test Framework - Complete Reference

## Overview
This document contains all critical information about the integration test framework implementation for DollhouseMCP. Created on 2025-07-05 for context preservation.

## Current Status
- **Branch**: `feat/integration-test-framework`
- **PR**: #54 (created, under review)
- **Issue**: #51 - Integration test framework implementation
- **Test Results**: 5/11 tests passing (45% success rate)

## What's Been Implemented

### 1. Infrastructure Files Created
- `jest.integration.config.cjs` - Jest configuration for integration tests
- `tsconfig.test.json` - TypeScript config including test directories
- `__tests__/integration/setup.ts` - Global setup (creates test dirs)
- `__tests__/integration/teardown.ts` - Global cleanup
- `.test-tmp/` - Isolated test directory (added to .gitignore)

### 2. Test Helpers
- `__tests__/integration/helpers/test-server.ts` - Initializes PersonaManager, GitHubClient, APICache
- `__tests__/integration/helpers/test-fixtures.ts` - Test personas and mock GitHub responses
- `__tests__/integration/helpers/file-utils.ts` - File operations utilities

### 3. Integration Tests
- `__tests__/integration/persona-lifecycle.test.ts` - 11 tests covering:
  - Persona loading from file system ✅
  - Empty directory handling ✅
  - Legacy persona ID generation ✅
  - Persona creation and file persistence ❌
  - Duplicate prevention ❌
  - Activation/deactivation ✅
  - Persona switching ✅
  - Editing with file updates ❌
  - Concurrent operations ❌
  - Error handling ❌
  - Corrupted file recovery ❌

### 4. NPM Scripts Added
```json
"test:integration": "jest --config jest.integration.config.cjs",
"test:integration:watch": "jest --config jest.integration.config.cjs --watch",
"test:integration:coverage": "jest --config jest.integration.config.cjs --coverage",
"test:all": "npm test && npm run test:integration",
"test:all:coverage": "npm run test:coverage && npm run test:integration:coverage"
```

### 5. Running Integration Tests
```bash
# Required for ES modules support
NODE_OPTIONS='--experimental-vm-modules' npm run test:integration
```

## Critical Issues to Fix (from PR Reviews)

### 1. YAML Parsing Bug (CRITICAL)
**File**: `__tests__/integration/helpers/file-utils.ts`
**Lines**: 76-89
**Problem**: Manual YAML parsing breaks on complex values
```typescript
// CURRENT (BROKEN):
const [key, ...valueParts] = line.split(':');

// FIX NEEDED:
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

### 2. Race Condition in Concurrent Tests
**File**: `__tests__/integration/persona-lifecycle.test.ts`
**Lines**: 196-216
**Problem**: No synchronization between concurrent operations
```typescript
// FIX NEEDED:
const results = await Promise.allSettled(edits);
await new Promise(resolve => setTimeout(resolve, 100)); // Let FS settle
// Then verify final state
```

### 3. File Permission Cleanup
**File**: `__tests__/integration/persona-lifecycle.test.ts`
**Lines**: 229-245
**Problem**: Permissions not restored if test fails
```typescript
// FIX NEEDED:
try {
  await fs.chmod(filePath, 0o444);
  // ... test logic ...
} finally {
  await fs.chmod(filePath, 0o644); // Always restore
}
```

## Todo List Priority Order

### High Priority (Fix before merge)
1. Fix YAML parsing with gray-matter
2. Fix race condition in concurrent tests
3. Fix file permission test cleanup

### Medium Priority (Phase 2)
4. Add error recovery verification
5. Add environment variable checks
6. Add GitHub API integration tests
7. Add APICache/rate limiting tests
8. Add user identity tests
9. Add realistic error scenarios
10. Add MCP protocol tests
11. Add CI/CD integration

### Low Priority (Future)
12. Optimize batch file operations
13. Split large test file
14. Reduce timeout to 15-20s

## Key Technical Decisions

### Jest Configuration
- Uses `ts-jest` with ESM support
- `transformIgnorePatterns` includes `@modelcontextprotocol`
- Sequential execution (`maxWorkers: 1`) to prevent conflicts
- 30-second timeout for integration tests
- Separate coverage directory (`coverage-integration`)

### TypeScript Configuration
- Created `tsconfig.test.json` extending main config
- Sets `rootDir: "."` to include test directories
- Includes both `src/**/*` and `__tests__/**/*`

### Test Environment
- Global setup creates `.test-tmp/` directory structure
- Environment variables set for test directories
- Complete cleanup in global teardown
- Isolated from production personas directory

## Common Problems & Solutions

### Problem: "Cannot use import statement outside a module"
**Solution**: Run with `NODE_OPTIONS='--experimental-vm-modules'`

### Problem: TypeScript rootDir errors
**Solution**: Use `tsconfig.test.json` with appropriate rootDir

### Problem: Import path issues
**Solution**: Module name mapper handles `.js` extensions

## Next Session Starting Point

1. Check out the branch: `git checkout feat/integration-test-framework`
2. Fix the 3 critical issues identified in PR reviews
3. Run tests: `NODE_OPTIONS='--experimental-vm-modules' npm run test:integration`
4. Update PR with fixes
5. Continue with medium priority items

## Files Modified/Created
```
modified:   .gitignore
modified:   package.json
modified:   src/marketplace/GitHubClient.ts (removed duplicate import)
new file:   jest.integration.config.cjs
new file:   tsconfig.test.json
new file:   __tests__/integration/setup.ts
new file:   __tests__/integration/teardown.ts
new file:   __tests__/integration/helpers/test-server.ts
new file:   __tests__/integration/helpers/test-fixtures.ts
new file:   __tests__/integration/helpers/file-utils.ts
new file:   __tests__/integration/persona-lifecycle.test.ts
new file:   docs/development/INTEGRATION_TEST_PLAN.md
new file:   docs/development/SESSION_SUMMARY_2025_07_05_INTEGRATION_TESTS.md
```

## Review Scores
- First review: A- (Excellent with minor improvements needed)
- Second review: 8/10 (Strong foundation with room for refinement)

Both reviews praised the architecture and identified the same critical issues.