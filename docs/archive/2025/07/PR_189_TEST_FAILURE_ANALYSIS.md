# PR #189 Test Failure Analysis

## Root Cause
Tests are failing because logger is outputting to console even with `NODE_ENV !== 'test'` check.

## Why This Matters
- Jest captures console output and shows it as warnings
- Some tests may explicitly check that no console output occurs
- MCP protocol requires ZERO non-JSON output

## Specific Failing Tests (from logs)
1. `__tests__/security/secureYamlParser.test.ts` - Security alerts logging
2. `__tests__/unit/auto-update/SignatureVerifier.test.ts` - GPG import errors
3. Multiple tests showing console.error output from logger

## Most Likely Fix
The logger module is being imported and instantiated BEFORE Jest sets NODE_ENV=test.

### Solution: Lazy check in logger
```typescript
// Instead of checking NODE_ENV once at module load:
class MCPLogger {
  private log(level: LogEntry['level'], message: string, data?: any): void {
    // Check NODE_ENV every time, not just at initialization
    const isTest = process.env.NODE_ENV === 'test';
    
    // ... rest of method
    
    if (!this.isMCPConnected && !isTest) {
      // console output code
    }
  }
}
```

## Alternative: Mock Logger in Jest Setup
Create `jest.setup.js`:
```javascript
// Mock the logger module globally
jest.mock('./src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    setMCPConnected: jest.fn(),
    getLogs: jest.fn(() => []),
    clearLogs: jest.fn()
  }
}));
```

Add to `jest.config.cjs`:
```javascript
module.exports = {
  // ... existing config
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
```

## Quick Test Command
```bash
# Test just one failing suite to verify fix
npm test -- --no-coverage --testPathPattern="secureYamlParser" --verbose
```

## Note on Review Feedback
ClaudeBot suggested:
- Add unit tests for logger (can do after fixing current tests)
- Add log level configuration (future enhancement)
- These are non-blocking for current PR