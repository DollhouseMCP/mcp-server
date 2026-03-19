# Contributing to DollhouseMCP

Thanks for your interest in improving the DollhouseMCP server. This document gives you the high-level orientation you need to get started and points you to the deeper contributor guides that live in `docs/`. For comprehensive procedures and checklists, consult the **Contributor Reference** at `docs/contributing.md`.

## Start Here
- Read `docs/guides/getting-started.md` to set up your environment and understand the current project layout.
- Review `docs/architecture/overview.md` for a high-level map of the server modules.
- Working with an AI assistant? Brief it with `docs/guides/ai-assistant-onboarding.md` before you start.
- Join an issue from the [GitHub tracker](https://github.com/DollhouseMCP/mcp-server/issues) and confirm no one else is already working on it.

## Development Workflow
- Branch from `main` and use descriptive prefixes (`feature/`, `fix/`, `refactor/`, `docs/`, `test/`). A step-by-step walkthrough lives in `docs/developer-guide/workflow.md`.
- Keep your fork or local clone in sync with upstream frequently (`git fetch upstream && git rebase upstream/main`).
- Coordinate large refactors or architectural work through the roadmap in `docs/architecture/overview.md`.

## Pull Requests & Reviews
- Follow the expectations in `docs/developer-guide/pr-guidelines.md` for branch hygiene, commit structure, and PR templates.
- Reference the issue you are addressing and outline your test plan in the PR description.
- Request at least one review and respond to feedback promptly; update documentation alongside code changes.

## Quality & Testing
- Run `npm run build` and `npm test` before pushing. The full testing checklist and optional CI workflows are covered in `docs/developer-guide/testing-strategy.md` and `docs/developer-guide/testing-strategy-es-modules.md`.
- When modifying element CRUD operations (create, read, update, delete, activate), run `npm run test:crud` to validate all element types. This comprehensive test suite covers all 6 element types (personas, skills, templates, agents, memories, ensembles) with 277 tests.
- Review `docs/security/testing.md` and `docs/security/security-checklist.md` when your change touches security-sensitive paths or external integrations.

## Documentation Expectations
- Update or create documentation in `docs/` whenever behavior changes. Directory landing pages (`README.md` files) describe what belongs where.
- Follow the patterns in `docs/guides/` for user-facing guides and `docs/reference/` for API-level material.
- For decisions with lasting impact, add an entry to `docs/architecture/` or link an ADR from your PR.

## Getting Help
- Use GitHub Issues and the project board for coordination.
- For emergencies, follow the incident process in `SECURITY.md`.
- When collaborating with AI assistants, capture important context in the shared memory notes using the `"Architecture decision:"`, `"Bug fix:"`, or `"Workflow:"` markers.

For detailed procedures and historical notes, see the **Contributor Reference** (`docs/contributing.md`). If you notice gaps, open an issue or PR so the contributor docs stay current with the codebase.
