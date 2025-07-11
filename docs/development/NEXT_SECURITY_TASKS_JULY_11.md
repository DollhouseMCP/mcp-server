# Next Security Tasks - July 11, 2025

## Immediate Priority (Next Session)

### 1. Verify CodeQL Status (#210) 🔴
```bash
# Check if CodeQL passes on main after merge
gh api repos/DollhouseMCP/mcp-server/code-scanning/alerts?state=open

# Check latest CodeQL run
gh run list --branch main --workflow "CodeQL" --limit 1
```

### 2. File Locking Implementation (#204) 🟡
**Prevent race conditions in file operations**
- Use file locking for concurrent access
- Implement retry logic with backoff
- Test with concurrent operations
- Location: PathValidator enhancements

### 3. Token Security Management (#202) 🟡
**Secure storage and handling of tokens**
- Never log tokens
- Secure environment variable handling
- Token rotation support
- Masked output in logs

## Remaining Security Issues

### High Priority
1. **#204 - File Locking/Race Conditions**
   - Atomic operations for all file writes
   - Lock files during read-modify-write
   - Prevent TOCTOU vulnerabilities

2. **#202 - Token Security**
   - Secure token storage
   - Environment variable protection
   - Token lifecycle management

### Medium Priority
3. **#207 - Rate Limiting**
   - Already have RateLimiter class
   - Need to apply to all endpoints
   - Configure limits appropriately

4. **#206 - Error Handling/Info Disclosure**
   - Sanitize error messages
   - Remove stack traces in production
   - Log security events properly

5. **#208 - Session Management**
   - Session token security
   - Session timeout
   - Secure session storage

### Follow-up from PR #209
6. **#211 - Integration Tests** (MEDIUM)
7. **#215 - PathValidator Race Condition** (MEDIUM)
8. **#212 - Performance Monitoring** (LOW)
9. **#213 - Validation Caching** (LOW)
10. **#214 - Security Metrics** (LOW)

## Quick Implementation Templates

### File Locking Template
```typescript
import { lock } from 'proper-lockfile';

async safeWriteFileWithLock(path: string, content: string) {
  const release = await lock(path, { retries: 3 });
  try {
    await fs.writeFile(path, content);
  } finally {
    await release();
  }
}
```

### Token Security Template
```typescript
class TokenManager {
  private static maskToken(token: string): string {
    if (token.length <= 8) return '***';
    return token.substring(0, 4) + '***' + token.substring(token.length - 4);
  }
  
  static logSafely(message: string, token?: string) {
    if (token) {
      message = message.replace(token, this.maskToken(token));
    }
    logger.info(message);
  }
}
```

## Testing Checklist
- [ ] All security tests still pass
- [ ] No new CodeQL alerts
- [ ] Performance acceptable
- [ ] Error messages sanitized
- [ ] Tokens never logged

## Reference Files
- `/docs/development/SECURITY_IMPLEMENTATION_COMPLETE_JULY_11.md`
- `/src/security/*` - All security validators
- `/__tests__/security/*` - Security test suite

## Branch Status
- PR #209 merged to main
- Branch `security-implementation` can be deleted
- All work now on main or new feature branches