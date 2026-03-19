# AI Assistant Onboarding Guide

> Give this file to any coding assistant (Claude, Gemini, Codex, etc.) before it starts working in this repository. It contains the minimum context an agent needs plus links to the deeper references under `docs/`.

## Quick Checklist for Agents
1. **Project Snapshot** – Read the overview below to understand the DollhouseMCP server goals and current state.
2. **Know the Source of Truth** – Use `docs/` for curated human-facing specs and `docs/agent/` for live session material. Key directories are linked in [Where to Look in docs/](#where-to-look-in-docs).
3. **Stay Modular & DI-Friendly** – Follow the dependency-injection patterns described in [Code Practices & Compliance](#code-practices--compliance).
4. **Pre-Commit Workflow is MANDATORY** – Before every commit, run: `npm run pre-commit && npm run lint && npm run build && npm test`. See [Testing Expectations](#testing-expectations) for details. Zero failures allowed.
5. **Test Before You Claim Success** – Follow the [Testing Expectations](#testing-expectations) section; never skip builds or security checks when you touch core code.
6. **Update Documentation & Memories** – When behavior changes, refresh the relevant guide and capture decisions using the memory conventions described in [Documentation & Knowledge Capture](#documentation--knowledge-capture).

## Project Overview
- **Repository**: DollhouseMCP MCP server (`mcp-server/`)
- **Purpose**: An AI customization platform that loads, manages, and serves personas, skills, agents, templates, and memories.
- **Primary entry point**: `src/index.ts`
- **Code organization**: Modules live under `src/` by domain (elements, handlers, utils, security, etc.). Tests mirror this structure under `tests/`.

### Architectural Context
- The server relies on dependency-injected services rather than singletons or god objects.
- `BaseElementManager` (and sibling classes) provide shared CRUD logic across element types to reduce duplication.
- See `docs/architecture/overview.md` for a full module map, lifecycle diagrams, and component responsibilities.

## Where to Look in docs/

| Need | Location | Notes |
|------|----------|-------|
| High-level architecture, DI container map | `docs/architecture/overview.md` | Start here for module boundaries and data flow |
| Development workflow, PR expectations | `docs/developer-guide/workflow.md`, `CONTRIBUTING.md` | Branching model, review process, commit hygiene |
| Coding guides for elements/managers | `docs/developer-guide/element-development.md`, `docs/developer-guide/adding-elements.md` | How to extend the element system |
| Testing strategy (unit, integration, security) | `docs/developer-guide/testing-strategy.md`, `docs/developer-guide/testing-strategy-es-modules.md`, `docs/security/testing.md` | Required commands and coverage expectations |
| User/operator guides | `docs/guides/` | Getting started, troubleshooting, configuration, client setup |
| Security hardening & checklists | `docs/security/` directory | Measures, architecture, test suites, release checklist |
| Session naming & retention | `docs/agent/development/SESSION_MANAGEMENT.md` | Naming rules, memory mirroring, archival workflow |
| Agent workspace & historical notes | `docs/agent/README.md` | Pointer hub for session history, archived workflows, and legacy runbooks |
| Historical context | `docs/archive/` | Legacy notes; **do not** cite for current behavior unless asked |

## Code Practices & Compliance

### Dependency Injection & Modularity
- Inject shared services via the DI container in `src/di/` instead of instantiating singletons.
- Keep handlers lean; push logic into managers/services with narrow responsibilities.
- Use `BaseElementManager` or existing manager patterns before introducing new abstractions.
- Respect the module boundaries documented in `docs/architecture/overview.md`—no cross-module reach-arounds.

### TypeScript & Error Handling
- Strong typing is mandatory; add interfaces or utility types when shapes grow complex.
- Sanitize inputs with the shared validators (`src/validation/`, `src/security/validators/`) rather than ad-hoc checks.
- Use structured error helpers and logging utilities. Never swallow errors silently; log with context.

### Security Standards
- Follow the guardrails in `docs/security/measures.md`. Key expectations:
  - Validate all user-provided content (JSON, YAML, Markdown) with `SecureYamlParser`, `SecureDownloader`, or equivalent utilities.
  - Keep file operations within sandboxed paths (`FileTransaction`, `FileLockManager`).
  - Prevent command or path injection by reusing hardened helpers.
- When touching sensitive flows (OAuth, token handling, filesystem), rerun the security suites (`npm run security:rapid` or `npm run security:all`) before declaring victory.

## Testing Expectations

### Pre-Commit Workflow (MANDATORY)
**Before every commit, run these checks IN ORDER (fail-fast approach):**

```bash
# 1. Security & Dependencies (Critical - Run First)
npm run pre-commit        # Security tests + dependency audit (~2-4s)

# 2. Code Style (Fast Fail)
npm run lint              # ESLint validation, 0 warnings policy (~1-2s)
# npm run lint:fix        # Auto-fix style issues if needed

# 3. Build Validation
npm run build             # TypeScript compilation check (~5-10s)

# 4. Test Suite
npm test                  # Unit tests (~10-30s)
```

**All checks must pass with zero failures.** This catches issues before they reach CI/CD.

### Extended Testing (Run as Needed)

| Scenario | Commands | Notes |
|----------|----------|-------|
| Focused unit run | `npm test -- --testPathPattern=path/to/test` | Use when iterating on a specific module |
| Performance tweaks | `npm run test:performance` | Required if a change affects indexing or search performance |
| Full security suite | `npm run security:all` | Comprehensive security coverage (~90s) |
| Security audit report | `npm run security:audit:verbose` | Detailed security analysis with report generation |
| Integration flows | `npm run test:integration` | Cross-module behavior validation |
| End-to-end validation | `npm run test:e2e` | Full system workflows |
| Coverage report | `npm run test:coverage` | Generate detailed coverage report |

### Quick Reference
```bash
# Minimum before commit
npm run pre-commit && npm run lint && npm run build && npm test

# Full validation before PR
npm run pre-commit && npm run lint && npm run build && npm test && npm run test:integration && npm run security:audit:verbose
```

**Important:** Never shrink the test matrix without approval. If a new feature lacks coverage, write tests first.

## Documentation & Knowledge Capture

1. **Docs** – Update or create files under `docs/` whenever behavior changes. Each directory has a `README.md` explaining what belongs there.
2. **Session Notes / Memory** – Capture in-flight work as `docs/agent/development/SESSION_*` files (see [`SESSION_MANAGEMENT.md`](../agent/development/SESSION_MANAGEMENT.md) for naming). When a note is more than seven days old, run `scripts/archive-old-docs.sh` to relocate it to `docs/session-history/YYYY/MM/`. Keep active context in `docs/agent/development/` so the automation continues to work.
   - Prefix important notes with `"Architecture decision:"`, `"Bug fix:"`, or `"Workflow:"` when saving to the memory server.
   - Avoid polluting shared context with speculative or abandoned approaches.
3. **CHANGELOG** – Major user-facing changes must be recorded in `CHANGELOG.md`.
4. **Root READMEs** – Regenerate or update the README variants if your change affects public-facing setup instructions.

## Git Workflow & Tooling

- Default to branching from `main` following the conventions in `docs/developer-guide/workflow.md`.
- Install the GitFlow Guardian hooks (`scripts/setup-gitflow-guardian.sh`) when you expect to touch Git history frequently. The hooks warn on branch mistakes and mirror the same guardrails our agents follow; bypass only for hotfixes that have been explicitly approved.
- If the guardian raises a false positive (notably when branching from `develop`), double-check the tree and document the outcome in your session notes so the async history stays reliable.

## AI Usage Tips
- Keep prompts small: summarize intent, point to this guide, and link relevant docs. Example:
  ```
  Read docs/guides/ai-assistant-onboarding.md, then open docs/architecture/overview.md and docs/developer-guide/workflow.md. Help me add OAuth logging to src/handlers/GitHubAuthHandler.ts and update docs/guides/oauth-setup.md accordingly.
  ```
- Cache anchor links: once the assistant has the high-level picture, direct it to specific sections by path (e.g., `docs/security/testing.md#running-the-rapid-suite`).
- Remind the agent to sanitize diffs: ensure it checks the DI wiring, reuses existing services, and touches documentation/tests.

## When to Escalate or Ask Humans
- Ambiguous product decisions or missing specs: flag for human review.
- Conflicting documentation: note the discrepancy and request clarification.
- Repository anomalies (unexpected untracked files, failing scripts): stop, report, and wait for instructions.

## Appendix: Integrating with Specific Agents

| Agent | How to use this guide |
|-------|----------------------|
| **Claude (CLAUDE.md)** | Add a short section in `CLAUDE.md` that instructs the model to load `docs/guides/ai-assistant-onboarding.md` first. |
| **Gemini (GEMINI.md)** | Mirror the Claude instructions: reference this guide as mandatory pre-context. |
| **Codex / GitHub Copilot** | Include a prompt snippet in your session kickoff or `.instructions` file pointing to this guide. |
| **Custom agents** | Treat this file as `AI_SETUP_DOCUMENT`. Instruct the agent to read it before executing tasks. |

Feel free to copy the table above into each agent-specific init file so every AI helper starts from the same project knowledge base.
