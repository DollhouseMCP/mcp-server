# Security Testing Quick Start

## For Developers

### Before Committing Code
```bash
npm run security:rapid
```
This runs critical security tests in <30 seconds.

### After Adding a New MCP Tool
```bash
# Generate security test template
npm run security:generate -- your-tool-name

# Edit the generated test file
code __tests__/security/tests/your-tool-name-security.test.ts

# Run tests
npm run security:all
```

### Testing Specific Vulnerabilities

#### Command Injection
```typescript
// Your code should reject these:
const badInputs = ['; rm -rf /', '&& malicious-command'];
```

#### Path Traversal
```typescript
// Your code should block these:
const badPaths = ['../../../etc/passwd', '..\\windows\\system32'];
```

#### Size Limits
```typescript
// Your code should enforce limits:
const largeInput = 'x'.repeat(1024 * 1024); // 1MB
```

## Common Security Fixes

### Sanitizing User Input
```typescript
import { sanitizeInput } from './security/InputValidator.js';

const safe = sanitizeInput(userInput);
```

### Validating File Paths
```typescript
import { validatePath } from './security/InputValidator.js';

if (!validatePath(filePath, allowedDir)) {
  throw new Error('Invalid path');
}
```

### Rate Limiting
```typescript
import { RateLimiter } from './security/RateLimiter.js';

const limiter = new RateLimiter(10, 60000); // 10 per minute
if (!limiter.checkLimit(userId)) {
  throw new Error('Rate limit exceeded');
}
```

## CI/CD Failures

If security tests fail in CI:

1. **Check the error message** - It will show which payload bypassed security
2. **Fix the vulnerability** - Don't just block the specific payload
3. **Add regression test** - Ensure it never happens again
4. **Re-run locally** - `npm run security:all`

## Emergency Security Fix Process

1. Create hotfix branch: `git checkout -b security-hotfix-XXX`
2. Fix the vulnerability
3. Run security tests: `npm run security:all`
4. Create PR with `SECURITY:` prefix
5. Get expedited review
6. Deploy immediately

## Security Test Commands

| Command | Purpose | Duration |
|---------|---------|----------|
| `npm run security:rapid` | Pre-commit check | <30s |
| `npm run security:critical` | Critical vulns only | <30s |
| `npm run security:all` | Full security suite | <2min |
| `npm run security:report` | Generate report | <2min |

## Getting Help

- Security test failures: Check `docs/security/SECURITY_TESTING.md`
- Framework issues: See `__tests__/security/framework/`
- Add new tests: Use `npm run security:generate`
- Security questions: Create issue with `security` label