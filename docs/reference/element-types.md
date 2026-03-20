# Element Types Reference

Element type metadata is centralized in `src/config/element-types.ts`. This file drives directory names, MCP exposure, icons, and descriptions. Update that config (and the `ElementType` enum in `src/portfolio/types.ts`) whenever you introduce a new type.

> **Element Interface:** All elements implement the `IElement` interface defined in `src/types/elements/IElement.ts`. See [Element Architecture](../architecture/element-architecture.md) for details on the storage vs runtime pattern.

---

## Current Types

| Element Type | Directory | MCP Tools Available? | Description |
|--------------|-----------|----------------------|-------------|
| Personas | `personas/` | ✅ | Behavioral profiles that change how the assistant communicates and makes decisions. |
| Skills | `skills/` | ✅ | Discrete capabilities (e.g., code review, drafting emails) often used alongside personas. |
| Templates | `templates/` | ✅ | Markdown/structured outputs with placeholders for quick content generation. |
| Agents | `agents/` | ✅ | Goal-oriented actors with optional state (`agents/.state/`) and orchestration logic. |
| Memories | `memories/` | ✅ | Persisted knowledge or session context, stored as `.yaml` files. Managed through the same Element tools (list, create, edit, delete). |
| Ensembles | `ensembles/` | ✅ | Collections of elements (personas, skills, templates, agents, memories) that work together as a unified system. Supports multiple activation strategies and conflict resolution modes. |

> **MCP support** is controlled by the `mcpSupported` flag in the config. When false, the type remains usable locally but is hidden from generic MCP tools.

---

## Where It’s Used

- `ELEMENT_TYPE_CONFIG` (`src/config/element-types.ts`) — source of truth for plural forms, directories, icons, descriptions, and MCP availability.
- `ElementType` enum (`src/portfolio/types.ts`) — type-safe identifiers shared across managers, handlers, and tools.
- `PortfolioManager` — uses the config to create directories and resolve file extensions.
- `ElementCRUDHandler` — wires managers for MCP CRUD operations based on the types registered in the DI container.
- `CollectionHandler` / `CollectionInstaller` — filters collection content based on the MCP-supported list.

When you add a new type:

1. Extend the `ElementType` enum.
2. Add an entry to `ELEMENT_TYPE_CONFIG`.
3. Implement the element class/manager and register them in `src/di/Container.ts`.
4. Update handlers or tools if the new type needs bespoke behavior.
5. Add tests and docs (see [Adding New Element Types](../developer-guide/adding-elements.md)).

---

## Directory Snapshot

```
~/.dollhouse/portfolio/
├── personas/
├── skills/
├── templates/
├── agents/
│   └── .state/
├── memories/
│   └── .storage/   (optional; depends on implementation)
└── ensembles/
```

All directories are created during `PortfolioManager.initialize()`. Custom portfolios can override the base directory via `DOLLHOUSE_PORTFOLIO_DIR` or the configuration wizard.

---

## Common Metadata Fields

All element types support a set of common metadata fields. Some fields have validation rules to ensure consistency and security.

### Triggers

Triggers are keywords that help AI assistants discover and activate elements based on context. They are optional but recommended for discoverability.

**Validation Rules:**
- Maximum 20 triggers per element
- Maximum 50 characters per trigger
- Allowed characters: `a-z`, `A-Z`, `0-9`, `-`, `_`, `@`, `.`

**Valid Examples:**
| Trigger | Use Case |
|---------|----------|
| `code-review` | Kebab-case keywords |
| `bug_fix` | Snake_case keywords |
| `@username` | Social media mentions |
| `user@example.com` | Email addresses |
| `api.docs` | Domain-style patterns |
| `v2.0` | Version numbers |

**Invalid Examples (Rejected):**
| Trigger | Reason |
|---------|--------|
| `bad!trigger` | Shell metacharacter `!` |
| `cmd;injection` | Shell metacharacter `;` |
| `$(evil)` | Command substitution pattern |
| `with spaces` | Spaces not allowed |
| `<script>` | HTML/XML characters |

**Security Note:** The `@` and `.` characters are intentionally allowed because they are NOT shell metacharacters and enable common use cases like mentions, email addresses, and domain patterns. Shell metacharacters (`!`, `;`, `$`, `(`, `)`, `|`, `&`, `` ` ``) are rejected to prevent command injection.

### Other Common Fields

| Field | Max Length | Required | Description |
|-------|------------|----------|-------------|
| `name` | 100 | Yes | Display name for the element |
| `description` | 500 | No | Brief explanation of purpose |
| `author` | 100 | No | Creator or maintainer |
| `version` | 20 | No | Semantic version (e.g., `1.0.0`) |
| `category` | 50 | No | Grouping category |
| `tags` | 50 each | No | Array of searchable tags |

---

Keep this reference in sync with the codebase whenever you introduce new element types or change their capabilities.
