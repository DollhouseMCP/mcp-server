# DollhouseMCP Contributor Reference

Thank you for investing time in the DollhouseMCP project. This reference expands on the quick-start summary in the repository root `CONTRIBUTING.md` and complements the focused guides inside `docs/developer-guide/`.

## Document Hierarchy
- **Quick Start Summary** – [`CONTRIBUTING.md`](../CONTRIBUTING.md) (repo root): orientation, must-read links, and contribution checklist.
- **Contributor Reference** – this file: deeper process guidance, checklists, and links to domain-specific docs.
- **Specialized Guides** – `docs/developer-guide/`, `docs/security/`, `docs/architecture/`: topic deep dives cited throughout this reference.

## How to Use This Guide
- **New to the project?** Follow the “Getting Started” checklist first.
- **Need the canonical workflow?** Jump to [Development Workflow](#development-workflow).
- **Preparing a PR?** Review [Pull Requests & Reviews](#pull-requests--reviews) and the linked detail docs.

## Getting Started
1. **Review the project context**
   - `docs/architecture/overview.md` explains the current module layout.
   - `docs/guides/getting-started.md` covers tooling, environment setup, and common workflows.
2. **Set up your environment**
   - Follow `docs/guides/getting-started.md` for prerequisites and toolchain setup.
   - Run `npm install`, `npm run build`, and `npm test` to verify your installation.
   - Planning to use an AI helper? Review `docs/guides/ai-assistant-onboarding.md` so the assistant starts with the right context.
3. **Pick and claim an issue**
   - Browse the [issue tracker](https://github.com/DollhouseMCP/mcp-server/issues).
   - Labels use the `priority:*`, `type:*`, and `area:*` taxonomy—mirror existing usage.
   - Comment to claim an issue before you branch.

## Development Workflow
- **Branch from `main`.** Keep a clean local copy by running `git fetch upstream && git rebase upstream/main`.
- **Use descriptive prefixes.** Standard branch prefixes are `feature/`, `fix/`, `refactor/`, `docs/`, and `test/`.
- **Sync often.** Rebase or merge upstream changes during long-lived work to avoid surprises.
- **Document decisions.** Capture architecture-impacting choices in `docs/architecture/` and add `"Architecture decision:"` notes to shared memory when collaborating with AI.

The full workflow, including project board flow and release cadence, lives in `docs/developer-guide/workflow.md`.

## Coding Standards
- **TypeScript & Node:** Follow existing patterns in `src/` and ensure `npm run build` remains clean.
- **Dependency Injection:** Prefer injecting dependencies via the shared container utilities in `src/di/`.
- **Avoid duplication:** Reuse the shared `BaseElementManager` and helper utilities under `src/elements/base/` and `src/utils/` when extending functionality.
- **Security hygiene:** Never commit secrets. When in doubt, consult `SECURITY.md` and `docs/security/security-checklist.md`.

## Testing Expectations
- Run `npm run pre-commit` (security tests + dependency audit) and `npm run lint` before opening a PR.
- Run `npm test` and `npm run build` to verify functionality and compilation.
- For modules touching persistence or cross-process behavior, consult `docs/developer-guide/testing-strategy.md`.
- ESM quirks and workarounds are documented in `docs/developer-guide/testing-strategy-es-modules.md`.
- Security validation guidance is available in `docs/security/testing.md`.

## Pull Requests & Reviews
1. **Craft meaningful commits.** Use Conventional Commit prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, etc.) and keep each commit scoped.
2. **Summarize the change.** PR descriptions should highlight the problem, solution, tests, and follow-up work. Templates and examples live in `docs/developer-guide/pr-guidelines.md`.
3. **Link issues and docs.** Reference the issue number (`Closes #NNN`) and mention relevant documentation updates in your PR.
4. **Request review early.** Tag maintainers or domain experts. Respond to feedback with follow-up commits rather than force pushes when possible.

For large refactors, open a draft PR to confirm direction before polishing.

## Documentation Responsibilities
- Update user or operator guidance in `docs/guides/`.
- Keep API-level material in `docs/reference/` aligned with code.
- Summarize architectural shifts in `docs/architecture/` and cross-link from your PR.
- Ensure each documentation directory `README.md` stays current when you add or remove files.

## Additional Resources
- `docs/security/` for hardening practices and incident response.
- `docs/reference/` for MCP protocol and element schema details.
- `docs/archive/` is retained for historical reference only. You should not need it for active development.

If you spot gaps in this guide or its linked documents, open an issue or PR so future contributors stay aligned with the codebase.
