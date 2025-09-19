# Security Policy

## Our Commitment to Security

DollhouseMCP takes the security of our software and our users seriously. We've built security into every layer of our architecture, from input validation to secure update mechanisms. This document outlines our security policies, how to report vulnerabilities, and what you can expect from us.

## Reporting Security Vulnerabilities

### 🚨 How to Report

If you discover a security vulnerability in DollhouseMCP, please help us address it responsibly:

1. **DO NOT** create a public GitHub issue
2. **DO NOT** disclose the vulnerability publicly until we've had time to address it
3. **DO** use one of these secure channels:
   - Open a [Private Security Advisory](https://github.com/DollhouseMCP/mcp-server/security/advisories/new) on GitHub
   - Email us at: security@dollhousemcp.com (coming soon)

### What to Include

Please provide as much information as possible:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)
- Your contact information (for follow-up)

## Response Expectations

**Important**: DollhouseMCP is an open-source project maintained by a single developer in their spare time.

### What This Means
- **No guaranteed response times** - I will respond when I'm able to
- **No obligation to fix issues** - I will make best efforts to address security issues, but cannot guarantee fixes
- **No SLA or support commitments** - This is free software provided as-is
- **Response times vary** - Depending on my availability, work schedule, and other life commitments

### Realistic Expectations
- **Critical security issues**: I'll try to look at these as soon as I become aware of them
- **Other issues**: Will be addressed when time permits
- **Patches and fixes**: Provided on a best-effort basis with no guaranteed timeline
- **Communication**: I'll try to acknowledge reports when I can, but please be patient

This is a personal project I maintain because I believe in it, not a commercial product with support obligations.

## Supported Versions

We provide security updates for the following versions:

| Version | Support Status | Security Updates |
|---------|---------------|------------------|
| 1.9.x | ✅ Current | All security updates |
| 1.8.x | ⚠️ Maintenance | Critical security only |
| 1.7.x | ⚠️ Limited | Critical security only |
| < 1.7.0 | ❌ End of Life | No updates |

## Security Measures

### What We Do to Keep You Safe

#### 🛡️ Defense in Depth
We implement multiple layers of security:
- **Input Validation**: All user inputs are validated and sanitized
- **Output Encoding**: Protection against XSS and injection attacks
- **Path Traversal Prevention**: File system access is strictly controlled
- **Rate Limiting**: API and operation limits prevent abuse
- **Secure Dependencies**: Regular updates and vulnerability scanning

#### 🔐 Data Protection
- **No Credential Storage**: Tokens and secrets are never persisted
- **Automatic Redaction**: Sensitive data is scrubbed from all logs
- **Minimal Data Collection**: We only collect what's necessary
- **Local-First Architecture**: Your data stays on your machine

#### 🚫 Content Security
We actively prevent malicious content:
- **Pattern Detection**: Known attack vectors are blocked
- **Secret Scanning**: Prevents accidental credential exposure
- **YAML Injection Protection**: Safe parsing with strict schemas
- **Command Injection Prevention**: No direct shell execution
- **URL Validation**: Prevents SSRF and malicious redirects

#### 🔄 Secure Updates
- **Signature Verification**: Updates are cryptographically signed
- **Integrity Checks**: File hashes verify authenticity
- **Rollback Protection**: Safe recovery from failed updates
- **Version Validation**: Prevents downgrade attacks

## Scope

### In Scope
The following are considered valid security issues:
- Remote code execution
- Injection vulnerabilities (SQL, NoSQL, Command, LDAP, etc.)
- Cross-site scripting (XSS)
- Cross-site request forgery (CSRF)
- Authentication/authorization bypasses
- Information disclosure
- Denial of service vulnerabilities
- Path traversal/Local file inclusion
- Unsafe deserialization
- Security misconfigurations

### Out of Scope
The following are generally not considered security issues:
- Attacks requiring physical access to a user's device
- Social engineering attacks
- Denial of service from external dependencies
- Issues in third-party services we integrate with
- Theoretical vulnerabilities without proof of concept
- Scanner reports without demonstration of impact

## Recognition

We appreciate the security research community's efforts in helping keep DollhouseMCP safe. Security researchers who report valid vulnerabilities will be:

- Acknowledged in our release notes (unless you prefer to remain anonymous)
- Listed in our Security Hall of Fame
- Eligible for our bug bounty program (coming soon)

## Security Hardening Recommendations

For maximum security, we recommend:

1. **Keep Updated**: Always use the latest version
2. **Review Elements**: Audit community elements before activation
3. **Limit Permissions**: Run with minimum necessary privileges
4. **Monitor Activity**: Review logs for suspicious behavior
5. **Report Issues**: Help us by reporting suspicious content

## Disclosure Policy

As a solo-maintained project, the disclosure process is straightforward:

1. **Report Receipt**: I'll acknowledge when I see it (no guaranteed timeline)
2. **Assessment**: I'll evaluate the issue when I have time
3. **Fix Development**: If I agree it's a security issue and have time, I'll work on a fix
4. **Release**: When a fix is ready, I'll release it with appropriate notes
5. **Public Disclosure**: Security advisories will be published when appropriate

**Please note**:
- I appreciate responsible disclosure and will do my best to coordinate with reporters
- However, I cannot guarantee specific timelines or commit to embargo periods
- If you need a fix urgently, you're welcome to submit a pull request

## Contact

- **Security Issues**: Use GitHub Security Advisories or security@dollhousemcp.com (coming soon)
- **General Questions**: [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)
- **Bug Reports**: [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)

## Learn More

For technical details about our security architecture and implementations:
- [Security Measures](docs/security/SECURITY_MEASURES.md)
- [Security Architecture](docs/security/SECURITY_ARCHITECTURE.md)
- [Security Testing Guide](docs/security/SECURITY_TESTING.md)

---

*Last Updated: September 19, 2025*
*Version: 1.0*

Thank you for helping keep DollhouseMCP secure! 🔐