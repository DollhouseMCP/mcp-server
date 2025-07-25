# Quick Fix Guide for Security PR #209

## Immediate CI Fix (First Priority)
The CI is failing on all platforms. To debug:
```bash
# View specific failure logs
gh run view --log-failed

# Common issues to check:
# 1. Missing imports in new files
# 2. TypeScript compilation errors
# 3. File path issues with new security modules
```

## Critical Fixes from Review

### 1. Fix CommandValidator Integration
**Current Problem**: We created CommandValidator but git.ts still has its own implementation

**Quick Fix**:
```typescript
// In src/utils/git.ts, replace the current safeExec with:
import { CommandValidator } from './security/commandValidator.js';

export async function safeExec(
  command: string, 
  args: string[], 
  options: { cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  const result = await CommandValidator.secureExec(command, args, {
    cwd: options.cwd,
    timeout: 30000
  });
  
  return { stdout: result, stderr: '' };
}
```

### 2. Standardize Validation Patterns
**Current Problem**: Different regex in different files

**Quick Fix**: Use this pattern everywhere:
```typescript
// Allow alphanumeric, dash, underscore, dot, and forward slash
const SAFE_ARG_PATTERN = /^[a-zA-Z0-9\-_.\/]+$/;
```

### 3. Implement Timeout Handling
**In CommandValidator.secureExec()**, add after line 40:
```typescript
// Handle timeout
if (options?.timeout) {
  setTimeout(() => {
    proc.kill('SIGTERM');
    reject(new Error(`Command timed out after ${options.timeout}ms`));
  }, options.timeout).unref();
}
```

## Test Commands
```bash
# After fixes, test locally:
npm run build
npm run security:rapid
npm test

# Check specific test file compilation:
npx tsc --noEmit src/security/commandValidator.ts
```

## PR #209 Key Facts
- Fixes Issues: #199, #200, #201, #203
- 28 new security tests
- Review score: 8.5/10
- Branch: security-implementation

## If CI Still Fails
Check these common issues:
1. Import paths - use `.js` extensions
2. Export statements in index files
3. TypeScript config includes new directories
4. All new files have proper imports

Remember: The security implementation is good, we just need to fix the integration issues!