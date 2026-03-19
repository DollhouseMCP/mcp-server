# Security Testing Quick Start

## For Developers

### Before Committing Code (MANDATORY)
**Run the full pre-commit workflow:**

```bash
# 1. Security & Dependencies (Critical - Run First)
npm run pre-commit        # Includes security:rapid + dependency audit

# 2. Code Style
npm run lint              # ESLint validation

# 3. Build Validation
npm run build             # TypeScript compilation

# 4. Test Suite
npm test                  # Unit tests
```

**Quick command:** `npm run pre-commit && npm run lint && npm run build && npm test`

All checks must pass with zero failures.

### After Adding a New MCP Tool
```bash
# Generate security test template
npm run security:generate -- your-tool-name

# Edit the generated test file
code tests/security/tests/your-tool-name-security.test.ts

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

| Command | Purpose | Duration | When to Use |
|---------|---------|----------|-------------|
| `npm run pre-commit` | Pre-commit check (includes security:rapid) | ~2-4s | **Every commit (MANDATORY)** |
| `npm run security:rapid` | Critical security tests only | ~2-4s | Part of pre-commit workflow |
| `npm run security:all` | Full security suite with coverage | ~90s | Security-sensitive code changes |
| `npm run security:audit` | Custom security auditor | ~0.5s | Security analysis |
| `npm run security:audit:verbose` | Detailed security audit report | ~0.5s | Before PR or release |

## Getting Help

- Security test failures: See [Testing Guide](testing.md)
- Framework issues: See `tests/security/framework/`
- Add new tests: Use `npm run security:generate`
- Security questions: Create issue with `security` label
