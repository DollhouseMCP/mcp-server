# CI Jest Diagnosis and Refactor Analysis

## Executive Summary

This document analyzes the critical CI test failures that began after refactoring the monolithic `index.ts` file into a modular structure. We are implementing Option A (compile TypeScript first, then test) as a diagnostic approach to determine if the modular refactoring is the root cause of Jest's module resolution failures in CI.

## Historical Context

### Before Refactoring
- **Structure**: Single monolithic `index.ts` file containing all server logic
- **Testing**: All tests could import from one file
- **CI Status**: Tests passing in all environments

### After Refactoring
- **Structure**: Code split into multiple files across directories:
  ```
  src/
  ├── index.ts (main entry)
  ├── config/
  │   └── constants.ts
  ├── update/
  │   ├── BackupManager.ts
  │   ├── UpdateManager.ts
  │   ├── VersionManager.ts
  │   └── ...
  └── ...
  ```
- **Testing**: Tests now require deep relative imports like `../../../src/update/BackupManager.js`
- **CI Status**: Tests fail with "Cannot find module" errors despite files existing

## The Problem

### Symptoms
1. Jest tests pass locally but fail in CI environments
2. Error: `Cannot find module '../../../src/update/BackupManager.js'`
3. All source files exist (verified with debug logging)
4. Docker tests pass (they use compiled JavaScript)

### Failed Solutions
1. **moduleNameMapper patterns** - Multiple variations tried
2. **ts-jest-resolver** - Custom resolver didn't help
3. **Path updates** - Using `<rootDir>` prefixes
4. **NODE_OPTIONS** - Added `--experimental-vm-modules`

### Root Cause Hypothesis
The refactoring from monolithic to modular structure introduced complexity that Jest + ts-jest + ESM cannot handle properly in CI environments:
- Deep relative imports are more fragile
- Module boundaries create resolution contexts
- TypeScript's requirement for `.js` extensions in ESM conflicts with Jest's module resolution

## Option A: Compile-First Testing Approach

### Implementation Plan

#### Step 1: Modify Jest Configuration
Create a new Jest configuration that tests compiled JavaScript instead of TypeScript:

```javascript
// jest.config.compiled.cjs
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: [
    '<rootDir>/dist/**/__tests__/**/*.test.js',
    '<rootDir>/dist/**/?(*.)+(spec|test).js'
  ],
  // No TypeScript transformation needed
  transform: {},
  // No module name mapping needed - using real JS files
  moduleNameMapper: {},
  // Still need setup file but compiled version
  setupFilesAfterEnv: ['<rootDir>/dist/jest.setup.js'],
  testTimeout: 10000
};
```

#### Step 2: Update Test Script
Modify the test process to compile first:

```json
{
  "scripts": {
    "test:ci": "npm run build && cross-env NODE_OPTIONS='--experimental-vm-modules' jest --config jest.config.compiled.cjs",
    "test": "cross-env NODE_OPTIONS='--experimental-vm-modules --no-warnings' jest"
  }
}
```

#### Step 3: Ensure Test Files Are Compiled
Update `tsconfig.json` to include test files in compilation:

```json
{
  "compilerOptions": {
    // existing options...
  },
  "include": [
    "src/**/*",
    "__tests__/**/*",  // Add this
    "jest.setup.mjs"   // Add this
  ]
}
```

#### Step 4: Update CI Workflow
Modify `.github/workflows/core-build-test.yml`:

```yaml
- name: Build project
  run: npm run build

- name: Run test suite
  run: npm run test:ci  # Uses compiled output
```

### Expected Outcomes

#### If Tests Pass with Compiled Code:
- **Confirms**: The refactoring created a module structure that Jest+ts-jest cannot handle
- **Indicates**: The issue is specifically with TypeScript transformation and `.js` extension resolution
- **Next Steps**: Either keep compile-first approach or investigate Jest alternatives

#### If Tests Still Fail:
- **Indicates**: The problem is deeper than just TypeScript resolution
- **Possibilities**:
  - Circular dependencies introduced during refactoring
  - Import/export patterns that don't work in certain environments
  - Working directory issues that affect even compiled code

### Diagnostic Information to Collect

1. **Build Output Structure**: Verify `dist/` mirrors `src/` structure
2. **Import Paths**: Check if compiled imports resolve correctly
3. **Error Messages**: Compare error messages between TS and JS testing
4. **Performance**: Measure time difference between approaches

## Alternative Approaches (If Option A Fails)

### Option B: Gradual Rollback
- Identify which specific files cause issues
- Temporarily consolidate problem modules
- Systematically split again with better testing

### Option C: Different Test Runner
- Consider Vitest (better ESM support)
- Consider running tests with Node.js directly
- Use a test runner designed for ESM+TypeScript

### Option D: Restructure Imports
- Use path aliases instead of relative imports
- Implement barrel exports carefully
- Reduce import depth

## Success Criteria

1. **Immediate**: CI tests pass in all environments
2. **Diagnostic**: Understand exactly why current approach fails
3. **Long-term**: Sustainable testing strategy that works with modular structure

## Implementation Checklist

- [ ] Create `jest.config.compiled.cjs`
- [ ] Update `tsconfig.json` to include test files
- [ ] Add `test:ci` script to package.json
- [ ] Modify CI workflow to use compiled testing
- [ ] Run tests locally with new configuration
- [ ] Push changes and monitor CI
- [ ] Document findings and decide on permanent solution

## Key Insights

1. **Docker Tests Pass**: This is our strongest indicator that compilation approach will work
2. **Refactor Timing**: The correlation between refactoring and test failures is not coincidental
3. **Module Complexity**: Modern JavaScript module systems (ESM) + TypeScript + Jest create a complex resolution chain that can break in subtle ways

## Next Steps

1. Implement Option A as described above
2. Collect diagnostic data from CI runs
3. Make decision on permanent testing strategy based on results
4. Consider project structure improvements if needed

This diagnostic approach will either:
- Provide a working solution (compiled testing)
- Reveal deeper issues that need addressing
- Guide us toward the right permanent solution