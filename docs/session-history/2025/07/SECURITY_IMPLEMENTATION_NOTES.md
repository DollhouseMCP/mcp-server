# Security Implementation Technical Notes

## Important Patterns and Lessons Learned

### 1. RegexValidator Pattern
The RegexValidator implementation is a good template for future security validators:
```typescript
// Pattern: Analyze first, then validate with limits
const analysis = this.analyzePattern(pattern);
if (!analysis.safe && rejectDangerousPatterns) {
  throw new SecurityError(...);
}
// Use analysis results for smart limits
const effectiveMaxLength = maxLength ?? analysis.maxSafeLength;
```

### 2. Security Event Types
When logging security events, use existing types from SecurityMonitor:
- `CONTENT_INJECTION_ATTEMPT` - For content-based threats
- `YAML_INJECTION_ATTEMPT` - For YAML-specific issues
- `UPDATE_SECURITY_VIOLATION` - For update/modification attempts
- `PATH_TRAVERSAL_ATTEMPT` - For path-based attacks
- `RATE_LIMIT_EXCEEDED` - For rate limiting

**Note**: Don't create new types without updating the union type in securityMonitor.ts!

### 3. Validation Error Patterns
Current inconsistency (Issue #244) but general pattern:
```typescript
throw new Error(
  `Content exceeds maximum length of ${limit} characters (${actual} provided)`
);
```

### 4. Test File Locations
- Unit tests: `__tests__/unit/security/`
- Integration tests: `__tests__/security/`
- Test file naming: `<feature>.test.ts` or `<feature>Validation.test.ts`

### 5. Import Path Gotchas
- Always use `.js` extension in imports (ESM requirement)
- SecurityError is in `./errors.js` not `../errors/SecurityError.js`
- Use relative imports within security directory

## Key Infrastructure Already in Place

### 1. RateLimiter (for Issue #174)
```typescript
// Already exists in src/security/RateLimiter.ts
export class RateLimiter {
  static createForTokenValidation(options?: RateLimiterOptions)
  tryConsume(): boolean
}
```

### 2. Security Constants
All limits are centralized in `src/security/constants.ts`:
- Content limits (MAX_CONTENT_LENGTH, MAX_YAML_LENGTH, etc.)
- Rate limits (RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS)
- Validation patterns (SAFE_FILENAME, SAFE_EMAIL, etc.)

### 3. ContentValidator Patterns
INJECTION_PATTERNS and MALICIOUS_YAML_PATTERNS arrays are the place to add new detection patterns.

## Performance Considerations

### 1. Length Checks First
Always check length before regex operations:
```typescript
if (content.length > limit) {
  throw new Error(...);
}
// Only then do pattern matching
```

### 2. Pattern Complexity
RegexValidator assigns complexity based on quantifier count:
- 0 quantifiers = low (100KB limit)
- 1-3 quantifiers = medium (10KB limit)
- 4+ or dangerous patterns = high (1KB limit)

### 3. Trusted Patterns
When using RegexValidator with our own security patterns:
```typescript
RegexValidator.validate(content, pattern, {
  rejectDangerousPatterns: false,  // Don't reject our own patterns
  logEvents: false  // Don't log our patterns as dangerous
})
```

## Testing Patterns

### 1. Performance Tests
```typescript
const start = performance.now();
// operation
const elapsed = performance.now() - start;
expect(elapsed).toBeLessThan(10);
```

### 2. Error Message Testing
```typescript
// For exact message match
expect(() => operation()).toThrow('Exact message');

// For pattern match
expect(() => operation()).toThrow(/pattern/);
```

### 3. Multi-byte Character Testing
```typescript
const emojis = '🎭'.repeat(100); // Each emoji is 4 bytes
validateContentSize(emojis, 500); // Should pass (400 bytes)
```

## Common CI Issues

### 1. TypeScript Compilation
- Check all SecurityEvent types exist
- Ensure imports have .js extension
- Verify all types are properly imported

### 2. Test Failures
- Docker tests sometimes fail for unrelated reasons
- Check error messages match exactly (Jest is strict)
- Remember Jest runs in Node, not browser environment

## Next Session Quick Start Commands

```bash
# Check current security issues
gh issue list --label "area: security" --state open

# Run security-specific tests
npm test -- __tests__/security/

# Check for any security alerts
gh api repos/DollhouseMCP/mcp-server/code-scanning/alerts --jq '.[].rule.description'

# Quick build check
npm run build
```

## Architecture Notes

### Security Layer Structure
1. **Input Validation** (InputValidator, pathValidator)
2. **Content Security** (ContentValidator, yamlValidator)
3. **Pattern Detection** (RegexValidator, malicious patterns)
4. **Rate Limiting** (RateLimiter - needs integration)
5. **Monitoring** (SecurityMonitor - logs all events)

### Validation Flow
1. Length validation (fail fast)
2. Basic format validation
3. Security pattern detection
4. Business logic validation
5. Sanitization (if needed)

## Future Considerations

### 1. Configuration System
Consider making limits configurable via environment variables:
```typescript
MAX_CONTENT_LENGTH: process.env.DOLLHOUSE_MAX_CONTENT_LENGTH || 500000
```

### 2. Security Metrics
Track and report on:
- Most common rejection reasons
- Attack patterns over time
- Performance impact of validations

### 3. A/B Testing Limits
Consider framework for testing different limits to find optimal values.

## Remember
- All critical security issues are complete
- Focus on quick wins in remaining issues
- Test everything - security code must be bulletproof
- Document security decisions for future maintainers