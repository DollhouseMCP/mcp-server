# Capability Index System – Current Architecture Guide

**Last Updated:** October 2025  
**Owners:** Core platform team  
**Code References:**  
- `src/portfolio/EnhancedIndexManager.ts` – index builder & persistence  
- `src/portfolio/VerbTriggerManager.ts` – verb/action mapping  
- `src/portfolio/RelationshipManager.ts` – relationship discovery  
- `src/handlers/EnhancedIndexHandler.ts` – MCP tooling facade  
- `src/server/tools/EnhancedIndexTools.ts` – registered MCP tools  

---

## 1. Executive Summary

The Capability Index System is the semantic discovery layer that powers:

- **Verb-based activation** through `action_triggers` (e.g., “debug” → personas/debug-detective).  
- **Cross-element relationships** surfaced via `find_similar_elements` and `get_element_relationships`.  
- **Unified search enrichment** by supplying semantic weights and duplicate detection to `search_all`.

The system is fully integrated into the server lifecycle: each startup (or on-demand rebuild) produces `~/.dollhouse/portfolio/capability-index.yaml`. All Enhanced Index MCP tools draw from this file.

---

## 2. Data Model

`EnhancedIndexManager` persists a YAML document with the following top-level schema (`src/portfolio/types/IndexTypes.ts`):

```yaml
metadata:
  version: "2.0.0"
  created: "2025-09-21T10:00:00.000Z"
  last_updated: "2025-10-08T18:45:00.000Z"
  total_elements: 128

action_triggers:
  debug:
    - personas/debug-detective
    - skills/error-triage
  explain:
    - personas/eli5-explainer
    - skills/docs-clarifier

elements:
  personas:
    debug-detective:
      core:
        name: Debug Detective
        type: personas
        version: 1.4.2
        description: Root-cause analysis persona
      search:
        keywords: ["debug", "diagnose", "stack trace"]
        tags: ["engineering", "analysis"]
        triggers: ["debug", "fix", "crash"]
      actions:
        debug:
          description: Activate for runtime error analysis
          confidence: 0.92
      relationships:
        similar:
          - element: personas/stack-trace-sleuth
            strength: 0.78
  skills:
    markdown-formatter:
      core:
        name: Markdown Formatter
        type: skills
        version: 2.0.0
      search:
        keywords: ["markdown", "format", "docs"]

context:
  keywords:
    debug: { frequency: 42, recency: "2025-10-07T22:10:00Z" }
  relationships:
    personas/debug-detective:
      used_with:
        skills/error-triage: 12
        skills/log-analyzer: 6
```

### Key Fields

| Field | Purpose | Source |
|------|---------|--------|
| `metadata` | Versioning & analytics | `EnhancedIndexManager` |
| `action_triggers` | Verb → element map | `VerbTriggerManager.extractActionTriggers()` |
| `elements.<type>.<slug>.core` | Authoritative identity | Portfolio index entries |
| `search` | Tokens for keyword/trigger matching | Frontmatter metadata + heuristics |
| `actions` | Explicit verb behavior overrides | Element metadata or generated defaults |
| `relationships` | Similarity/dedup graph | `RelationshipManager.discoverRelationships()` |
| `context` | Usage telemetry for weighted suggestions | `EnhancedIndexManager` runtime updates |

---

## 3. Component Architecture

```
┌────────────────────────────────────────────────────────┐
│ EnhancedIndexManager                                   │
│  - Owns build lifecycle & file persistence             │
│  - Coordinates NLP, triggers, relationships            │
│  - Enforces TTL & locking                              │
└───────────────┬─────────────────────────────┬──────────┘
                │                             │
                ▼                             ▼
    ┌─────────────────────┐        ┌────────────────────┐
    │ PortfolioIndexMgr   │        │ VerbTriggerManager │
    │  - Source of truth  │        │  - Verb taxonomy   │
    │  - Element metadata │        │  - Duplicate guard │
    └─────────────────────┘        └────────────────────┘
                │                             │
                ▼                             ▼
    ┌─────────────────────┐        ┌────────────────────┐
    │ NLPScoringManager   │        │ RelationshipManager │
    │  - Jaccard + entropy│        │  - Pattern edges    │
    │  - Result caching   │        │  - Inverse rels     │
    └─────────────────────┘        └────────────────────┘
```

### Integration Points

- **DI Container** (`src/di/Container.ts`) registers `EnhancedIndexManager`, injects dependencies, and exposes `EnhancedIndexHandler`.
- **MCP Tools** (`src/server/tools/EnhancedIndexTools.ts`) register:
  - `find_similar_elements`
  - `get_element_relationships`
  - `search_by_verb`
  - `get_relationship_stats`
- **Unified Search** (`PortfolioHandler.searchAll`) receives semantic scores and duplicate hints from `UnifiedIndexManager`, which consumes the Enhanced Index metadata.

---

## 4. Build Pipeline

1. **Trigger** – Called lazily by handlers or proactively via `forceRebuild`. TTL defaults to 15 minutes (`IndexConfigManager`).
2. **File Lock** – `FileLock` prevents concurrent writes (60s timeout, stale detection).
3. **Portfolio Snapshot** – `PortfolioIndexManager.getIndex()` returns normalized entries grouped by element type.
4. **Element Definition Build** – `buildElementDefinition()` copies core metadata, keywords, tags, and any existing custom/relationship data.
5. **Trigger Extraction** – `extractActionTriggers()` merges explicit triggers, inferred verbs, and taxonomy-driven synonyms while capping duplicates.
6. **Semantic Scoring** – `calculateSemanticRelationships()` invokes `NLPScoringManager` with adaptive sampling (full matrix ≤20 elements, sampled beyond that).
7. **Relationship Discovery** – `RelationshipManager` finds complementary, extends/uses, and duplicate relationships.
8. **Context Aggregation** – Usage telemetry (frequency, recency) refreshed when available.
9. **Persist** – YAML is normalized, Unicode-validated, and written to `~/.dollhouse/portfolio/capability-index.yaml`.

Rebuilds log telemetry through `SecurityMonitor` with event type `PORTFOLIO_CACHE_INVALIDATION`.

---

## 5. Runtime Usage

| Scenario | How the Index is Used |
|----------|-----------------------|
| `find_similar_elements` | Reads relationships + semantic scores to rank results. |
| `get_element_relationships` | Returns raw relations for the chosen element, filtered by type. |
| `search_by_verb` | Consults `action_triggers` map and verb taxonomy to recommend elements. |
| `get_relationship_stats` | Summarizes counts, top connected nodes, cache health. |
| Unified search | Annotates `search_all` responses with match type (`name`, `keywords`, `trigger`) and duplicate/version conflict warnings. |

Handlers prepend persona indicators via `IndicatorService` so responses remain consistent with the active persona banner.

---

## 6. Performance & Limits

- **Full rebuild (100 elements):** ~4–6 seconds.  
- **Cache TTL:** 15 minutes (configurable via `IndexConfigManager`).  
- **LRU caches:**  
  - Semantic result cache (`maxSize: 200`, 15 MB)  
  - Index snapshot cache (`maxSize: 100`, 20 MB)  
- **Trigger Safety:** Duplicate and length guard rails prevent >50 triggers per element and reject suspicious Unicode via `UnicodeValidator`.

---

## 7. Maintenance Tasks

1. **Adding new element metadata fields:** Update `buildElementDefinition()` and corresponding schema in `IndexTypes.ts`.  
2. **Verb taxonomy changes:** Edit `VerbTriggerManager` taxonomy & extraction heuristics; adjust tests in `tests/unit/portfolio/VerbTriggerManager.test.ts`.  
3. **Relationship tuning:** `RelationshipManager` holds heuristics for complementary/extends/duplicate detection—adjust thresholds and update regression tests.  
4. **Config tweaks:** `IndexConfigManager` exposes YAML for TTL, lock timeout, semantic sampling limits.  
5. **Telemetry ingestion:** (Optional) Implement sending `reportTelemetry()` payloads if external monitoring is desired.

---

## 8. Future Enhancements

- **Incremental Rebuilds:** Track touched files and rebuild partial sections instead of the whole index.  
- **Capability summaries:** Persist human-readable capability descriptions alongside triggers for richer context injection.  
- **Historical metrics:** Persist usage analytics over time (currently an in-memory map).  
- **Collection integration:** Store community index snapshots locally to reduce cold-start latency when searching the collection.

---

## 9. Related Resources

- `docs/architecture/enhanced-index-architecture.md` – Component-level deep dive and performance analysis.  
- `docs/architecture/unified-capability-index.md` – Trigger taxonomy, element definition strategy, and context usage guidelines.  
- `docs/developer-guide/adding-elements.md` – Required checklist when introducing new element types (ensure triggers/keywords are populated).  
- `tests/integration/memories/memory-enhanced-index.test.ts` – Example integration tests validating trigger propagation.
