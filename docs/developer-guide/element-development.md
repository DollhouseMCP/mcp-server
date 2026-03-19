# Element Architecture Guide

This guide explains how element files map to the TypeScript implementation inside DollhouseMCP. Use it when you need to debug an existing element type, add custom metadata, or introduce a new kind of element.

> **Examples:** For complete, working element files, browse the [community collection](https://github.com/DollhouseMCP/collection/tree/main/library) or use `install_collection_content` to download example personas, skills, and templates.

---

## 1. Element Anatomy on Disk

The portfolio lives under `~/.dollhouse/portfolio/`, one subdirectory per `ElementType` (`src/portfolio/types.ts`).

```
~/.dollhouse/portfolio/
├── personas/    *.md (Markdown + YAML frontmatter)
├── skills/      *.md
├── templates/   *.md
├── agents/      *.md  + .state/ for runtime data
├── memories/    YYYY-MM-DD/*.yaml
└── ensembles/   *.md  (reserved; limited support today)
```

`PortfolioManager` (`src/portfolio/PortfolioManager.ts`) owns the directory layout and enforces file extensions. All managers resolve paths through it instead of touching the filesystem directly.

Every Markdown-backed element follows the same pattern:

```markdown
---
name: helpful-coder
description: A TypeScript-focused assistant
type: skill
author: jane
version: 1.2.0
tags: [typescript, refactoring]
---

# Helpful Coder

Instructions or body content…
```

Memories are pure YAML (`src/elements/memories/Memory.ts` documents the schema).

---

## 2. Core Types and Interfaces

All element classes implement `IElement` from `src/types/elements/IElement.ts`. Key pieces:

- **Identity**: `id`, `type`, `version`
- **Metadata**: `IElementMetadata` (name, description, tags, author, timestamps, custom fields)
- **References**: linking to other elements or external resources
- **Ratings & feedback**: `ElementRatings`, `UserFeedback` support telemetry and quality tracking
- **Lifecycle hooks**: optional `beforeActivate`, `activate`, `afterActivate`, `deactivate`
- **Serialization**: `serialize()` returns frontmatter + content; `deserialize()` repopulates fields

Statuses are tracked via `ElementStatus` (`inactive`, `activating`, `active`, etc.) and surfaced in UI responses.

---

## 3. BaseElement and Shared Behavior

`BaseElement` (`src/elements/BaseElement.ts`) provides the default implementation for:

- Generating stable IDs and normalizing versions
- Metadata hydration (including default timestamps and tag arrays)
- Unicode normalization and sanitisation (via `UnicodeValidator` and `sanitizeInput`)
- Reference validation and shared error reporting (`ElementValidationResult`)
- Feedback tracking (`receiveFeedback`, capped histories)
- YAML serialization using `gray-matter`

Subclass constructors typically extend the metadata structure (e.g., `SkillMetadata`, `PersonaElementMetadata`) before calling `super`.

---

## 4. Element Managers

All CRUD operations flow through `BaseElementManager<T>` (`src/elements/base/BaseElementManager.ts`). The class implements:

- Atomic file IO via `FileLockManager` to avoid races
- Path validation / sanitisation
- Markdown parsing with `gray-matter`
- Caching (`Map` of ID → element) for repeated calls
- Lifecycle logging and security auditing

Subclasses override three hooks:

1. `parseMetadata(frontmatter)` – translate YAML frontmatter into typed metadata.
2. `createElement(metadata, content)` – instantiate the concrete element class.
3. `serializeElement(element)` – generate Markdown or YAML for persistence.

Current managers live under `src/elements/*/*Manager.ts`:

- `SkillManager`
- `TemplateManager`
- `AgentManager`
- `MemoryManager`
- Persona management uses `PersonaManager` (`src/persona/PersonaManager.ts`), which wraps `PersonaElementManager` to handle legacy structures and attribution.

Managers are registered in the DI container (`src/di/Container.ts`) and injected into handlers.

---

## 5. Type-Specific Implementations

| Type | Primary class | Notes |
|------|---------------|-------|
| Personas | `src/persona/PersonaElement.ts` | Markdown content plus metadata like `triggers`, `category`, `age_rating`. Legacy compatibility helpers convert to/from the historical persona schema. |
| Skills | `src/elements/skills/Skill.ts` | Adds parameter definitions, examples, and runtime parameter storage with size limits. |
| Templates | `src/elements/templates/Template.ts` | Wraps structured sections (`metadata.variables`, `TemplateRenderer`) for `render_template`. |
| Agents | `src/elements/agents/Agent.ts` | Stores playbooks, goal templates, and risk metadata. Supports state persistence under `agents/.state/`. |
| Memories | `src/elements/memories/Memory.ts` | YAML entries grouped by date, used by `MemoryManager` and `MemorySearchIndex`. |
| Ensembles | Reserved in enums/config (`ElementType.ENSEMBLE`) but not fully implemented; adding one requires the new-type checklist. |

Each element class overrides `validate()` to enforce domain rules (e.g., personas require non-empty content, skills validate parameter definitions). When you extend metadata or runtime behavior, capture validation logic alongside it.

---

## 6. Handlers and MCP Tools

The server exposes element operations through two primary handlers:

- `PersonaHandler` (`src/handlers/PersonaHandler.ts`) – persona-specific install/export flows.
- `ElementCRUDHandler` (`src/handlers/ElementCRUDHandler.ts`) – generic list/create/edit/validate/delete across skill/template/agent/memory types. It orchestrates the managers, template rendering, and indicator output.

MCP tool definitions live in `src/server/tools/ElementTools.ts` and `src/server/tools/PersonaTools.ts`. Adding a new capability usually means:

1. Implement the logic in the relevant handler.
2. Register a tool definition that validates input and calls the handler.
3. Document the tool in `docs/reference/api-reference.md`.

---

## 7. Portfolio, Sync, and Index Integration

- **PortfolioManager** ensures directory creation, default element population, and migration of legacy layouts (`src/portfolio/PortfolioManager.ts`).
- **PortfolioIndexManager** & **EnhancedIndexManager** build the capability index (`docs/architecture/enhanced-index-architecture.md`). When elements change, managers call `EnhancedIndexManager.updateElements()` to refresh relationships and verb triggers.
- **PortfolioHandler** exposes sync operations (`portfolio_element_manager`, `sync_portfolio`). Managers don’t talk directly to GitHub; they provide clean file operations and metadata so sync tooling can do the rest.
- **CollectionHandler** uses the same managers to install from or submit to the community collection while validating schemas.

Keep these integrations in mind when you alter serialization or metadata fields: Enhanced Index and sync flows rely on stable schemas.

---

## 8. Extending Elements Safely

When you add behavior or metadata:

1. **Update types** – extend the relevant `*Metadata` interface and `IElementMetadata` if the field should be general.
2. **Adjust serializers** – make sure both `serializeElement()` and `parseMetadata()` persist the new fields symmetrically.
3. **Wire through the DI container** – if you add a new manager or service, register it in `src/di/Container.ts`.
4. **Expose optional tooling** – extend handlers or MCP tools if users need to edit/inspect the new data.
5. **Update Enhanced Index integration** – ensure `PortfolioIndexManager` and `EnhancedIndexManager` understand the new field when computing keywords, relationships, or verb triggers.

Follow the [Adding New Element Types](adding-elements.md) playbook if you introduce an entirely new element category. It covers enum updates, config entries, DI wiring, and test expectations.

---

## 9. Testing & Validation Checklist

- Unit tests live under `tests/unit/elements/` and `tests/unit/portfolio/`. Mirror existing patterns for new logic.
- Use `validate_element` (MCP tool) during manual QA to ensure serialization output is valid YAML/Markdown.
- When touching persona flows, update fixtures under `tests/fixtures/personas/`.
- After major schema changes, run `npm run test:integration` (covers Enhanced Index rebuilds, persona install flows) and `npm run test:e2e` if sync behavior is affected.

---

## 10. Related Documents

- [Adding New Element Types](adding-elements.md)
- [Manual Element Construction](manual-element-construction.md)
- [Enhanced Capability Index Architecture](../architecture/enhanced-index-architecture.md)
- [Day-2 Troubleshooting Guide](../guides/troubleshooting.md)

Keep this guide in sync with the codebase. If you spot drift between the documentation and `src/`, update both immediately—element regressions tend to cascade into sync and discovery features.***
