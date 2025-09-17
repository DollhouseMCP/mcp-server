# Security Audit Report

Generated: 2025-09-17T19:09:09.998Z
Duration: 168ms

## Summary

- **Total Findings**: 3
- **Files Scanned**: 132

### Findings by Severity

- 🔴 **Critical**: 1
- 🟠 **High**: 0
- 🟡 **Medium**: 1
- 🟢 **Low**: 1
- ℹ️ **Info**: 0

## Detailed Findings

### CRITICAL (1)

#### OWASP-A03-002: Command Injection: Potential command injection vulnerability

- **File**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/test-full-validation.js`
- **Line**: 372
- **Column**: 18
- **Code**: `const docker = spawn('docker', [`
- **Confidence**: low
- **Remediation**: Validate and sanitize all user input before using in system commands

### MEDIUM (1)

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/test-full-validation.js`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

### LOW (1)

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/test-version-validation.js`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

## Recommendations

1. Address all critical and high severity issues immediately
2. Review medium severity issues and plan remediation
3. Consider adding suppressions for false positives
4. Run security audit regularly (e.g., in CI/CD pipeline)
