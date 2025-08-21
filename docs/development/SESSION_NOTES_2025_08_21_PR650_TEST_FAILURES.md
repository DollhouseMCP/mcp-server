# Session Notes - August 21, 2025 - PR #650 Test Failures Deep Dive

**Date**: August 21, 2025  
**Time**: Morning session  
**Branch**: `feature/metadata-based-test-detection`  
**PR**: #650 - Metadata-based test detection implementation  
**Status**: ❌ BLOCKED - Multiple test failures across all platforms  

## Executive Summary

PR #650 has persistent test failures across Windows, Linux, and Mac CI environments. Initial attempts to fix production environment detection have created new problems. The core issue is that test data loading is being blocked/allowed at the wrong times due to production environment detection logic conflicts.

## Test Failure Analysis

### 1. Production Environment Detection Paradox 🔴

**The Problem:**
- Added Jest detection (`JEST_WORKER_ID`) to make `isProductionEnvironment()` return `false` in tests
- This fixed some tests but broke others that specifically TEST production detection
- Now tests that validate production safety mechanisms are failing

**Affected Tests:**
```
DefaultElementProvider › Production Environment Detection › should correctly identify production environments
Expected: true
Received: false
```

**Root Cause:**
```typescript
// In DefaultElementProvider.ts
private isProductionEnvironment(): boolean {
  // Our fix - but it's too broad!
  if (typeof jest !== 'undefined' || process.env.JEST_WORKER_ID) {
    return false;  // This breaks tests that test production detection!
  }
  // ... rest of logic
}
```

### 2. Copy Element Files Count Mismatch 🔴

**The Problem:**
- `copyElementFiles` returning 3 files instead of 1
- Should block test files in production, only copy regular files
- But it's copying everything

**Test Output:**
```
Expected: 1 (only regular-element.md)
Received: 3 (copying test files too)
```

**Likely Cause:**
- Production detection returns `false` due to Jest
- So test file blocking is disabled
- All files get copied

### 3. Installation Detector Failures 🔴

**Multiple Issues:**
- Tests expect `"npm"` but get `"git"`
- Path detection broken in compiled test environment
- Mock paths not being recognized

**Test Examples:**
```
InstallationDetector › should detect npm installation when in node_modules
Expected: "npm"
Received: "git"
```

**Path Issues Found:**
```
Expected: "/usr/local/lib/node_modules/@dollhousemcp/mcp-server"
Received: null

Expected: "/home/user/projects/DollhouseMCP"  
Received: "/home/runner/work/mcp-server/mcp-server"
```

### 4. GitHub Auth Manager 🔴

**The Problem:**
- Missing GitHub CLIENT_ID
- Tests expect hardcoded fallback but it's not working

**Error:**
```
Error: GitHub OAuth client ID is not configured. 
Please set the DOLLHOUSE_GITHUB_CLIENT_ID environment variable.
```

### 5. Persona Lifecycle Tests 🔴

**The Problem:**
- No personas being loaded (expecting 2, getting 0)
- Test data not being populated

**Test Output:**
```
Persona Loading › should load personas from file system
Expected: 2
Received: 0
```

### 6. DefaultElementProvider Safety Tests 🔴

**The Problem:**
- Development mode tests failing
- Test data being loaded when it shouldn't be

**Test Output:**
```
should not load test data by default in development mode
Expected: 0 files
Received: 6 files
```

## Failed Fix Attempts

### Attempt 1: BuildInfoService Path Resolution ❌
```typescript
// Added multiple path attempts to find package.json
const possiblePaths = [
  path.join(__dirname, '..', '..', 'package.json'),
  path.join(__dirname, '..', '..', '..', 'package.json'),
  path.join(process.cwd(), 'package.json')
];
```
**Result:** Didn't fix the core issue

### Attempt 2: Add loadTestData Flag ❌
```typescript
// Added to all test files
new DefaultElementProvider({ loadTestData: true })
```
**Result:** Flag not being respected due to production detection

### Attempt 3: Jest Environment Detection ❌
```typescript
// Detect Jest to bypass production mode
if (typeof jest !== 'undefined' || process.env.JEST_WORKER_ID) {
  return false;
}
```
**Result:** Fixed some tests but broke production detection tests

## The Core Problem

The test suite has conflicting requirements:

1. **Regular Tests** need:
   - Production detection = false (to allow test data)
   - loadTestData flag respected

2. **Production Detection Tests** need:
   - Production detection = true (to test the mechanism)
   - Ability to simulate production environment

3. **Safety Tests** need:
   - Production detection = configurable
   - Test both blocking and allowing scenarios

Our current approach is all-or-nothing, which can't satisfy these conflicting needs.

## Proposed Solution for Next Session

### Option 1: Environment Variable Override
```typescript
private isProductionEnvironment(): boolean {
  // Allow tests to explicitly set production mode
  if (process.env.FORCE_PRODUCTION_MODE === 'true') {
    return true;
  }
  if (process.env.FORCE_PRODUCTION_MODE === 'false') {
    return false;
  }
  
  // Normal detection logic
  // Don't check for Jest here - let tests control via env var
}
```

### Option 2: Test-Specific Configuration
```typescript
class DefaultElementProvider {
  private testModeOverride?: boolean;
  
  // Add method for tests to control
  public setTestMode(isProduction: boolean) {
    if (process.env.NODE_ENV === 'test') {
      this.testModeOverride = isProduction;
    }
  }
  
  private isProductionEnvironment(): boolean {
    if (this.testModeOverride !== undefined) {
      return this.testModeOverride;
    }
    // Normal logic
  }
}
```

### Option 3: Separate Test Data Detection
```typescript
private shouldLoadTestData(): boolean {
  // Separate logic from production detection
  if (this.config.loadTestData) return true;
  if (process.env.JEST_WORKER_ID) return true;
  if (this.isProductionEnvironment()) return false;
  return true;
}
```

## Other Issues to Address

### 1. InstallationDetector Path Issues
- Review how paths are resolved in compiled tests
- May need to mock `process.cwd()` differently
- Check if `__dirname` behaves differently in dist/test

### 2. GitHub Auth Manager
- Either set `DOLLHOUSE_GITHUB_CLIENT_ID` in CI
- Or fix the hardcoded fallback mechanism
- Or mock the auth manager in tests

### 3. Logger Output Cleanup
- Debug messages going to console.error
- Add proper log level control in tests

## CI Environment Details

**Working Directory:** `/home/runner/work/mcp-server/mcp-server`
**Compiled Test Path:** `dist/test/test/__tests__/...`
**NODE_ENV:** Not set (defaults to undefined)
**CI:** true
**JEST_WORKER_ID:** Set by Jest

## Files Changed This Session

1. `src/services/BuildInfoService.ts` - Path resolution fixes
2. `src/portfolio/DefaultElementProvider.ts` - Production detection changes
3. Multiple test files - Added loadTestData flags

## Next Steps

1. **Revert the Jest detection change** - It's too broad
2. **Implement controlled production mode override** - Use Option 1 or 2
3. **Fix specific test files** to use the override mechanism
4. **Address InstallationDetector** path issues separately
5. **Run tests locally** with compiled approach to replicate CI

## Commands for Next Session

```bash
# Get on branch
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git checkout feature/metadata-based-test-detection

# Build and run compiled tests like CI does
npm run build:test
./node_modules/.bin/cross-env NODE_OPTIONS='--experimental-vm-modules' \
  ./node_modules/.bin/jest --config test/jest.config.compiled.cjs --ci

# Check specific failing test
npm test -- DefaultElementProvider.test.ts --no-coverage

# View PR status
gh pr view 650
gh pr checks 650
```

## Key Insight

The fundamental issue is that we're trying to use the same mechanism (`isProductionEnvironment()`) for two different purposes:
1. **Safety mechanism** - Block test data in real production
2. **Test control** - Allow tests to run without restrictions

These need to be separated or made independently controllable.

---
*Session ended due to context limit with significant unresolved issues*