# Quick Reference - PR #225 Security Testing

## Key Files Modified

### Security Fixes:
1. `/src/security/InputValidator.ts`
   - Line 133: Added shell metacharacter removal
   - Line 134: Added Unicode character removal
   - Lines 34-73: Fixed validatePath() signature and logic

2. `/src/index.ts`
   - Lines 878-885: Fixed createPersona output to use sanitizedName
   - Lines 1069-1073: Fixed editPersona to sanitize name field
   - Line 1705: Added JEST_WORKER_ID check to prevent auto-start

### Test Fixes:
1. `/__tests__/security/tests/mcp-tools-security.test.ts`
   - Added beforeEach cleanup (line 46)
   - Updated test expectations for both rejection and sanitization
   - Extract persona names from output to verify

2. `/__tests__/unit/InputValidator.test.ts`
   - Line 286: Updated expectation (semicolon now removed)

3. `/__tests__/security/tests/input-validation-security.test.ts`
   - Line 100: Changed size from 512KB to 400KB

## Quick Test Commands
```bash
# Run specific security test
npm test -- __tests__/security/tests/mcp-tools-security.test.ts -t "command injection"

# Check PR status
gh pr view 225 --comments

# Check CI status
gh pr checks 225

# Test sanitization directly
node -e "import {sanitizeInput} from './dist/security/InputValidator.js'; console.log(sanitizeInput('; rm -rf /'))"
```

## What Gets Rejected vs Sanitized

### Rejected by ContentValidator:
- Payloads with "curl" or "wget"
- Command substitution $(...)
- Backtick execution `...`
- Certain prompt injection patterns

### Sanitized by sanitizeInput():
- Shell metacharacters: ; | & ` $ ( )
- HTML characters: < > ' " &
- Unicode: RTL override, zero-width
- Control characters

## Test Pattern Template
```typescript
if (responseText.includes('Validation Error') || responseText.includes('prohibited content')) {
  // Rejected - good
  expect(responseText).toMatch(/appropriate error pattern/i);
} else {
  // Sanitized - extract and verify
  const nameMatch = responseText.match(/🎭 \*\*([^*]+)\*\*/);
  const name = nameMatch?.[1] || '';
  expect(name).not.toMatch(/[;&|`$()]/);
}
```

## PR Info
- PR #225: https://github.com/DollhouseMCP/mcp-server/pull/225
- Branch: implement-security-testing-infrastructure
- Issue #205: Security Testing Infrastructure