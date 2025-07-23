# Ensemble Jest Mock Fix Guide

## Problem Summary
20 tests in EnsembleManager.test.ts are failing with:
```
TypeError: mockLogSecurityEvent.mockImplementation is not a function
```

## Root Cause
Jest's ES module support has limitations. When modules are imported, they become immutable and Jest cannot modify their exports after import.

## Current Failing Pattern
```typescript
// This doesn't work with ES modules:
jest.mock('../path/to/module.js');
const mock = Module.export as jest.Mock;
mock.mockImplementation(() => {}); // TypeError!
```

## Solution Options

### Option 1: Manual Mocks Directory (Recommended)
Create `__mocks__` directory structure:
```
src/
  security/
    __mocks__/
      securityMonitor.js
      fileLockManager.js
      SecureYamlParser.js
```

Example mock file:
```typescript
// src/security/__mocks__/securityMonitor.js
export const SecurityMonitor = {
  logSecurityEvent: jest.fn()
};
```

Then in test:
```typescript
jest.mock('../../../../../src/security/securityMonitor.js');
// No need for casting or setup
```

### Option 2: Factory Function Mocks
```typescript
jest.mock('../../../../../src/security/securityMonitor.js', () => {
  const actual = jest.requireActual('../../../../../src/security/securityMonitor.js');
  return {
    ...actual,
    SecurityMonitor: {
      logSecurityEvent: jest.fn()
    }
  };
});
```

### Option 3: Inline Mock Returns
```typescript
jest.mock('../../../../../src/security/fileLockManager.js', () => ({
  FileLockManager: {
    atomicReadFile: jest.fn().mockResolvedValue('file content'),
    atomicWriteFile: jest.fn().mockResolvedValue(undefined)
  }
}));
```

### Option 4: Use vi from Vitest
Consider migrating to Vitest which has better ES module support:
```typescript
import { vi } from 'vitest';
vi.mock('../path/to/module.js', () => ({
  Module: { method: vi.fn() }
}));
```

## Quick Fix for Current Tests

Replace the mock setup in EnsembleManager.test.ts:

```typescript
// Remove the problematic mock setup
- mockLogSecurityEvent.mockImplementation(() => {});

// Option A: Just let the mocks use default behavior
// The mocks are already created as jest.fn()

// Option B: Reset mocks instead
beforeEach(() => {
  jest.clearAllMocks();
  // Don't try to set implementations
});

// Option C: Check if it's actually a mock first
if (typeof SecurityMonitor.logSecurityEvent === 'function' && 
    'mockImplementation' in SecurityMonitor.logSecurityEvent) {
  (SecurityMonitor.logSecurityEvent as jest.Mock).mockImplementation(() => {});
}
```

## Testing Strategy
1. Start with Option 1 (__mocks__ directory) for clean separation
2. If that's too much work, try Option 3 (inline returns)
3. Consider Vitest migration for future

## Verification Steps
```bash
# Test just one file first
npm test -- test/__tests__/unit/elements/ensembles/EnsembleManager.test.ts --testNamePattern="should validate base directory"

# If that works, run all
npm test -- test/__tests__/unit/elements/ensembles/EnsembleManager.test.ts
```

## Why This Happens
- ES modules are live bindings
- Jest needs to intercept module loading
- Timing issues between mock setup and module import
- TypeScript adds another layer of complexity

## Related Issues
- Jest Issue #10025: ES Module mocking
- Node.js experimental ES module support
- TypeScript's module resolution

---
*Use this guide to fix the mock issues in the next session.*