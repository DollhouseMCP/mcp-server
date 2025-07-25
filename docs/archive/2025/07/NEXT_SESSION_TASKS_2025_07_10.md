# Next Session Tasks - MCP Console Output Fix

## Immediate Priority: Fix PR #189 Test Failures

### 1. Check Current Test Status
```bash
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP
git checkout fix-mcp-console-output
gh pr checks 189
```

### 2. Debug Test Failures
The tests are still outputting to console despite NODE_ENV check. Potential issues:

#### Option A: Logger imported before NODE_ENV set
Check if jest.config.js sets NODE_ENV:
```javascript
// jest.config.cjs should have:
testEnvironment: 'node',
testEnvironmentOptions: {
  NODE_ENV: 'test'
}
```

#### Option B: Mock the logger in tests
Create `__tests__/setup.ts`:
```typescript
jest.mock('../src/utils/logger', () => ({
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

#### Option C: Silent logger for tests
Modify logger.ts to check earlier:
```typescript
// At top of logger.ts
const isTest = process.env.NODE_ENV === 'test';

class MCPLogger {
  private log(level: LogEntry['level'], message: string, data?: any): void {
    if (isTest) return; // Exit early for tests
    // ... rest of implementation
  }
}
```

### 3. Test Locally
```bash
npm test -- --no-coverage --testPathPattern="secureYamlParser"
```

### 4. Once Tests Pass
1. Commit and push fixes
2. Wait for CI to pass
3. Merge PR #189
4. Create v1.2.4 release

## Release v1.2.4 Checklist

### 1. Merge to main
```bash
gh pr merge 189 --merge
git checkout main
git pull
```

### 2. Update version
```bash
npm version patch  # Updates to 1.2.4
```

### 3. Create release
```bash
git push origin main --tags
gh release create v1.2.4 --title "v1.2.4 - MCP Protocol Compatibility Fix" --notes "..."
```

### 4. Update Production
Tell user to run in their production directory:
```bash
cd /Applications/MCP-Servers/DollhouseMCP/mcp-server
git pull origin main
npm install
npm run build
```

## Summary of Issues Fixed in v1.2.4
1. ✅ Path resolution (from v1.2.3) - personas directory created in correct location
2. 🔄 Console output breaking MCP protocol - pending test fixes

## Review Feedback Summary
From ClaudeBot review on PR #189:
- ✅ Architecture is good
- ✅ Fixed logger.error → logger.debug for non-errors
- ⚠️ Missing: Unit tests for logger
- ⚠️ Missing: Log level configuration
- 💡 Future: Add structured metadata, configurable buffer size

## Key Commands for Reference
```bash
# Check PR status
gh pr view 189 --comments

# Check test output
gh run view <run-id> --log | grep -A10 -B10 "error"

# Run specific test
npm test -- --testNamePattern="secure"

# Build project
npm run build
```