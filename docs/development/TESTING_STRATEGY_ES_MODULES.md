# Testing Strategy: ES Modules and Excluded Tests

## Overview

This document explains our testing strategy for handling ES module compatibility issues in Jest, particularly why some tests are written but temporarily excluded from execution.

## The Challenge

As of 2025, we're in a transition period where:
- Our codebase uses modern ES modules (`import`/`export`)
- Jest's ES module support is still experimental and incomplete
- Some tests cause Jest to hang due to complex module mocking requirements

## Our Strategy: Write Now, Run Later

### Core Principle
**We write tests even if they can't run yet.** Tests that are currently incompatible with Jest's ES module support are:
1. Written completely and correctly
2. Excluded from execution in `jest.config.cjs`
3. Documented as ready to enable when tooling improves

### Why This Approach?

1. **Documentation Value**: Tests document expected behavior even when not running
2. **Future-Ready**: When Jest improves or we switch test runners, tests are ready
3. **Prevents Regression**: Developers see tests exist and understand the code's intent
4. **No Lost Work**: The effort of writing tests isn't wasted

## Currently Excluded Tests

As of August 2025, these test files are excluded due to ES module mocking issues:

```javascript
// test/jest.config.cjs
testPathIgnorePatterns: [
  'convertToGit\\.test\\.ts$',        // Complex git operations mocking
  'UpdateManager\\.npm\\.test\\.ts$',  // NPM operations mocking
  'BackupManager\\.npm\\.test\\.ts$',  // File system operations
  'InstallationDetector\\.test\\.ts$', // System detection mocking
  'GitHubAuthManager\\.test\\.ts$',    // Fetch and auth mocking
  'CollectionCache\\.test\\.ts$'       // File system operations
]
```

### Common Patterns That Cause Issues

1. **Global Mocking**: `global.fetch`, `global.process`
2. **File System**: `fs/promises` module mocking
3. **Complex Dependencies**: Multiple interconnected module mocks
4. **Circular Dependencies**: Modules that import each other
5. **Dynamic Imports**: Runtime module loading

## How to Check If Tests Can Be Re-enabled

Periodically (e.g., after Jest updates), try re-enabling tests:

```bash
# 1. Remove a test from the ignore list in jest.config.cjs
# 2. Run the specific test
npm test -- test/__tests__/unit/auth/GitHubAuthManager.test.ts

# If it passes without hanging, the test can be permanently enabled
```

## Writing New Tests with ES Module Issues

When you encounter ES module mocking issues:

### 1. Write the Complete Test
```typescript
// Write the test as if mocking worked perfectly
describe('MyModule', () => {
  it('should handle the expected behavior', () => {
    // Complete test implementation
  });
});
```

### 2. Document the Issue
```typescript
/**
 * Tests for MyModule
 * 
 * Note: These tests are currently excluded in jest.config.cjs due to
 * ES module mocking issues with jest.unstable_mockModule().
 * The tests are correct and will be enabled when Jest's ES module
 * support improves.
 */
```

### 3. Add to Exclusion List
```javascript
// test/jest.config.cjs
testPathIgnorePatterns: [
  // ... existing exclusions ...
  'MyModule\\.test\\.ts$'  // ES module mocking causes hang
]
```

### 4. Create Tracking Issue (Optional)
Create a GitHub issue to track re-enabling the tests:
- Title: "Re-enable MyModule tests when Jest ES module support improves"
- Label: `area: testing`, `priority: low`
- Include Jest version that might fix it

## Alternative Solutions

### Short-term Workarounds
1. **Manual Mocks**: Create `__mocks__` directories
2. **Dependency Injection**: Refactor code to accept dependencies
3. **Integration Tests**: Test at a higher level without mocking

### Long-term Solutions
1. **Jest Updates**: Wait for better ES module support (actively being developed)
2. **Vitest Migration**: Consider switching to Vitest which has better ES module support
3. **Playwright/Cypress**: Use E2E tests for complex scenarios

## Timeline and Expectations

### Current State (2025)
- Jest 29.x has experimental ES module support via `--experimental-vm-modules`
- `jest.unstable_mockModule()` is available but has limitations
- Many projects face similar issues during the CommonJS → ES modules transition

### Expected Progress
- **6 months**: Jest 30.x may have improved ES module support
- **12 months**: ES module mocking should be stable
- **Alternative**: Consider Vitest if Jest progress is slow

## Best Practices

### DO:
✅ Write complete tests even if they can't run  
✅ Document why tests are excluded  
✅ Add clear comments in jest.config.cjs  
✅ Periodically check if tests can be re-enabled  
✅ Keep tests up-to-date with code changes  

### DON'T:
❌ Skip writing tests because of tooling issues  
❌ Delete tests that can't currently run  
❌ Leave tests enabled if they hang CI  
❌ Forget to document the exclusion reason  

## Success Metrics

We consider this strategy successful when:
1. All critical paths have tests (even if excluded)
2. Test coverage would be >96% if all tests ran
3. Developers understand which tests are excluded and why
4. Tests can be progressively re-enabled as tooling improves

## References

- [Jest ES Modules Documentation](https://jestjs.io/docs/ecmascript-modules)
- [Jest Issue #9430: ES Modules Support](https://github.com/facebook/jest/issues/9430)
- [Our ES Module Migration Guide](./ENSEMBLE_JEST_MOCK_FIX_GUIDE.md)
- [Node.js ES Modules](https://nodejs.org/api/esm.html)

---

*Last Updated: August 2025*  
*Next Review: When Jest 30.x releases*