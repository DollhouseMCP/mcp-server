# Security Documentation

Security architecture, testing, and operational guides for DollhouseMCP.

---

## Gatekeeper & Permissions

| Guide | Description |
|-------|-------------|
| [Gatekeeper Confirmation Model](gatekeeper-confirmation-model.md) | How the multi-layer permission system works — confirmation flows, element policies (allow/confirm/deny), nuclear sandbox, and the session-allow problem |
| [Security Architecture](architecture.md) | High-level overview of the security architecture with component diagrams |

## For Developers & Contributors

| Guide | Description |
|-------|-------------|
| [Security Checklist](security-checklist.md) | Pre-PR and pre-release checklist — run through this before merging |
| [Contributor Security Guide](CONTRIBUTOR-SECURITY-GUIDE.md) | Security practices for contributors — what to watch for, how to report |
| [Testing Quick Start](testing-quick-start.md) | Fast security checks for developers — the minimum before committing |
| [Testing Infrastructure](testing.md) | Full security test suite — automated scanning, test categories, CI integration |

## Security Measures

| Guide | Description |
|-------|-------------|
| [Implemented Measures](measures.md) | Public-facing list of security protections — input sanitization, path traversal prevention, YAML injection protection, encryption, audit logging |
| [Memory Injection Protection](memory-injection-protection.md) | Prompt injection defenses for the memory system — multi-agent swarm scenarios, trust levels, content validation |

## Documentation Policy

| Guide | Description |
|-------|-------------|
| [Documentation Guide](documentation-guide.md) | How to maintain public vs. private security documentation — what goes here vs. the private security repo |

---

## Reporting Security Issues

If you discover a security vulnerability:

1. **DO NOT** create a public GitHub issue
2. Open a [private security advisory](https://github.com/DollhouseMCP/mcp-server/security/advisories) on GitHub
3. Include steps to reproduce if possible
4. Allow up to 48 hours for initial response
