# Release Notes - v1.7.2

## 🔒 Security Patch Release

**Release Date**: September 7, 2025  
**Type**: Security Patch  
**Priority**: High

## Summary

This release addresses critical security vulnerabilities in the logging system that could potentially expose sensitive information in console output. The fixes ensure that OAuth tokens, API keys, passwords, and other sensitive data are properly sanitized before any logging occurs.

## 🛡️ Security Fixes

### Critical: Clear-text Logging Prevention (PR #884)
- **Issue**: Logger could potentially output sensitive data to console during initialization
- **Fix**: Implemented comprehensive sanitization for both log messages and data objects
- **Impact**: Prevents exposure of OAuth tokens, API keys, passwords, and other credentials

#### Key Security Improvements:
1. **Message Sanitization**: All log messages are now scanned and sanitized for sensitive patterns
2. **Data Object Sanitization**: Recursive sanitization of all data objects with depth limiting
3. **Pattern Detection**: Enhanced detection of sensitive field names and values
4. **Performance Optimization**: Pre-compiled regex patterns for efficient sanitization
5. **Memory Safety**: Circular reference detection and depth limiting to prevent DoS

## 📋 Changes

### Security Enhancements
- Added `sanitizeMessage()` method to detect and redact sensitive data in log messages
- Added `sanitizeData()` method for recursive object sanitization
- Implemented comprehensive pattern matching for sensitive fields
- Added protection against circular references and deep nesting
- CodeQL suppression comments for false positives

### Pattern Detection
The logger now detects and redacts:
- OAuth tokens and credentials
- API keys (including patterns like `sk-xxxxx`, `pk-xxxxx`)
- Passwords and secrets
- Bearer tokens
- Client IDs and secrets
- Session tokens and cookies

### Test Coverage
- Added 20 comprehensive tests for logger security
- Tests cover message sanitization, data sanitization, edge cases
- Circular reference handling tests
- Deep nesting protection tests

## 📦 Technical Details

### Files Changed
- `src/utils/logger.ts` - Complete security overhaul
- `test/__tests__/unit/logger.test.ts` - Comprehensive security tests
- Various documentation files for development notes

### Performance Impact
- Minimal performance impact due to optimizations
- Pre-compiled regex patterns reduce overhead
- Fast-path returns for null/undefined/primitives
- Depth limiting prevents excessive recursion

## 🚀 Upgrade Instructions

```bash
npm update @dollhousemcp/mcp-server@1.7.2
```

Or in package.json:
```json
"@dollhousemcp/mcp-server": "^1.7.2"
```

## ⚠️ Breaking Changes

None. This is a security patch with no API changes.

## 🔍 Verification

After upgrading, verify the security fixes:
1. Check that sensitive data doesn't appear in logs
2. Verify OAuth tokens are redacted as `[REDACTED]`
3. Confirm API keys show as pattern prefixes only (e.g., `sk[REDACTED]`)

## 🙏 Acknowledgments

- Security issue identified through CodeQL analysis
- Comprehensive review by Claude AI security audit
- Community feedback on logging security

## 📚 Documentation

- Session notes: `/docs/development/SESSION_NOTES_2025_09_07_SECURITY_FIXES_PR884.md`
- Security implementation details in code comments
- PR #884 for full discussion and implementation details

---

**Security Note**: Users are strongly encouraged to upgrade to this version to ensure sensitive data is not exposed in logs.