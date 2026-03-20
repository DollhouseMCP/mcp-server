# Why DollhouseMCP Exists

DollhouseMCP is the orchestration layer that makes AI customization predictable. It gives developers, operators, and assistants a shared language (“elements”) plus tooling to create, manage, and ship those customizations safely.

The sections below explain the “why” behind the project, how the parts fit together, and where to look next depending on your role.

---

## 1. The Problems We Solve

| Challenge | What usually happens | How DollhouseMCP responds |
|-----------|----------------------|---------------------------|
| **Assistant behavior is unpredictable** | Personas live inside prompts or scratch notes. No provenance or version control. | Personas become first-class elements (YAML/Markdown files) with metadata, history, and validation. |
| **Capabilities are scattered** | Skills, templates, and workflows sit in personal notes or ad‑hoc scripts. Hard to reuse or review. | Each capability is modeled as a type-specific element (skills, templates, agents, memories) and stored in a portable portfolio. |
| **Customization cannot be shared safely** | Copy/paste between users, no trust on source or compatibility. | `collection` and GitHub portfolio flows provide audit trails, automated validation, and issue tracking. |
| **Tooling changes faster than documentation** | Contributors guess at architecture and regressions slip in. | The MCP server applies dependency injection, tests, and documentation hooks so changes are predictable and testable. |
| **Search and discovery break at scale** | Hundreds of personas become unmanageable; nobody remembers what exists. | The Enhanced Capability Index adds verb triggers, semantic relationships, and unified search across local, GitHub, and community sources. |

---

## 2. Project Vision & Design Principles

1. **Elements Everywhere** — Personas, skills, templates, agents, memories, and ensembles share one schema and lifecycle. If you can manage one type, you can manage them all.
2. **Portfolio First** — Your local portfolio (`~/.dollhouse/portfolio`) is authoritative. GitHub sync and the community collection are additive layers, not dependencies.
3. **Strong Defaults, Extensible Architecture** — The server runs out of the box, yet every subsystem exposes DI-driven services so you can inject new behavior without rewriting the world.
4. **Operational Transparency** — Every tool has a documented entry point, logging is verbose when you need it, and the system favors explicit status over silent failure.
5. **Security & Provenance** — Validation, sandboxing, and audit trails are part of the lifecycle. Sharing an element should be safe for both sender and recipient.

---

## 3. How the Pieces Fit

| Layer | Responsibility | Key Files |
|-------|----------------|-----------|
| **MCP Server** | Serves model-context-protocol tools to clients (Claude, Gemini CLI). Coordinates handlers, DI container, and tool registration. | `src/index.ts`, `src/handlers/`, `src/server/tools/` |
| **Portfolio Management** | Loads and validates elements from disk, runs Enhanced Capability Index, handles GitHub sync. | `src/portfolio/`, `src/services/PortfolioManager.ts` |
| **Enhanced Capability Index** | Adds semantic search, verb triggers, relationship graphs, and diagnostics. | `src/portfolio/EnhancedIndexManager.ts`, `docs/architecture/enhanced-index-architecture.md` |
| **Collection Integration** | Installs from and submits to the community repository with validation gates. | `src/handlers/CollectionHandler.ts`, `src/server/tools/CollectionTools.ts` |
| **Tooling & Automation** | Scripts, tests, and docs that keep the ecosystem consistent. | `scripts/`, `tests/`, `docs/` |

Each component favors dependency injection (`src/di/Container.ts`) so services can be mocked in tests, replaced in custom deployments, or extended by contributors.

---

## 4. Who Uses DollhouseMCP and How

### Assistant Operators
- Install the server (`npm install @dollhousemcp/mcp-server`), run `npm run inspector` to see available tools.
- Use `install_collection_content`, `activate_element`, and `search_by_verb` to swap personas or skills mid-session.
- Sync personal changes to GitHub for backup (`sync_portfolio`) and submit highlights to the community (`submit_collection_content`).

### Developers Extending Functionality
- Create new element types or behaviors using guides in `docs/developer-guide/`.
- Wire services through the DI container, add handler coverage, and run the test suites (`npm test`, `npm run test:integration`, `npm run test:e2e`).
- Document workflows in `docs/` and update the Enhanced Index when adding discovery features.

### Core Contributors & Maintainers
- Track refactoring milestones in `REFACTORING-PLAN.md` and architectural decisions in `docs/architecture/`.
- Maintain dependency hygiene (pnpm/npm), security guardrails, and changelog discipline.
- Review community submissions for schema compliance and provenance.

---

## 5. Typical Journeys

1. **Bootstrap & Explore**
   - Read `docs/guides/getting-started.md`
   - Run the configuration wizard (`dollhouse_config action="wizard"`)
   - Install a persona (`install_collection_content "library/personas/creative-writer.md"`)

2. **Customize & Share**
   - Edit the persona locally (`edit_element`)
   - Validate (`validate_element`)
   - Sync to GitHub (`portfolio_element_manager operation="upload"`)
   - Submit to the community (`submit_collection_content`)

3. **Debug & Maintain**
   - Monitor `portfolio_status` and `get_relationship_stats`
   - Follow the [Day-2 Troubleshooting Guide](guides/troubleshooting.md) for long-term upkeep
   - Adjust Enhanced Index config (`~/.dollhouse/portfolio/.config/index-config.json`) to scale

---

## 6. Quick Reference Map

| Need context on… | Start with… |
|------------------|-------------|
| Installation, IAM, OAuth | `docs/guides/getting-started.md`, `docs/guides/oauth-setup.md` |
| Portfolio structure & sync | `docs/guides/portfolio-setup-guide.md`, `docs/guides/troubleshooting.md` |
| Element architecture | `docs/developer-guide/element-development.md`, `docs/architecture/element-architecture.md` |
| Enhanced Index internals | `docs/architecture/enhanced-index-architecture.md` |
| Contributor workflow | `CONTRIBUTING.md`, `docs/contributing.md` |
| Security posture | `SECURITY.md`, `docs/security/` |

---

## 7. Contributing Philosophy

- **Ship Confidence, Not Guesswork** — Every pull request pairs code with tests, documentation, and a clear rationale. Broken or undocumented behaviors are treated as bugs.
- **Traceability Matters** — Element changes belong in Git (local portfolio and GitHub). Discussions and reviews happen in issues/PRs to keep the audit trail intact.
- **Uptime by Default** — “Day 2” operations (troubleshooting, backups, index maintenance) are documented so anyone can recover the system without tribal knowledge.
- **Respect the Ecosystem** — Elements may run on a variety of MCP clients. Validate inputs defensively, avoid assumptions about client UX, and document side effects.

---

## 8. Next Steps

- New to the server? Start with [Getting Started](guides/getting-started.md) then brief your AI assistant using [AI Assistant Onboarding](guides/ai-assistant-onboarding.md).
- Building a capability? Consult the [Element Development guide](developer-guide/element-development.md) and align with the [Testing Strategy](developer-guide/testing-strategy.md).
- Maintaining deployments? Bookmark the [Day-2 Troubleshooting Guide](guides/troubleshooting.md) and keep an eye on [`CHANGELOG.md`](../CHANGELOG.md) for release notes.

DollhouseMCP is a refactoring-in-progress project. If something feels undocumented or unclear, raise an issue or propose a doc update—shared clarity is how we keep the ecosystem stable.
