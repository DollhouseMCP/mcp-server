# DollhouseMCP Security Measures

**Last Updated:** November 7, 2025
**Version:** 1.9.26

## Overview

DollhouseMCP implements comprehensive security measures to protect users, their content, and the broader ecosystem. This document outlines the security features and protections currently in place.

## Security Test Coverage

The DollhouseMCP server has **comprehensive security test coverage** with hundreds of automated security tests covering:

- Input Validation (20+ tests)
- Path Traversal Prevention (15+ tests)
- Command Injection Protection (12+ tests)
- YAML Deserialization Security (10+ tests)
- Token Management Security (8+ tests)
- Memory Injection Protection (15+ tests)
- Unicode Attack Prevention (10+ tests)
- OWASP Top 10 Coverage (15+ tests)

All security tests run automatically in CI/CD pipelines. Run them locally with:
```bash
npm run security:rapid  # Fast security checks
npm run security:all    # Complete security audit suite
```

See [Security Testing Guide](./testing.md) for details.

## Core Security Principles

1. **Defense in Depth** - Multiple layers of security controls
2. **Least Privilege** - Minimal permissions required for operations
3. **Secure by Default** - Security features enabled out of the box
4. **Transparency** - Clear communication about security practices

## Security Features

### Token & OAuth Protection

- **Secure Token Handling**
  - GitHub tokens are encrypted at rest under `~/.dollhouse/.auth/` via the `TokenManager`.
  - Automatic redaction in all logs and error messages.
  - Format validation plus rate-limited scope checks prevent brute-force validation attempts.

- **API Authentication**
  - GitHub device flow with explicit scope validation.
  - OAuth helper persists tokens securely and refreshes them from encrypted storage when required.
  - Retry backoff and rate-limit awareness keep GitHub API usage within safe limits.

### Content Security

- **Input Validation Pipeline**
  - Multi-stage validation process
  - Schema validation with strict typing
  - Size limits enforced (500KB content, 2MB files, 64KB YAML, 1KB metadata fields)
  - Character encoding verification
  - Unicode normalization for security

- **Malicious Content Detection**
  - Pattern-based threat detection / secret scanning
  - Unified index duplicate detection and warnings
  - External resource validation for collection installs
  - Automated security analysis with quarantine workflows

- **Memory Injection Protection (Issue #1269)**
  - 30+ injection pattern detections
  - Unicode attack prevention (bidirectional text, homographs)
  - YAML bomb protection with circular reference detection
  - Multi-layer validation pipeline
  - Automatic content sanitization

- **URL Security**
  - Comprehensive URL validation
  - Protection against local network access
  - Whitelist of allowed protocols
  - Blocking of suspicious filename extensions and double-encoded traversal sequences

### 🚦 Rate Limiting & Abuse Prevention

- **API Protection**
  - Shared token-bucket limiter for GitHub API traffic (`GitHubRateLimiter`).
  - Configurable retry backoff for transient failures.
  - Graceful degradation when rate limits are hit (callers receive sanitized errors and can retry later).

- **Abuse Prevention**
  - Duplicate detection in the unified index warns before publishing redundant elements.
  - Confirmation prompts protect destructive sync operations (`portfolio_element_manager`, `sync_portfolio`).

### 📊 Security Monitoring

- **Audit Logging**
  - `SecurityMonitor` records high-severity events (e.g., path traversal attempts, authentication changes) for review.
  - Debug logging captures cache saves, downloads, and validation outcomes for troubleshooting.

- **Threat Detection**
  - Pattern-based validators (YAML parsing, input sanitizers) block known attack vectors.
  - Duplicate and relationship checks surface suspicious or repetitive submissions.
  - Community reporting via GitHub issues supplements automated checks.

- **Security Telemetry**
  - Real-time attack metrics tracking
  - Attack vector aggregation and analysis
  - Hourly attack distribution monitoring
  - Top attack patterns identification
  - Export capabilities for external SIEM integration
  - 24-hour rolling window metrics
  - Severity-based categorization

### 🔄 Release & Dependency Management

- **Release Process**
  - Prepublish scripts rebuild TypeScript output and README variants before publishing to npm.
  - Protected branch workflows (`core-build-test`, `cross-platform-simple`) must pass prior to release.
  - The `files` whitelist in `package.json` restricts published artifacts to the expected build output.

- **Dependency Management**
  - Regular dependency updates with `npm audit`, `npm run security:audit`, and CI scanners.
  - Security suites (`npm run security:rapid`, `npm run security:all`) run before release to catch regressions.

## Content Sharing & Enhanced Index Security

- Collection submissions (`submit_collection_content`) enforce duplicate warnings, version checks, and GitHub upload validation before opening community issues.
- Enhanced index rebuilds run under file locks, obey TTLs, and cap trigger extraction to prevent resource exhaustion.
- Quarantine options exist in handlers for future manual review workflows.

## API Security

- Input sanitization across all MCP endpoints
- Output encoding and sanitized error messages
- Timeout/size limits for tool inputs and file uploads
- OAuth scope enforcement before GitHub access

### External API Integration
- Secure credential management
- API response validation
- Timeout enforcement
- Error isolation

## Best Practices for Users

### Protecting Your Tokens
1. Never share your GitHub token
2. Use tokens with minimal required scopes
3. Rotate tokens regularly
4. Monitor token usage

### Secure Content Creation
1. Avoid including secrets in personas
2. Validate external resources
3. Use official marketplace for sharing
4. Report suspicious content

## Security Compliance

### Standards and Frameworks
- OWASP Top 10 considerations
- Security by design principles
- Regular security assessments
- Continuous improvement process

### Data Protection
- Credentials stored encrypted on disk; access limited to the local user account
- Minimal data collection
- User control over shared content
- Clear data handling policies

## Incident Response

### Response Process
1. **Detection** - Automated and community reporting
2. **Assessment** - Severity and impact analysis
3. **Mitigation** - Immediate protective actions
4. **Resolution** - Full fix deployment
5. **Communication** - User notification if needed

### Response Commitments
- Critical issues: Response within 4 hours
- High severity: Response within 24 hours
- Medium severity: Response within 72 hours
- Security advisories published promptly

## Responsible Disclosure

We welcome security research and responsible disclosure:

- **Contact**: security@dollhousemcp.com (coming soon)
- **GPG Key**: [Public key available]
- **Response Time**: Within 48 hours
- **Bug Bounty**: Program details coming soon

### Disclosure Process
1. Report vulnerability privately
2. Receive acknowledgment within 48 hours
3. Collaborate on fix timeline
4. Coordinated disclosure
5. Credit in security advisory

## Version Security

### Supported Versions
| Version | Security Support |
|---------|-----------------|
| 1.2.x   | ✅ Active       |
| 1.1.x   | ⚠️ Critical only |
| 1.0.x   | ❌ End of life  |

### Security Update Policy
- Critical patches for current and previous minor version
- Regular updates for current version only
- Clear upgrade paths provided
- Breaking changes avoided in security updates

## Continuous Improvement

### Regular Activities
- Weekly dependency updates
- Monthly security reviews
- Quarterly penetration testing
- Annual security audit

### Community Involvement
- Open security discussions
- Public security roadmap
- Community security champions
- Educational resources

## Getting Help

### Security Questions
- Documentation: `/docs/security/`
- Community: Discord security channel
- Email: support@dollhousemcp.com

### Reporting Issues
- Security issues: Use responsible disclosure
- Bugs: GitHub issues
- Questions: Community forums

## Conclusion

Security is a top priority for DollhouseMCP. We continuously improve our security posture through proactive measures, community engagement, and rapid response to issues. By using DollhouseMCP, you benefit from these comprehensive security measures designed to protect you and your content.

For more technical details about our security architecture, see [Architecture](architecture.md).

---

*Last updated: July 2025*
*Version: 1.0*
