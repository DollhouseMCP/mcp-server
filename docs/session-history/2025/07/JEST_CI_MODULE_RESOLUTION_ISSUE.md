# Jest CI Module Resolution Issue - Investigation Guide

## Problem Statement

Jest tests pass locally but fail in GitHub Actions CI with module resolution errors when importing TypeScript files with `.js` extensions in an ESM project.

## Specific Error
```
Cannot find module '../../../src/update/BackupManager.js' from '__tests__/unit/auto-update/BackupManager.simple.test.ts'

Configuration error:
Could not locate module ../../../src/update/UpdateManager.js mapped as:
$1.
```

## Environment Details
- **Jest**: v29.x with ts-jest
- **TypeScript**: ES2022 target, ESM modules
- **Node**: 20.x
- **Package Type**: ESM (type: "module" likely in package.json)
- **Jest Config**: Using `ts-jest/presets/default-esm`
- **CI**: GitHub Actions (Ubuntu, macOS, Windows - all fail)

## Current Configuration
```javascript
// jest.config.cjs
const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  rootDir: '.',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { 
      useESM: true,
      tsconfig: {
        allowJs: true,
        rootDir: '.',
        isolatedModules: true
      }
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
};
```

## What Works
- ✅ Local Jest tests pass
- ✅ TypeScript compilation (tsc) works
- ✅ Docker tests pass (they run compiled JS)
- ✅ All source files exist in CI (verified with ls)

## What Fails
- ❌ Jest tests in GitHub Actions
- ❌ Module resolution for .ts files imported with .js extension
- ❌ Same failure across Ubuntu, macOS, and Windows CI

## Key Symptoms
1. Jest cannot find TypeScript source files when imported with `.js` extensions
2. The moduleNameMapper regex `'^(\\.{1,2}/.*)\\.js$': '$1'` doesn't work in CI
3. Files definitely exist (verified with debug logging)
4. Works perfectly in local development environment

## Search Terms for Solution

### Primary Search Queries
1. "jest ts-jest Cannot find module ESM GitHub Actions"
2. "jest moduleNameMapper not working in CI TypeScript ESM"
3. "ts-jest extensionsToTreatAsEsm GitHub Actions fail"
4. "jest.config.cjs ESM TypeScript imports .js extension CI"
5. "ts-jest useESM true module resolution GitHub Actions"

### GitHub Issues to Search
1. `repo:kulshekhar/ts-jest "Cannot find module" ESM CI`
2. `repo:facebook/jest moduleNameMapper "GitHub Actions" TypeScript`
3. `repo:microsoft/TypeScript "Cannot find module" jest ESM ".js"`

### Stack Overflow Searches
1. "jest cannot resolve typescript module github actions ESM"
2. "ts-jest moduleNameMapper not working CI only"
3. "jest extensionsToTreatAsEsm working locally failing CI"

### Specific Configuration Searches
1. "jest.config.cjs vs jest.config.mjs ESM TypeScript"
2. "NODE_OPTIONS --experimental-vm-modules jest CI"
3. "ts-jest isolatedModules vs ESM module resolution"
4. "jest testEnvironment node vs jsdom ESM imports"

## Potential Root Causes to Investigate

1. **Working Directory Differences**
   - CI might run Jest from a different directory
   - Search: "jest rootDir GitHub Actions working directory"

2. **Node Module Resolution**
   - CI might have different NODE_PATH or module resolution
   - Search: "Node.js ESM module resolution GitHub Actions vs local"

3. **Jest Cache Issues**
   - Stale cache in CI causing resolution problems
   - Search: "jest --no-cache GitHub Actions ts-jest"

4. **Transform Pipeline**
   - ts-jest might not be transforming files in CI
   - Search: "ts-jest transform not working GitHub Actions"

5. **File System Case Sensitivity**
   - Linux is case-sensitive, macOS/Windows aren't by default
   - Search: "jest case sensitive imports GitHub Actions"

## Diagnostic Information Needed

1. **Jest Debug Output**
   ```bash
   NODE_OPTIONS="--experimental-vm-modules" jest --no-cache --detectOpenHandles --verbose --debug
   ```

2. **Module Resolution Trace**
   ```bash
   NODE_OPTIONS="--trace-warnings --experimental-vm-modules" jest
   ```

3. **Jest Configuration Validation**
   ```bash
   jest --showConfig
   ```

4. **Working Directory Comparison**
   - Log `process.cwd()` in both environments
   - Log `__dirname` equivalent in ESM
   - Check if `NODE_PATH` is set differently

## Similar Issues References

Search for these specific scenarios:
1. "Migrating Jest to ESM with TypeScript"
2. "ts-jest with native ESM support"
3. "Jest moduleNameMapper with TypeScript path mapping"
4. "GitHub Actions Jest different behavior than local"

## Solution Patterns to Try

Based on common solutions, search for:
1. "jest resolver custom TypeScript ESM"
2. "ts-jest pathsToModuleNameMapper"
3. "jest config testEnvironment options ESM"
4. "NODE_OPTIONS for Jest ESM in CI"
5. "jest transform ignore patterns ESM"

## Community Resources

1. **ts-jest Discord/Discussions**: Search for ESM + CI issues
2. **Jest GitHub Discussions**: ESM support category
3. **TypeScript GitHub Issues**: ESM + Jest labels
4. **Node.js GitHub**: ESM loader issues with Jest

## Keywords for AI/LLM Assistance

When asking for help, include these details:
- "Jest 29 with ts-jest in ESM mode"
- "TypeScript files imported with .js extensions"
- "moduleNameMapper not working in CI only"
- "GitHub Actions all platforms failing"
- "Files exist but Jest cannot resolve them"
- "Using jest.config.cjs with type: module"