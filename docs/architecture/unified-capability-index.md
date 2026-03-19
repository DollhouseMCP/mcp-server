# Unified Capability Index – Trigger & Context Design

**Purpose:** Document the conventions for the generated `capability-index.yaml` so trigger quality, semantic discovery, and context injection remain consistent across element types.

**Audience:** Element authors, reviewers, and engineers extending the Enhanced Index.

---

## 1. Overview

While `capability-index-system.md` explains the build pipeline, this document focuses on the **content strategy** of the index—how we select verbs, structure element definitions, and consume the data during MCP sessions.

The index is the bridge between user intent (“debug this test failure”) and the element set that can help. High-quality triggers, concise metadata, and meaningful relationships directly influence MCP tool accuracy.

---

## 2. Trigger Strategy (`action_triggers`)

`action_triggers` is a hash map: `verb` → `Array<elementId>`. IDs follow `<type>/<slug>` (e.g., `personas/debug-detective`).

### Principles

1. **Action verbs only.** Prefer *debug*, *explain*, *refactor* over nouns like *debugger* or *analysis*.  
2. **Few, high-signal entries.** Target 3–5 verbs per element; duplicates are automatically filtered.  
3. **Consistency with taxonomy.** Use taxonomy buckets in `VerbTriggerManager` as anchors to avoid drift.  
4. **No filler verbs.** Skip vague terms (“do”, “help”, “assist”).  
5. **Unicode hygiene.** Inputs pass through `UnicodeValidator`; avoid fancy quotes/emojis in triggers.

### Author Guidance

- **Personas:** Add a `triggers` array in frontmatter (e.g., `triggers: ["debug", "diagnose"]`).  
- **Skills/Templates:** Use tags/keywords instead; the extraction step maps synonyms automatically.  
- **Memories:** Provide task-specific verbs (“recall”, “lookup”) only if the memory encodes operational steps.

---

## 3. Element Definitions (`elements.*`)

Every indexed element gets a `core`, `search`, and optional `actions`/`relationships` block.

### `core`

| Field | Requirement | Notes |
|-------|-------------|-------|
| `name` | Required | Must match metadata name. |
| `type` | Required | One of `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles`. |
| `version` | Recommended | Pulled from `metadata.version` (supports fallback). |
| `description` | Recommended | Keep under ~200 characters for quick scanning. |

### `search`

- **Keywords:** List of literal tokens; influences name/keyword match scoring.  
- **Tags:** High-level categorization.  
- **Triggers:** Copy of verb triggers sourced from metadata or heuristics.

### `actions`

Overrides or supplements verb mappings with richer metadata:

```yaml
actions:
  debug:
    description: Activate persona for stack trace triage
    confidence: 0.92         # optional tuning hook
    examples:
      - "debug \"TypeError: cannot read properties\""
```

Use this when the element has a narrow specialization or requires guidance (e.g., memory retrieval steps).

### `relationships`

`RelationshipManager` stores links such as `similar`, `complements`, `extends`, `requires`. Manual overrides are allowed but uncommon—most entries are generated.

---

## 4. Context Tracking (`context`)

The optional `context` block tracks keyword frequency/recency and co-usage counts. Downstream features can leverage this to:

- Bias search results toward elements used in the current session.  
- Recommend companion elements (`used_with`) when activating personas or skills.  
- Trim rarely used triggers during cleanups.

Example:

```yaml
context:
  keywords:
    refactor: { frequency: 18, recency: "2025-10-07T16:50:00Z" }
  relationships:
    personas/debug-detective:
      used_with:
        skills/log-analyzer: 4
        skills/test-runner: 3
```

---

## 5. Consuming the Index

| Consumer | Behavior |
|----------|----------|
| `search_by_verb` MCP tool | Looks up the verb, resolves to element IDs, ranks results by confidence + relationship strength. |
| `find_similar_elements` | Utilizes `relationships` and semantic scores to produce sorted matches. |
| Unified search (`search_all`) | Annotates hits as name/keyword/trigger matches and surfaces duplicate/version conflicts. |
| UI/CLI surfaces (future) | Can present triggers as quick actions or provide tooltips using `actions` descriptions. |

---

## 6. Quality Checklist for New Elements

Before merging a new element, confirm:

- [ ] Metadata contains a concise description.  
- [ ] Tags/keywords reflect the real use-case.  
- [ ] Persona frontmatter includes explicit `triggers` when appropriate.  
- [ ] Memory entries supply enough structure for trigger extraction (see `tests/unit/MemoryManager.triggers.test.ts`).  
- [ ] Tests covering the element ensure Enhanced Index rebuilds capture the new metadata (unit or integration).

---

## 7. Maintaining Trigger Health

1. **Audit regularly:** Run `npm test -- tests/unit/portfolio/VerbTriggerManager.test.ts` when modifying taxonomy.  
2. **Review duplicates:** `get_relationship_stats` flags top verbs and heavily connected elements; prune where needed.  
3. **Measure coverage:** Scripted checks (future) can warn when verbs map to no elements.  
4. **Handle renames:** Ensure element slugs stay stable; otherwise rebuilds will populate new IDs and leave the old ones orphaned (pair with migration scripts if needed).

---

## 8. Future Improvements

- **Capability summaries:** Capture short prose per capability and surface them alongside verb results.  
- **Persona bundles:** Allow actions to specify multi-element activation sequences (persona + supporting skills).  
- **Adaptive pruning:** Use `context` telemetry to demote stale triggers automatically.

---

## 9. Related Documentation

- `docs/architecture/capability-index-system.md` – Build pipeline and component responsibilities.  
- `docs/architecture/enhanced-index-architecture.md` – Performance analysis and stabilization notes.  
- `docs/developer-guide/adding-elements.md` – Frontmatter metadata and trigger expectations when introducing new element types.  
- `tests/integration/memories/memory-enhanced-index.test.ts` – Example ensuring memory triggers reach the index.
