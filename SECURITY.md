# Security Policy

This project treats security as a core requirement. The goal of this document is to explain how to report vulnerabilities, what level of response you can expect, and which companion documents contain the deeper technical details.

## Reporting Security Vulnerabilities

Please use a private channel so we can triage issues without exposing users:

- Open a [GitHub private security advisory](https://github.com/DollhouseMCP/mcp-server/security/advisories/new). This is the preferred path.
- If you cannot use GitHub advisories, send a direct message to the maintainer. (A dedicated security@ inbox is not yet available.)

When you file a report, include:

- A clear description of the vulnerability and its impact
- Exact reproduction steps or proof-of-concept code
- Affected versions (if you know them)
- Any workaround or fix ideas you have
- Contact information so we can follow up

## Response Expectations

DollhouseMCP is maintained by one person. There is no formal SLA and no team on call. Realistic expectations:

- Critical issues are reviewed as soon as the maintainer becomes aware of them.
- Lower-severity issues are handled when time allows.
- Fixes are shipped on a best-effort basis. Pull requests that include tests are always welcome.
- Communication may be delayed; please be patient and avoid public disclosure until we agree the fix is ready.

If you want to help improve incident response, consider contributing patches, reviewing fixes, or sponsoring development time.

## Supported Versions

Security fixes target actively maintained releases. At the moment, the three most recent minor versions receive fixes for critical issues; older versions are considered end-of-life. See the release notes for up-to-date support signals.

## Current Defenses

The MCP server does not ship an auto-update mechanism. Users update through npm or their preferred package manager.

Security protections focus on the running server and the content it processes:

- **Input and content validation**: All inbound payloads pass through strict schema checks, Unicode normalization, and size limits.
- **Secret handling**: Access tokens stay in memory only, logs redact sensitive fields, and file writes use atomic operations with rollback.
- **Sandboxed file access**: File operations run through transaction helpers that enforce allowed paths and clean up on failure.
- **Rate limiting and abuse detection**: Shared utilities (for example `SecureDownloader` and the generic rate limiter) throttle downloads and flag suspicious activity.
- **Security testing**: Dedicated Jest suites (`npm run security:rapid`, `npm run security:all`) exercise command-injection, path-traversal, YAML parsing, and other high-risk paths before we ship.

For the deeper implementation details and operational checklists, refer to the `docs/security/` directory:

- `docs/security/measures.md` — defensive controls and how they are implemented
- `docs/security/architecture.md` — threat model and component-level view
- `docs/security/testing.md` and `docs/security/testing-quick-start.md` — how to run and extend the security test suites
- `docs/security/security-checklist.md` — hardening steps for maintainers before a release

## Reporting Scope

In-scope findings include remote code execution, injection flaws, authentication/authorization bypasses, data leaks, privilege escalation, and denial-of-service attacks caused by our code. Issues that require physical access, target third-party dependencies, or lack a reproducible proof-of-concept are typically out of scope unless you can show a direct exploit path.

## Disclosure Process

Once a report arrives:

1. We acknowledge it when we can reproduce the issue or need more detail.
2. The maintainer investigates, prioritizes a fix, or clarifies why it is out of scope.
3. When a fix is ready, we publish a release and (if appropriate) a GitHub security advisory.
4. After users have time to update, we coordinate public disclosure with the reporter.

Because this is a volunteer effort, timelines vary. If you require a faster turnaround, you are encouraged to submit a tested pull request.

## Contact & Follow-Up

- Vulnerability reports: GitHub private advisories (preferred)
- Questions about the policy: open a GitHub Discussion thread
- General bugs: file a normal GitHub issue

*Last reviewed: October 2025*  
The security docs and tests evolve alongside the codebase. When in doubt, check `docs/security/` for the most current procedures.
