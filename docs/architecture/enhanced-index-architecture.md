# Enhanced Capability Index (Developer Reference)

The Enhanced Capability Index powers semantic discovery inside DollhouseMCP. It maintains a persistent view of every element in the portfolio, adds NLP-derived relationships, and exposes verb-triggered lookups. This reference focuses on how the system is built today, how the code is organized, and what contributors need to know when extending it.

---

## Purpose & Responsibilities
- Persist a searchable catalog of portfolio elements in `~/.dollhouse/portfolio/capability-index.yaml`.
- Enrich raw element metadata with NLP scoring, verb triggers, and cross-element relationships.
- Serve MCP tools such as `find_similar_elements`, `get_element_relationships`, and `search_by_verb`.
- Provide developers with programmatic APIs for rebuilding, querying, and extending the index.

---

## Key Modules
- `src/portfolio/EnhancedIndexManager.ts` – orchestrates loading, rebuilding, and querying the index. Handles locking, caching, NLP scoring, relationship storage, and metrics.
- `src/portfolio/config/IndexConfig.ts` – central configuration (TTL, comparison limits, verb extraction settings). Persists overrides to `~/.dollhouse/portfolio/.config/index-config.json`.
- `src/portfolio/PortfolioIndexManager.ts` – supplies canonical element metadata gathered from the filesystem; EnhancedIndexManager consumes this as its source of truth.
- `src/portfolio/NLPScoringManager.ts` – calculates entropy/Jaccard scores and caches tokenization results.
- `src/portfolio/VerbTriggerManager.ts` – extracts verbs from element metadata and queries to map user intent to elements.
- `src/portfolio/RelationshipManager.ts` – builds and queries relationship graphs (similarity, dependencies, complements, etc.).
- `src/portfolio/types/IndexTypes.ts` – defines the YAML schema (metadata, elements, relationships, verb triggers).
- `src/handlers/EnhancedIndexHandler.ts` – MCP-facing façade that normalizes input, calls the manager, and formats textual responses with persona indicators.
- `src/server/tools/EnhancedIndexTools.ts` – registers MCP tool definitions and validates request payloads.

---

## High-Level Data Flow
```
Portfolio files (.md/.yaml)
        │
        ▼
PortfolioIndexManager.getIndex()
        │ element metadata (names, tags, triggers, content hash)
        ▼
EnhancedIndexManager.getIndex()
        │  ├─ TTL check & file lock
        │  ├─ Load existing capability-index.yaml (if fresh)
        │  └─ buildIndex() when missing/stale/forced
        ▼
EnhancedIndex (in-memory & on disk)
        │
        ├─ NLPScoringManager → semantic scores & keyword clusters
        ├─ VerbTriggerManager → verb → element mappings
        └─ RelationshipManager → graph edges & stats
```

### Build Lifecycle (`EnhancedIndexManager.getIndex`)
1. **Cache & TTL** – the manager keeps an in-memory copy (`this.index`). A TTL (default 5 minutes) controls when to rebuild or reload from disk.
2. **Locking** – `FileLock` serializes builds (`~/.dollhouse/portfolio/capability-index.yaml.lock`) to prevent concurrent writers.
3. **Portfolio Snapshot** – `PortfolioIndexManager` scans element files and produces `IndexEntry` objects with cleaned metadata, tags, triggers, and normalized content snippets.
4. **Element Definition** – `buildElementDefinition()` merges portfolio metadata with historical data (e.g., preserved custom fields) to produce an `ElementDefinition`.
5. **Verb Extraction** – the manager feeds definitions to `VerbTriggerManager` which normalizes verbs, applies taxonomy/synonyms, and writes to the `action_triggers` section.
6. **Semantic Relationships** – `NLPScoringManager` tokenizes content, calculates entropy/Jaccard scores, and `storeRelationship()` promotes similar pairs while respecting comparison limits from `IndexConfiguration`.
7. **Relationship Graph** – `RelationshipManager` materializes relationship arrays (e.g., `similar`, `complements`, `uses`) and can later compute connected components, shortest paths, and aggregate stats.
8. **Persistence** – if `config.index.persistToDisk` is true, `capability-index.yaml` is written atomically after the new structure is built. Memory caches and metrics timers are refreshed.

---

## Index Schema in Practice
The YAML file follows the contracts in `src/portfolio/types/IndexTypes.ts`:

- `metadata` – version, timestamps, element counts. Custom metadata is preserved on rebuild.
- `elements[type][name]` – each entry contains:
  - `core` identity (name, type, version, description, timestamps).
  - `search` optimizers (keywords, tags, triggers).
  - `actions` verb-trigger definitions (`ActionDefinition`), with confidence scores.
  - `use_when` patterns for conditional activation.
  - `relationships` grouped by type (similar/complements/etc.) with strength metadata.
  - `semantic` metrics (entropy bands, keyword vectors, concept tags).
  - `custom` / `extensions` buckets reserved for caller-defined properties.
- `action_triggers` – verb → array of `type/name` identifiers.
- `scoring` – optional weight/threshold overrides that downstream tooling can respect.
- `extensions` – free-form section for future features.

When adding new fields, update `ElementDefinition` or related types and ensure both `buildElementDefinition` and serialization logic maintain them. Tests under `tests/unit/portfolio/EnhancedIndexManager.*.test.ts` expect backward-compatible behavior.

---

## Working with the Manager
The public methods on `EnhancedIndexManager` cover the main developer workflows:

| Method | When to Use |
|--------|-------------|
| `getIndex(options?: IndexOptions)` | Load or rebuild the index. Supports `forceRebuild`, `updateOnly`, `includeInactive`, and `preserveCustom` flags. |
| `updateElements(elementNames: string[], options?: IndexOptions)` | Rebuild subset entries after an element changes; respects locking and custom field preservation. |
| `addRelationship(elementId, relationship)` | Attach cross-element metadata programmatically. |
| `addExtension(key, data)` / `persist()` | Store custom data and flush the index to disk. |
| `getElementsByAction(verb)` | Returns elements mapped to a verb trigger. |
| `searchEnhanced({...})` | Combined keyword/semantic search for consumers that need more than the MCP tools provide. |
| `getConnectedElements(elementId, { maxDepth, relationshipTypes, minStrength })` | Graph traversal used by `find_similar_elements`. |
| `findElementPath(from, to, options)` | Shortest path resolution between elements (leverages `RelationshipManager`). |
| `getElementRelationships(elementId)` | Raw relationship map, used by `get_element_relationships`. |
| `getRelationshipStats()` | Aggregated counts by relationship type for diagnostics. |
| `getTriggerMetrics()` / `exportMetrics()` | Verb extraction telemetry and Prometheus/CSV/JSON exports. |
| `clearMemoryCache()` / `cleanup()` | Helpers for tests to reset state and remove stale resources. |

All element identifiers use the canonical `type/name` format and are normalized through `parseElementId*` utilities. When extending the API, prefer these helpers to avoid path bugs.

---

## MCP Tool Surface
`src/handlers/EnhancedIndexHandler.ts` adapts the manager for client requests. It validates Unicode, normalizes parameters, and formats output with persona indicators. The corresponding MCP tools are registered in `src/server/tools/EnhancedIndexTools.ts`:

- `find_similar_elements`
- `get_element_relationships`
- `search_by_verb`
- `get_relationship_stats`

When adding new developer-facing capabilities, implement the logic in the handler first, then expose it through a new tool definition (adding schema validation and documentation). Update `docs/reference/api-reference.md` to keep the public surface current.

---

## Configuration & Tuning
- Defaults live in `IndexConfigManager.defaultConfig`.
- Runtime config is loaded from `~/.dollhouse/portfolio/.config/index-config.json` if present. This file survives rebuilds and is safe to edit manually or via tooling.
- Important knobs:
  - `index.ttlMinutes`, `index.persistToDisk`, `index.lockTimeoutMs`.
  - `performance.maxSimilarityComparisons`, `performance.similarityThreshold`, `performance.defaultSimilarLimit`.
  - `verbs.confidenceThreshold`, `verbs.maxElementsPerVerb`.
  - `memory.maxCacheSize`, `memory.cleanupIntervalMinutes`.
- Changes take effect the next time `EnhancedIndexManager` is constructed (restart the server or use dependency injection to refresh the container in tests). Avoid committing local config overrides into the repository or CI.

---

## Development Tips
- **Rebuilding during development** – call `getIndex({ forceRebuild: true })` or `updateElements([...])` inside tests/fixtures to regenerate the YAML. Integration tests in `tests/e2e/portfolio-roundtrip.test.ts` show how the manager behaves end-to-end.
- **Verb taxonomy adjustments** – edit `VERB_TAXONOMY` in `VerbTriggerManager.ts` or load custom verbs via configuration. Ensure you update unit tests (`EnhancedIndexManager.extractActionTriggers.test.ts`) to cover new groups.
- **Adding relationship types** – extend `RelationshipTypes` in `src/portfolio/types/RelationshipTypes.ts` and update both `RelationshipManager` and any visualization tooling. Provide migration paths if serialized YAML adds new keys.
- **Performance safeguards** – respect comparison limits and batching constants sourced from `IndexConfiguration`. When experimenting, prefer local config overrides rather than hard-coded tweaks.
- **Security logging** – the handler and managers call `SecurityMonitor` for notable events. Keep those hooks intact when modifying verb extraction or index builds.
- **Memory management** – long-lived processes rely on `startMemoryCleanup()` to release caches. If you introduce new in-memory stores, add them to the cleanup cycle.

---

## Testing & Troubleshooting
- Core unit coverage lives under `tests/unit/portfolio/`:
  - `EnhancedIndexManager.test.ts` – rebuilds, caching behavior, file locking.
  - `EnhancedIndexManager.extractActionTriggers.test.ts` / `.telemetry.test.ts` – verb extraction and metrics.
  - `NLPScoringManager.test.ts` – scoring calculations and caching semantics.
  - `RelationshipManager.test.ts` – graph traversal routines.
- Integration scenarios:
  - `tests/integration/handlers/PortfolioPullHandler.integration.test.ts` verifies rebuilds during portfolio pulls.
  - `tests/e2e/portfolio-roundtrip.test.ts` exercises GitHub sync plus index regeneration in a sandbox.
- When local runs diverge from CI, check for an existing `~/.dollhouse/portfolio/.config/index-config.json` overriding defaults. Temporarily move or rename it to reproduce CI behavior.
- The YAML file can be inspected directly during debugging. Use `dollhouse_config action="get"` and `get_relationship_stats` to confirm runtime state without editing files manually.

---

## Extending the System
1. **Prototype with Tests First** – create or adapt unit tests under `tests/unit/portfolio` to capture the behavior you need.
2. **Update Types** – extend `IndexTypes` or related interfaces before touching the manager logic to maintain compile-time guarantees.
3. **Adjust the Manager** – implement the behavior in `EnhancedIndexManager`, `VerbTriggerManager`, or `RelationshipManager`, keeping concurrency and lock semantics in mind.
4. **Expose via Handler** – surface new functionality through `EnhancedIndexHandler` and register MCP tools if the capability should be user-facing.
5. **Document** – update this reference and `docs/reference/api-reference.md` to describe new workflows.

This approach keeps the Enhanced Capability Index maintainable and ensures contributors understand how their changes interact with the broader DollhouseMCP platform.
