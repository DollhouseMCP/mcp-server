# PR #80: Fix Critical CI Path Resolution Issues - Comprehensive Context

## Issue Background

This PR addresses critical CI test failures (Issues #78 and #79) that were blocking all PR merges. The failures were caused by path resolution differences between local development and CI environments, specifically with Jest being unable to resolve TypeScript modules with `.js` extensions in ESM projects.

## Changes Made in This PR

### 1. Path Resolution Fixes (First Commits)
- **Files Changed**: `VersionManager.ts`, `UpdateManager.ts`, `BackupManager.ts`, `index.ts`
- **Change**: Replaced all `__dirname` usage with `process.cwd()`
- **Reason**: `__dirname` resolves differently in CI environments where compiled files run from different locations
- **Implementation**: Added upward search algorithm in VersionManager to find package.json from any directory

### 2. Import Consistency Fixes
- **Files Changed**: All test files in `__tests__/unit/auto-update/`
- **Change**: Added `.js` extensions to all imports
- **Reason**: ESM requires `.js` extensions for TypeScript imports

### 3. Jest Configuration Updates (Latest Commits)
- **File**: `jest.config.cjs`
- **Changes Made**:
  - Updated moduleNameMapper to dual pattern approach
  - Added explicit `<rootDir>` prefixes to all paths
  - Added `ts-jest-resolver` as custom resolver
  - Set `isolatedModules: true` for TypeScript compatibility
- **Reason**: Jest in CI couldn't resolve modules despite files existing

### 4. CI Workflow Updates
- **File**: `.github/workflows/core-build-test.yml`
- **Changes Made**:
  - Added `NODE_OPTIONS: '--experimental-vm-modules'` to environment
  - Added explicit Jest cache clearing step
  - Added extensive debugging (temporary)
- **Reason**: Enable ESM support and debug CI-specific issues

### 5. Removed Unused Import
- **File**: `VersionManager.ts`
- **Change**: Removed unused `import { fileURLToPath } from 'url'`
- **Reason**: No longer needed after switching to `process.cwd()`

## PR Review Findings Addressed

### ✅ Addressed Issues:
1. **Path Resolution**: Implemented robust upward search for package.json
2. **Jest Configuration**: Applied multiple fixes including custom resolver
3. **Import Consistency**: All imports now use `.js` extensions
4. **Unused Import**: Removed from VersionManager.ts
5. **.dockerignore**: Already restored in commit c211f8b

### ⚠️ Known Limitations (Documented for Future Work):
1. **5-Level Search Limit**: The upward search is limited to 5 directory levels. This is intentional to prevent infinite loops but could be made configurable in future.
2. **CI Debugging Code**: Extensive debugging added to workflow will be removed once CI passes
3. **Performance**: Path resolution could be cached for better performance (future optimization)

## Root Cause Analysis

The core issue is that Jest's module resolution behaves differently in CI environments when dealing with TypeScript files imported with `.js` extensions (required for ESM). This is a well-known issue in the TypeScript/Jest/ESM ecosystem.

### Why It Fails in CI:
1. Working directory differences between local and CI
2. Jest's module resolution doesn't handle `.js` → `.ts` mapping correctly in CI
3. Different Node.js module resolution algorithms between environments

### Solution Applied:
1. **ts-jest-resolver**: Custom resolver specifically designed for this issue
2. **Explicit rootDir**: All paths now use `<rootDir>` prefix for consistency
3. **Dual moduleNameMapper**: Handles both `./` and `../` relative imports
4. **NODE_OPTIONS**: Ensures experimental VM modules are enabled

## Testing Status

### Local Testing: ✅ All 211 tests pass
### CI Testing: 🔄 In Progress (awaiting results from latest fixes)

## Security Considerations

- No security vulnerabilities introduced
- Path resolution changes don't expose new attack vectors
- .dockerignore was temporarily deleted but has been restored

## Next Steps if CI Still Fails

If the current approach doesn't resolve CI issues, the following alternatives are available:
1. Try `jest-ts-webcompat-resolver` instead of `ts-jest-resolver`
2. Create custom Jest resolver tailored to our specific needs
3. Add environment-specific Jest configurations
4. Consider switching from `.js` extensions in imports (last resort)

## Documentation for Future Sessions

This PR represents multiple attempts to fix a complex CI-specific issue. All changes are focused on making Jest module resolution work consistently across environments while maintaining ESM compatibility.

Key learnings:
- Always use `<rootDir>` in Jest configurations for CI compatibility
- Custom resolvers are often needed for TypeScript + ESM + Jest
- Path resolution must be environment-agnostic (avoid `__dirname`)
- PR documentation must be comprehensive and included with code changes