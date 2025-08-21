# Issue #666: QA Config Integration Implementation

**Date**: August 21, 2025 Evening  
**Branch**: `feature/qa-config-integration-666`  
**Issue**: https://github.com/DollhouseMCP/mcp-server/issues/666  
**Orchestrator**: Opus 4.1  
**Agent**: CONFIG-1 (Sonnet)  

## Mission Objective

Wire up the existing `test-config.js` file to all QA scripts, replacing hardcoded timeout values with centralized configuration constants.

## Problem Statement

QA test scripts have hardcoded timeout values despite a `test-config.js` file being created with proper configuration constants. This leads to:
- Inconsistent timeout values across scripts
- Difficulty adjusting timeouts for different environments
- Code duplication and magic numbers
- Poor maintainability

## Current State

The `test-config.js` file already exists with:
```javascript
const CONFIG = {
  timeouts: {
    tool_call: 5000,           // Individual tool call timeout (5s)  
    server_connection: 10000,  // Server connection timeout (10s)
    github_operations: 15000,  // GitHub operations timeout (15s)
    benchmark_timeout: 3000,   // Performance benchmark timeout (3s)
    stress_test_timeout: 30000 // Stress test total timeout (30s)
  },
  // ... other config
}
```

But scripts still use hardcoded values like:
- `setTimeout(() => reject(...), 10000)`
- `setTimeout(() => reject(...), 5000)`
- `setTimeout(() => reject(...), 15000)`

## Solution Approach

1. **Import CONFIG** from test-config.js in each QA script
2. **Replace hardcoded values** with CONFIG constants
3. **Ensure compatibility** with the new qa-utils.js shared utilities
4. **Test that timeouts** still work correctly

## Files to Modify

### Primary Scripts
- `scripts/qa-direct-test.js` - Line 49: `10000` → `CONFIG.timeouts.server_connection`
- `scripts/qa-simple-test.js` - Check for any hardcoded timeouts
- `scripts/qa-github-integration-test.js` - Multiple timeout values
- `scripts/qa-element-test.js` - Check for timeouts
- `scripts/qa-test-runner.js` - Multiple timeout values

### Files to Import From
- `test-config.js` - Already has CONFIG object exported

## Implementation Details

### Step 1: Add Import
```javascript
import { CONFIG } from '../test-config.js';
```

### Step 2: Replace Hardcoded Values

#### Before:
```javascript
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('Tool call timed out after 10s')), 10000)
);
```

#### After:
```javascript
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error(`Tool call timed out after ${CONFIG.timeouts.server_connection/1000}s`)), CONFIG.timeouts.server_connection)
);
```

### Step 3: Update Error Messages
Include the actual timeout value in error messages for clarity:
```javascript
`Timeout after ${CONFIG.timeouts.tool_call/1000}s`
```

## Agent Instructions for CONFIG-1

### Your Mission
Replace all hardcoded timeout values in QA scripts with centralized configuration from test-config.js.

### Specific Tasks
1. **Add CONFIG import** to each QA script
2. **Find all hardcoded timeouts** (search for patterns like `5000`, `10000`, `15000`, `30000`)
3. **Replace with appropriate CONFIG values**:
   - 5000 → `CONFIG.timeouts.tool_call`
   - 10000 → `CONFIG.timeouts.server_connection`
   - 15000 → `CONFIG.timeouts.github_operations`
   - 30000 → `CONFIG.timeouts.stress_test_timeout`
4. **Update error messages** to show actual timeout values
5. **Test that scripts still work**

### Success Criteria
- ✅ All QA scripts import CONFIG from test-config.js
- ✅ No hardcoded timeout values remain (5000, 10000, 15000, etc.)
- ✅ Error messages show actual timeout values
- ✅ Scripts still function correctly
- ✅ Consistent timeout handling across all scripts

### Important Notes
- The CONFIG object is already exported from test-config.js
- Make sure import paths are correct (may need `../test-config.js`)
- Don't change the timeout values, just replace hardcoded with CONFIG
- Some scripts may already have partial CONFIG usage - complete it
- Test at least one script to ensure it works

### Search Patterns to Find Timeouts
```bash
# Find hardcoded timeouts
grep -n "5000\|10000\|15000\|30000" scripts/qa-*.js

# Find setTimeout calls
grep -n "setTimeout" scripts/qa-*.js
```

## Expected Outcome

### Before
```javascript
// Hardcoded timeout
setTimeout(() => reject(new Error('Timeout after 10s')), 10000)
```

### After  
```javascript
// Using CONFIG
import { CONFIG } from '../test-config.js';
// ...
setTimeout(() => reject(new Error(`Timeout after ${CONFIG.timeouts.server_connection/1000}s`)), CONFIG.timeouts.server_connection)
```

## Benefits
- **Maintainability**: Single source of truth for timeouts
- **Flexibility**: Easy to adjust timeouts for different environments
- **Consistency**: Same timeout values across all scripts
- **Documentation**: CONFIG object documents what each timeout is for

## Risk Mitigation

- **Risk**: Import path might be wrong
- **Mitigation**: Test import works before replacing values

- **Risk**: Some timeouts might be intentionally different
- **Mitigation**: Check context before replacing

## Definition of Done

- [ ] CONFIG imported in all QA scripts
- [ ] All hardcoded timeouts replaced
- [ ] Error messages updated to show actual values
- [ ] Scripts tested and working
- [ ] No magic numbers remain
- [ ] PR created with clear description

---

**Note for Agent CONFIG-1**: This is a straightforward refactoring task. Focus on replacing hardcoded values with CONFIG constants. Don't fix other issues you might see - keep changes minimal and focused on configuration integration only.