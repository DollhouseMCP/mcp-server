# Security Audit Report

Generated: 2025-07-13T14:18:52.589Z
Duration: 37ms

## Summary

- **Total Findings**: 32
- **Files Scanned**: 47

### Findings by Severity

- 🔴 **Critical**: 0
- 🟠 **High**: 0
- 🟡 **Medium**: 14
- 🟢 **Low**: 18
- ℹ️ **Info**: 0

## Detailed Findings

### MEDIUM (14)

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/tools/debug.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/server/types.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/yamlValidator.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/secureYamlParser.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/regexValidator.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/pathValidator.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/index.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/fileLockManager.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/constants.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/InputValidator.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/server/tools/MarketplaceTools.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/audit/scanners/CodeScanner.ts`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/scripts/generate-security-tests.js`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

#### DMCP-SEC-004: User input processed without Unicode normalization

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/package-lock.json`
- **Confidence**: medium
- **Remediation**: Use UnicodeValidator.normalize() on all user input

### LOW (18)

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/index.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/utils/version.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/update/VersionManager.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/update/SignatureVerifier.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/update/RateLimiter.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/update/DependencyChecker.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/update/BackupManager.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/server/types.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/yamlValidator.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/tokenManager.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/pathValidator.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/commandValidator.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/InputValidator.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/server/tools/PersonaTools.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/audit/scanners/DependencyScanner.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/audit/scanners/ConfigurationScanner.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/src/security/audit/config/suppressions.ts`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

#### DMCP-SEC-006: Security operation without audit logging

- **File**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/scripts/generate-security-tests.js`
- **Confidence**: medium
- **Remediation**: Add SecurityMonitor.logSecurityEvent() for audit trail

## Recommendations

1. Address all critical and high severity issues immediately
2. Review medium severity issues and plan remediation
3. Consider adding suppressions for false positives
4. Run security audit regularly (e.g., in CI/CD pipeline)
