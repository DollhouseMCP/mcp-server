# Security Audit Report

Generated: 2025-08-21T10:33:18.496Z
Duration: 107ms

## Summary

- **Total Findings**: 1
- **Files Scanned**: 78

### Findings by Severity

- 🔴 **Critical**: 0
- 🟠 **High**: 1
- 🟡 **Medium**: 0
- 🟢 **Low**: 0
- ℹ️ **Info**: 0

## Detailed Findings

### HIGH (1)

#### DMCP-SEC-005: Unvalidated YAML Content: YAML content parsed without security validation

- **File**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/src/portfolio/DefaultElementProvider.ts`
- **Line**: 327
- **Column**: 43
- **Code**: `// SECURITY FIX: Replace direct yaml.load() with SecureYamlParser for enhanced security`
- **Confidence**: medium
- **Remediation**: Use SecureYamlParser for all YAML parsing

## Recommendations

1. Address all critical and high severity issues immediately
2. Review medium severity issues and plan remediation
3. Consider adding suppressions for false positives
4. Run security audit regularly (e.g., in CI/CD pipeline)
