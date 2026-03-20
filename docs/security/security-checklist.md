# Security Checklist for Developers

Use this checklist before merging PRs or cutting a release. It complements the detailed testing instructions in [testing.md](testing.md) and the quick-start guide.

## 1. Before Submitting a PR

- [ ] Run `npm run security:rapid` (or `security:critical`) and ensure it passes.
- [ ] If you added or modified an MCP tool, run `npm run security:generate -- <tool>` and add/update the corresponding test under `tests/security/tests/`.
- [ ] Verify no secrets or tokens are logged (check any new logging statements for redaction).
- [ ] Confirm new file operations use `PortfolioManager` and respect path validation utilities.
- [ ] Review changes to YAML parsing or serialization for use of `SecureYamlParser`.
- [ ] Document any security-affecting behavior changes (update `measures.md` if appropriate).

## 2. Before Releasing

- [ ] Run `npm run security:all` (full suite) and address any failures.
- [ ] Manually test `setup_github_auth` / `check_github_auth` to confirm the OAuth device flow still works.
- [ ] Test a portfolio upload/download roundtrip (`portfolio_element_manager`) and a collection submission (`submit_collection_content`).
- [ ] Rebuild the enhanced index (e.g., call `get_relationship_stats`) and watch for warnings or performance regressions.
- [ ] Review `~/.dollhouse/oauth-helper.log` for errors if authentication was exercised.
- [ ] Update release notes with notable security changes or mitigations.

## 3. Ongoing Practices

- [ ] Keep dependencies patched; monitor security advisories (`npm audit`, `npm run security:audit`).
- [ ] Rotate personal GitHub tokens used for development/testing.
- [ ] Segregate sensitive security discussions into the private repo as outlined in [documentation-guide.md](documentation-guide.md).
- [ ] Report suspected vulnerabilities following the process in `SECURITY.md` (root of repository).

Checking these boxes helps ensure the platform remains secure as the codebase evolves. Feel free to extend this list as new safeguards are introduced.
