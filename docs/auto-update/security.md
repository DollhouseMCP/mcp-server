# Auto-Update Security Guide

## Overview

The DollhouseMCP auto-update system implements multiple layers of security to protect against various attack vectors. This guide details the security measures, best practices, and configuration options for secure updates.

## Security Architecture

### Defense in Depth

The system implements a multi-layered security approach:

1. **Input Validation** - All user inputs are validated and sanitized
2. **API Security** - Rate limiting and timeout controls
3. **Download Security** - HTTPS-only downloads with optional signatures
4. **Execution Security** - Safe command execution without shell interpretation
5. **File System Security** - Path validation and production protection

## Threat Model

### Identified Threats

1. **Remote Code Execution (RCE)**
   - Command injection through user inputs
   - Malicious code in updates
   - Path traversal attacks

2. **Cross-Site Scripting (XSS)**
   - Malicious content in release notes
   - User-generated content injection

3. **Denial of Service (DoS)**
   - API rate limit exhaustion
   - Resource exhaustion attacks
   - Infinite update loops

4. **Man-in-the-Middle (MITM)**
   - Update package tampering
   - Malicious redirect attacks
   - DNS hijacking

5. **Supply Chain Attacks**
   - Compromised dependencies
   - Malicious npm packages
   - Backdoored updates

## Security Features

### 1. Input Sanitization

All user inputs are sanitized using multiple techniques:

```typescript
// DOMPurify for XSS prevention
const clean = DOMPurify.sanitize(input, {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  KEEP_CONTENT: true
});

// Command injection prevention
const sanitized = input.replace(/[;&|`$()]/g, '');

// Path traversal prevention
const safePath = path.normalize(input).replace(/^(\.\.(\/|\\|$))+/, '');
```

### 2. Secure Command Execution

Commands are executed using `spawn()` instead of `exec()`:

```typescript
// Safe execution - no shell interpretation
const { spawn } = require('child_process');
const result = spawn('git', ['pull'], {
  cwd: projectDir,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
});

// Never use:
// exec(`git pull ${branch}`)  // Vulnerable to injection
```

### 3. Rate Limiting

Token bucket algorithm prevents API abuse:

- **Default Limit**: 10 requests per minute
- **Burst Capacity**: 5 requests
- **Per-endpoint limits**: Different limits for different operations
- **Graceful degradation**: Queues requests when limited

### 4. GPG Signature Verification

Optional but recommended for production:

```bash
# Enable signature verification
export DOLLHOUSE_SKIP_SIGNATURE=false

# Import trusted keys
gpg --keyserver keyserver.ubuntu.com --recv-keys ABC123DEF456

# Verification happens automatically during updates
```

### 5. URL Validation

Strict whitelist approach for external URLs:

```typescript
const allowedHosts = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com'
];

function isValidUrl(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && 
         allowedHosts.includes(parsed.hostname);
}
```

### 6. Secure File Operations

Protection against directory traversal and production corruption:

```typescript
// Path validation
if (filePath.includes('..') || !filePath.startsWith(rootDir)) {
  throw new Error('Invalid file path');
}

// Production detection
if (isProductionEnvironment() && !userConfirmed) {
  throw new Error('Production environment protection');
}
```

## Configuration for Security

### Recommended Production Settings

```bash
# Enable all security features
export DOLLHOUSE_SKIP_SIGNATURE=false
export DOLLHOUSE_VERIFY_CHECKSUMS=true
export DOLLHOUSE_STRICT_SSL=true
export DOLLHOUSE_DISABLE_SHELL_HOOKS=true

# Restrict update sources
export DOLLHOUSE_ALLOWED_SOURCES=github.com
export DOLLHOUSE_UPDATE_CHANNEL=stable

# Enhanced logging
export DOLLHOUSE_SECURITY_LOG=/var/log/dollhouse-security.log
export DOLLHOUSE_AUDIT_UPDATES=true
```

### Security Headers

When running behind a proxy, ensure these headers:

```
Content-Security-Policy: default-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000
```

## Best Practices

### 1. Regular Security Updates

```bash
# Check for security updates
npm audit

# Update dependencies
npm update

# Review security advisories
gh api /repos/mickdarling/DollhouseMCP/security-advisories
```

### 2. Secure Deployment

1. **Use a dedicated user** for running DollhouseMCP
2. **Limit file permissions** to minimum required
3. **Enable signature verification** in production
4. **Monitor update logs** for suspicious activity
5. **Implement network segmentation** for update traffic

### 3. Incident Response

If you suspect a security incident:

1. **Disable updates immediately**
   ```bash
   export DOLLHOUSE_DISABLE_UPDATES=true
   ```

2. **Check recent updates**
   ```bash
   ls -la .backup-*
   cat update.log
   ```

3. **Rollback if needed**
   ```
   rollback_update true
   ```

4. **Report the incident**
   - Email: security@dollhousemcp.com
   - GitHub Security: https://github.com/mickdarling/DollhouseMCP/security

## Security Checklist

### Pre-deployment

- [ ] Enable signature verification
- [ ] Configure trusted signers
- [ ] Set up security logging
- [ ] Review firewall rules
- [ ] Test rollback procedures

### Operational

- [ ] Monitor security logs regularly
- [ ] Keep dependencies updated
- [ ] Review update release notes
- [ ] Verify update signatures
- [ ] Test in staging first

### Post-update

- [ ] Verify update integrity
- [ ] Check application functionality
- [ ] Review security logs
- [ ] Monitor for anomalies
- [ ] Update documentation

## Common Vulnerabilities

### 1. Command Injection

**Vulnerable:**
```javascript
exec(`git checkout ${userInput}`);  // DON'T DO THIS
```

**Secure:**
```javascript
spawn('git', ['checkout', sanitizedInput]);  // Safe
```

### 2. Path Traversal

**Vulnerable:**
```javascript
const backup = `${userPath}/backup`;  // DON'T DO THIS
```

**Secure:**
```javascript
const backup = path.join(rootDir, path.basename(userPath), 'backup');
```

### 3. SSRF (Server-Side Request Forgery)

**Vulnerable:**
```javascript
fetch(userProvidedUrl);  // DON'T DO THIS
```

**Secure:**
```javascript
if (isValidGitHubUrl(url)) {
  fetch(url);
}
```

## Reporting Security Issues

### Responsible Disclosure

1. **Do not** create public GitHub issues for security vulnerabilities
2. **Email** security@dollhousemcp.com with details
3. **Include** steps to reproduce if possible
4. **Allow** 90 days for patch before public disclosure

### Security Advisory Format

```
Subject: [SECURITY] Vulnerability in Auto-Update System

Severity: High/Medium/Low
Component: UpdateManager/BackupManager/etc
Version: 1.2.0
Description: Brief description of the vulnerability
Impact: What can an attacker do?
Steps to Reproduce: 
1. ...
2. ...
Suggested Fix: If you have one
```

## Compliance

The auto-update system is designed to meet common security standards:

- **OWASP Top 10** - Protection against common web vulnerabilities
- **CWE/SANS Top 25** - Secure coding practices
- **NIST Guidelines** - Cryptographic standards
- **PCI DSS** - Secure development practices

## Additional Resources

- [OWASP Secure Coding Practices](https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [GitHub Security Features](https://docs.github.com/en/code-security)
- [NPM Security Best Practices](https://docs.npmjs.com/packages-and-modules/securing-your-code)