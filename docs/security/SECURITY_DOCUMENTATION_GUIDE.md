# Security Documentation Guide

## Overview

This guide explains how to maintain dual security documentation for DollhouseMCP - keeping detailed vulnerability information private while maintaining transparency about security measures.

## Documentation Structure

### Public Documentation (This Repository)

```
/docs/security/
├── SECURITY.md                    # Security policy & responsible disclosure
├── SECURITY_MEASURES.md           # Public-facing security features
├── SECURITY_ARCHITECTURE.md       # High-level architecture (no vulnerabilities)
├── API_WORKFLOW_ARCHITECTURE.md   # API flows and controls
└── audits/
    └── 2025-Q3-audit-summary.md   # Sanitized audit results
```

### Private Documentation (Separate Private Repo)

```
dollhousemcp-security-private/
├── README.md                      # Access control & guidelines
├── vulnerabilities/
│   ├── VULN-2025-001.md          # ReDoS in PersonaSharer
│   ├── VULN-2025-002.md          # SSRF in URL validation
│   └── template.md               # Vulnerability template
├── incidents/
│   ├── INCIDENT-2025-001.md      # Security incident reports
│   └── template.md
├── audits/
│   ├── 2025-Q3-audit-full.md    # Complete audit with vulnerabilities
│   └── penetration-tests/
└── research/
    ├── attack-vectors.md
    └── threat-models.md
```

## Creating Public vs Private Documentation

### Example: Documenting a Vulnerability

#### Private Version (VULN-2025-001.md)
```markdown
# VULN-2025-001: ReDoS in Base64 Validation

## Summary
Regular Expression Denial of Service vulnerability in PersonaSharer.ts

## Details
- **Component**: PersonaSharer.validateShareUrl()
- **Severity**: High
- **CVSS**: 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H)

## Technical Details
The regex `/#dollhouse-persona=([A-Za-z0-9+/=]+)$/` is vulnerable to catastrophic backtracking when provided with strings like:
```
#dollhouse-persona=AAAAAAAAAA....[10000 A's]...AAAA!
```

## Proof of Concept
```javascript
const malicious = '#dollhouse-persona=' + 'A'.repeat(10000) + '!';
const start = Date.now();
url.match(/#dollhouse-persona=([A-Za-z0-9+/=]+)$/);
console.log(`Took ${Date.now() - start}ms`); // >30000ms
```

## Remediation
Changed to bounded quantifier: `/#dollhouse-persona=([A-Za-z0-9+/=]{1,10000})$/`

## Timeline
- 2025-07-14: Discovered during security review
- 2025-07-14: Fix implemented in PR #275
- 2025-07-14: Fix deployed
```

#### Public Version (In SECURITY_MEASURES.md)
```markdown
## Input Validation

### Regular Expression Safety
- All regex patterns use bounded quantifiers to prevent performance issues
- Maximum input lengths enforced before regex processing
- Timeout protection on all pattern matching operations

✅ Protection against regex-based denial of service attacks
```

### Example: Security Architecture

#### What to Include Publicly
```markdown
## Security Measures Implemented

### Content Validation Pipeline
- Multi-stage validation process
- Schema validation with strict types
- Size limits enforced (100KB max)
- External resource validation
- Automated security scanning

### Token Protection
- Tokens never stored persistently
- Automatic redaction in logs
- Memory encryption for sensitive data
- Secure token lifecycle management
```

#### What to Keep Private
- Specific regex patterns that could be exploited
- Exact validation bypass techniques discovered
- Internal security thresholds and limits
- Detailed attack scenarios
- Security tool configurations

## Best Practices

### 1. Commit Messages

**Good Public Commit**:
```
Enhance input validation security

- Add additional validation layers
- Improve error handling
- Update security documentation
```

**Bad Public Commit** (Too Specific):
```
Fix ReDoS vulnerability in base64 regex validation

- Changed unbounded quantifier to maximum 10000
- Prevents 30-second regex execution attacks
```

### 2. Code Comments

**Good Public Comment**:
```typescript
// Validate URL format for security
if (!this.validateShareUrl(url)) {
  return { success: false, message: 'Invalid URL format' };
}
```

**Bad Public Comment** (Reveals Attack Vector):
```typescript
// Prevent ReDoS by limiting regex backtracking
// Without this, attackers can cause 30s+ CPU time
```

### 3. Error Messages

**Good Public Error**:
```typescript
throw new Error('Invalid input format');
```

**Bad Public Error** (Too Informative):
```typescript
throw new Error('Input exceeds regex complexity limit of 10000 iterations');
```

## Security Advisory Template

### Public Advisory
```markdown
# Security Advisory: Input Validation Enhancement

## Summary
We've enhanced input validation in the persona sharing feature to improve security.

## Impact
No user action required. This update improves protection against malformed inputs.

## Resolution
Update to version 1.2.5 or later.

## Credits
Thanks to our security review process for identifying areas for improvement.
```

### Private Advisory (Internal)
```markdown
# Security Advisory: CVE-2025-XXXX

## Vulnerability Details
[Full technical details including attack vectors]

## Exploitation Potential
[Detailed analysis of how this could be exploited]

## Remediation Details
[Specific code changes and rationale]
```

## Maintaining Open Source Transparency

### Do Share Publicly
- Security features and protections
- General security architecture
- Best practices implemented
- Security contact information
- Responsible disclosure policy
- Version requirements for security fixes

### Don't Share Publicly
- Specific vulnerability details
- Attack vectors or POCs
- Security thresholds/limits
- Internal security tooling
- Unpatched vulnerability information
- User-specific security data

## Review Process

### Before Publishing Security Content

1. **Review for Information Disclosure**
   - No specific attack methods
   - No internal limits revealed
   - No tool configurations exposed

2. **Ensure Positive Framing**
   - Focus on protections added
   - Emphasize proactive security
   - Highlight continuous improvement

3. **Check for Completeness**
   - Users understand the protection
   - No security through obscurity
   - Clear upgrade path if needed

## Security Metrics Reporting

### Public Metrics (OK to Share)
- Number of security features
- Types of protection implemented
- Security audit frequency
- Response time commitments

### Private Metrics (Keep Internal)
- Specific detection rates
- Bypass attempt statistics  
- Vulnerability discovery rates
- Detailed incident metrics

## Incident Response Documentation

### Public Incident Report
```markdown
## Security Incident Report

On [DATE], we identified and resolved a security issue affecting [COMPONENT].

### Impact
- No user data was compromised
- Service remained available
- Issue was patched within 2 hours

### Actions Taken
- Immediate mitigation deployed
- Full fix released in v1.2.5
- Additional monitoring added

### Recommendations
- Update to latest version
- No additional action required
```

### Private Incident Report
[Contains full timeline, attack details, forensics, lessons learned]

## Conclusion

This dual documentation approach allows DollhouseMCP to:
1. Maintain transparency about security measures
2. Protect specific vulnerability information
3. Build user trust through openness
4. Prevent providing attackers with blueprints

Remember: When in doubt, err on the side of caution and keep specific vulnerability details private while being transparent about the protections in place.