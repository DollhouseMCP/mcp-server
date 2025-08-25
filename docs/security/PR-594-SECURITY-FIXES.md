# Security Fixes - PR #594

**Date**: 2025-08-12  
**Version**: 1.5.2+  
**Scope**: Security audit findings and review suggestions

## Overview

This document outlines the security improvements implemented in PR #594 to address review suggestions and security audit findings from the DollhouseMCP security assessment.

## Review Suggestions Implemented

### 1. Rate Limiting for Downloads (SecureDownloader.ts)

**Issue**: Downloads lacked rate limiting controls, potentially allowing abuse.

**Solution**: Implemented comprehensive rate limiting with two levels:
- **Global Rate Limiting**: 100 downloads per hour across all URLs
- **Per-URL Rate Limiting**: 10 downloads per hour per unique host:port combination
- **Minimum Delays**: 1 second global, 5 seconds per-URL between requests

**Implementation Details**:
```typescript
// Global rate limiter
this.globalRateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60 * 60 * 1000, // 1 hour
  minDelayMs: 1000 // 1 second between requests
});

// Per-URL rate limiters (created dynamically)
const urlLimiter = new RateLimiter({
  maxRequests: 10,
  windowMs: 60 * 60 * 1000, // 1 hour
  minDelayMs: 5000 // 5 seconds between requests to same URL
});
```

**Security Benefits**:
- Prevents DoS attacks via excessive downloads
- Protects against automated scraping attempts
- Reduces load on external services
- Comprehensive logging for security monitoring

### 2. Checksum Validation Capability (SecureDownloader.ts)

**Issue**: No integrity verification for downloaded content.

**Solution**: Added SHA-256 checksum validation for download integrity verification.

**Implementation Details**:
```typescript
interface DownloadOptions {
  // ... existing options
  /** Expected SHA-256 checksum for integrity validation */
  expectedChecksum?: string;
}

private async validateChecksum(content: string, expectedChecksum: string): Promise<void> {
  const normalizedExpected = expectedChecksum.toLowerCase().trim();
  
  // Validate checksum format (SHA-256 should be 64 hex characters)
  if (!/^[a-f0-9]{64}$/.test(normalizedExpected)) {
    throw DownloadError.validationError('Invalid checksum format');
  }

  const actualChecksum = createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
  
  if (actualChecksum !== normalizedExpected) {
    // Log security event and throw error
    SecurityMonitor.logSecurityEvent({
      type: 'CONTENT_INJECTION_ATTEMPT',
      severity: 'HIGH',
      source: 'secure_downloader',
      details: 'Checksum mismatch detected - possible content tampering'
    });
    throw DownloadError.securityError('Content checksum verification failed');
  }
}
```

**Security Benefits**:
- Detects content tampering during download
- Prevents man-in-the-middle attacks
- Ensures data integrity for critical downloads
- Automatic security event logging for failed validations

### 3. Enhanced Content-Type Validation (PersonaSharer.ts)

**Issue**: Basic Content-Type validation vulnerable to bypass attacks.

**Solution**: Implemented comprehensive MIME type validation with security checks.

**Implementation Details**:
```typescript
private validateContentType(
  contentType: string | null, 
  expectedType: string
): { isValid: boolean; error?: string } {
  
  // Check for missing Content-Type
  if (!contentType) {
    return { isValid: false, error: 'Missing Content-Type header' };
  }

  // Validate MIME type format
  const mimeTypePattern = /^[a-z0-9][a-z0-9!#$&\\-\\^_]*\\/[a-z0-9][a-z0-9!#$&\\-\\^_]*(?:\\s*;.*)?$/;
  if (!mimeTypePattern.test(contentType.toLowerCase())) {
    return { isValid: false, error: `Malformed Content-Type header: ${contentType}` };
  }

  // Block dangerous MIME types
  const dangerousMimeTypes = [
    'text/html',           // XSS risks
    'text/javascript',     // Script injection
    'application/javascript',
    'text/xml',            // XXE attacks
    'application/xml',
    'image/svg+xml',       // XSS in SVG
    'multipart/form-data', // Unexpected for API responses
    'application/x-www-form-urlencoded'
  ];

  const mainType = contentType.split(';')[0].trim().toLowerCase();
  if (dangerousMimeTypes.includes(mainType)) {
    SecurityMonitor.logSecurityEvent({
      type: 'CONTENT_INJECTION_ATTEMPT',
      severity: 'HIGH',
      source: 'persona_sharer',
      details: `Dangerous Content-Type detected: ${contentType}`
    });
    return { isValid: false, error: `Dangerous Content-Type not allowed: ${mainType}` };
  }
  
  // Additional JSON-specific validation
  // ... charset validation, acceptable JSON types, etc.
}
```

**Security Benefits**:
- Prevents Content-Type header bypass attacks
- Blocks dangerous MIME types that could enable XSS/XXE
- Validates MIME type format for malformed headers
- Comprehensive charset validation for JSON responses
- Security event logging for attack attempts

## Security Audit Findings Fixed

### DMCP-SEC-004: Unicode Normalization (MEDIUM)

**Issue**: User input processed without Unicode normalization, allowing potential bypass attacks.

**Affected File**: `src/utils/SecureDownloader.ts`

**Solution**: Added comprehensive Unicode normalization using `UnicodeValidator.normalize()`.

**Implementation**:
```typescript
private validateUrl(url: string): void {
  // ... existing validation
  
  // SECURITY FIX: DMCP-SEC-004 - Unicode normalization on user input
  const unicodeValidation = UnicodeValidator.normalize(url);
  const normalizedUrl = unicodeValidation.normalizedContent;
  
  if (!unicodeValidation.isValid) {
    SecurityMonitor.logSecurityEvent({
      type: 'UNICODE_VALIDATION_ERROR',
      severity: 'MEDIUM',
      source: 'secure_downloader',
      details: `URL contains suspicious Unicode patterns: ${unicodeValidation.detectedIssues?.join(', ')}`,
      metadata: { originalUrl: url, normalizedUrl }
    });
  }
  
  // Use normalized URL for further validation
  url = normalizedUrl;
  // ... continue with validation
}
```

**Security Benefits**:
- Prevents Unicode-based bypass attacks (homograph, direction override, etc.)
- Normalizes confusable characters to ASCII equivalents
- Removes zero-width and non-printable characters
- Detects and logs suspicious Unicode patterns

### DMCP-SEC-006: Security Audit Logging (LOW)

**Issue**: Security operations performed without comprehensive audit logging.

**Affected File**: `src/portfolio/MigrationManager.ts`

**Solution**: Added comprehensive `SecurityMonitor.logSecurityEvent()` calls throughout migration operations.

**Implementation Examples**:
```typescript
// Migration start
SecurityMonitor.logSecurityEvent({
  type: 'PORTFOLIO_INITIALIZATION',
  severity: 'LOW',
  source: 'migration_manager',
  details: 'Starting migration from legacy personas to portfolio structure',
  metadata: { backup: !!options?.backup }
});

// File operations
SecurityMonitor.logSecurityEvent({
  type: 'FILE_COPIED',
  severity: 'LOW',
  source: 'migration_manager',
  details: `Persona file migrated with security validation: ${normalizedFilename}`,
  metadata: { 
    originalFilename: filename,
    normalizedFilename,
    sourcePath: legacyPath,
    destinationPath: newPath,
    contentLength: validatedContent.length,
    unicodeNormalized: normalizedFilename !== filename,
    unicodeIssues: !contentValidation.isValid
  }
});

// Unicode issues
SecurityMonitor.logSecurityEvent({
  type: 'UNICODE_VALIDATION_ERROR',
  severity: 'MEDIUM',
  source: 'migration_manager',
  details: `Unicode issues detected in filename during migration: ${filenameValidation.detectedIssues?.join(', ')}`,
  metadata: { 
    originalFilename: filename,
    normalizedFilename,
    detectedIssues: filenameValidation.detectedIssues
  }
});
```

**Security Benefits**:
- Comprehensive audit trail for all migration operations
- Detailed logging of Unicode normalization issues
- File operation tracking with metadata
- Migration success/failure event logging
- Backup operation audit trail

## Security Event Types Added

The following new security event types were introduced:

- `UNICODE_VALIDATION_ERROR`: Unicode normalization issues
- `CONTENT_INJECTION_ATTEMPT`: Dangerous content/MIME types detected
- `RATE_LIMIT_EXCEEDED`: Download rate limits exceeded
- `PORTFOLIO_INITIALIZATION`: Migration process started
- `PORTFOLIO_POPULATED`: Migration completed successfully
- `DIRECTORY_MIGRATION`: Migration failure events
- `FILE_COPIED`: File operations during migration

## Testing

All security fixes include comprehensive test coverage:

- **Rate Limiting**: Tests for global and per-URL limits, proper error handling
- **Checksum Validation**: Format validation, mismatch detection, security logging
- **Content-Type Validation**: Dangerous MIME type blocking, format validation
- **Unicode Normalization**: Confusable character detection and normalization
- **Audit Logging**: Event generation and metadata verification

## Configuration

### Rate Limiting Configuration

```typescript
const downloader = new SecureDownloader({
  rateLimitOptions: {
    maxRequestsPerUrl: 10,      // Per-URL limit
    maxGlobalRequests: 100,     // Global limit
    windowMs: 60 * 60 * 1000    // 1 hour window
  }
});
```

### Checksum Validation Usage

```typescript
await downloader.downloadToFile(
  'https://example.com/file.json',
  './local/file.json',
  {
    expectedChecksum: 'a1b2c3...', // SHA-256 hash
    expectedContentType: 'application/json'
  }
);
```

## Compatibility

All changes are backward compatible:
- New options are optional parameters
- Existing API surface unchanged
- Default behavior maintains existing functionality
- Enhanced security is transparent to existing code

## Performance Impact

- **Rate Limiting**: Minimal overhead, uses in-memory token bucket
- **Checksum Validation**: Only computed when `expectedChecksum` provided
- **Content-Type Validation**: Lightweight regex and string operations
- **Unicode Normalization**: Uses optimized native normalization
- **Audit Logging**: Asynchronous, non-blocking event generation

## Monitoring

Security events can be monitored via:

```typescript
// Get recent security events
const events = SecurityMonitor.getRecentEvents(100);

// Get events by severity
const criticalEvents = SecurityMonitor.getEventsBySeverity('CRITICAL');

// Generate security report
const report = SecurityMonitor.generateSecurityReport();
```

## Conclusion

These security fixes significantly enhance the security posture of DollhouseMCP by:

1. **Preventing Abuse**: Rate limiting protects against DoS and scraping
2. **Ensuring Integrity**: Checksum validation detects tampering
3. **Blocking Attacks**: Enhanced Content-Type validation prevents injection
4. **Normalizing Input**: Unicode normalization prevents bypass attacks
5. **Enabling Monitoring**: Comprehensive audit logging for security analysis

All fixes follow defense-in-depth principles with multiple layers of validation, proper error handling, and comprehensive logging for security monitoring.