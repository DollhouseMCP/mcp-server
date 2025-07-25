# CI Fixes Session - July 6, 2025

## Critical Context for Next Session

### IMPORTANT: PR Documentation Rule
**ALL documentation MUST be included in the PR code itself, NOT in separate comments.** The PR review bot process breaks when documentation is posted separately. Include all explanations, context, and documentation as code comments or in the PR description when creating it.

## Session Summary

Started with critical CI failures blocking all PR merges (Issues #78 and #79). Made significant progress but didn't fully resolve the issues.

### Branch: `fix-ci-critical-issues`
### PR: #80

## Changes Made

### 1. Path Resolution Fixes (Issue #78)
- Replaced all `__dirname` usage with `process.cwd()` in:
  - `src/update/VersionManager.ts`
  - `src/update/UpdateManager.ts`
  - `src/update/BackupManager.ts`
  - `src/index.ts`
- Updated VersionManager to search upward for package.json instead of using fragile relative paths

### 2. Import Path Consistency
- Added `.js` extensions to all imports in auto-update tests
- Fixed inconsistent import patterns that were causing module resolution issues

### 3. Jest Configuration Updates
```javascript
// jest.config.cjs key changes:
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  extensionsToTreatAsEsm: ['.ts'],
  // ... other config ...
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};
```

### 4. CI Workflow Debugging
Added extensive debugging to `.github/workflows/core-build-test.yml`:
- Disabled TypeScript cache temporarily
- Added file structure debugging
- Added Node/NPM version output
- Added Jest config display

## Current Problem

### Jest Module Resolution in CI
Tests pass locally but fail in CI with errors:
```
Cannot find module '../../../src/update/BackupManager.js'
ENOENT: no such file or directory, open '/home/runner/work/DollhouseMCP/DollhouseMCP/src/config/constants.ts'
```

### Key Observations:
1. All source files exist in CI (verified with ls commands)
2. Jest's moduleNameMapper is not working correctly in CI
3. The issue appears to be with how Jest resolves TypeScript files with .js extensions
4. Windows CI was passing initially but now fails too
5. Docker tests pass (they don't use Jest)

## Next Steps for Resolution

### 1. Investigate Jest Resolution
The core issue is that Jest in CI cannot resolve modules despite:
- Files existing
- Correct import paths
- Working locally

### 2. Potential Solutions to Try:
1. **Custom Jest Resolver**: Create a custom resolver that handles .js → .ts mapping
2. **Different Module Mapper**: Try a more explicit moduleNameMapper configuration
3. **Jest Transform**: Ensure ts-jest is properly transforming files in CI
4. **Environment Variables**: Check if CI needs specific NODE_OPTIONS or other env vars

### 3. Debug Information Needed:
- Jest's actual resolution process in CI
- Differences between local and CI node_modules
- Whether ts-jest is correctly installed and configured in CI

## Code State

### Files Modified:
- `src/update/VersionManager.ts` - Path resolution fixes
- `src/update/UpdateManager.ts` - Path resolution fixes
- `src/update/BackupManager.ts` - Path resolution fixes
- `src/index.ts` - Path resolution fixes
- `jest.config.cjs` - Configuration updates
- `.github/workflows/core-build-test.yml` - Debugging additions
- All files in `__tests__/unit/auto-update/` - Import path fixes

### Commits on Branch:
1. `270f4c0` - Fix CI path resolution issues for Ubuntu and macOS
2. `364ea73` - Fix Jest rootDir configuration for CI environments
3. `3d890f5` - Fix import paths in auto-update tests for CI compatibility
4. `0323141` - Add more debugging to CI and ensure extensionsToTreatAsEsm is at top level

## Critical Information for Next Session

### The Real Issue:
Jest in the CI environment cannot resolve TypeScript modules when imported with .js extensions. This is a known issue with ESM and TypeScript. The moduleNameMapper `'^(\\.{1,2}/.*)\\.js$': '$1'` is supposed to strip the .js extension so Jest can find the .ts files, but it's not working in CI.

### What Works:
- Building TypeScript (tsc) works fine
- Docker tests pass (they run compiled JS)
- Local Jest tests pass

### What Doesn't Work:
- Jest tests in GitHub Actions CI
- Module resolution for TypeScript files with .js imports

### Most Likely Root Cause:
The CI environment has a different directory structure or Jest is running from a different working directory than expected. The debug output from the next CI run should reveal this.

## Environment Details
- Node: 20.x
- OS: Ubuntu, macOS, Windows (all fail)
- Jest: Using ts-jest with ESM preset
- TypeScript: ES2022 target with ESM modules