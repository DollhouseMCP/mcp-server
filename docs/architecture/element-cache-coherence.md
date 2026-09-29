# Element Cache Coherence: Architecture Design

**Status:** reconciled draft for decision (2026-09-29). Todd's freshness and cache architecture is combined here with the merged storage contracts on beta `1ac2d9fdeb5814a4dc3c889f8ac2d263f5a7b3cc`. This is a design document, not runtime wiring, a migration plan, or activation authorization. Adopted composition does not answer the open AD/PD/scope choices in §15.
**Scope:** all six element types and both database and filesystem storage. Memory persistence delegates the existing contracts; it does not establish a second owner, lock, mutation or archive protocol.
**Issues:** [#2799](https://github.com/DollhouseMCP/mcp-server/issues/2799), [#2801](https://github.com/DollhouseMCP/mcp-server/issues/2801), and the authoritative shared memory gates [#2870](https://github.com/DollhouseMCP/mcp-server/issues/2870) / [#2871](https://github.com/DollhouseMCP/mcp-server/issues/2871).
**Evidence:** the activation/policy/TTL/delete and merged memory-contract findings listed in §11 were source-checked on this beta tree. The wider caller inventory is retained from Todd's earlier `77d2120c` analysis and must be revalidated in each implementing slice. V labels that inherited source observation, not a claim that every row was independently reproduced/rechecked on this base; H remains a hypothesis. The selective-eviction attempt on `archive/2799-selective-eviction-attempt` is reference material only, with acceptance scenarios retained. [#2867](https://github.com/DollhouseMCP/mcp-server/pull/2867) and [#2806](https://github.com/DollhouseMCP/mcp-server/pull/2806) are merged; [#2868](https://github.com/DollhouseMCP/mcp-server/pull/2868) remains draft and supplies no activation authority.

---

## Reading guide

| Label | Meaning |
|---|---|
| **V** / **H** | Claim verified by reading the code at the stated base / hypothesis not yet verified |
| **F1–F6, I1–I3, X1** | Freshness, isolation and replica requirements (§4) |
| **P1–P5** | Performance targets, measured as counts (§4.1) |
| **FM1–FM28** | Failure modes the design must close (§6) |
| **D1–D14** | Design decisions with their recommendations (§8) |
| **AD1–AD9, PD1–PD8, S1–S3** | Open architecture, product and scope decisions, with status rows (§15) |
| **Track A / foundations** | Early live correctness fixes vs. dormant foundations in bite-sized beta PRs (§14.1) |
| **legacy / authoritative / versioned** | The three coherence modes (§9.11) |
| **Track A** | Early activation, live policy, bridge export and DB auto-load fixes (§14.1) |
| **Delivery slices** | Independently reviewed milestones (§14.2) |
| **dormant foundations–cleanup** | Historical labels superseded by the bite-sized delivery plan (§14) (§14.1) |

**Glossary.**
- **Write receipt:** exact backend-specific committed result. Cache publication consumes it; memory tokens/archive receipts preserve existing commit/unknown semantics (§9.2/§10.5).
- **Deadlock relief:** the `release_deadlock` recovery operation, which lifts active-element restrictions when they block the operations needed to change them.
- **Shared pool:** deployment-shipped public elements installed for all users (`SharedPoolInstaller`).
- **stdio vs multi-user HTTP:** a single local user connected over stdio, versus the hosted server with many authenticated users.
- **Soak window:** a period on `beta` with the feature enabled and monitored before further changes land.

## Design principles

These apply to every part of the design and to any implementation of it:
- **Backend-agnostic.** Behaviour is defined once. File and database differences live only inside storage implementations selected by dependency injection (the existing `IStorageLayerFactory`; the proposed read capability adapter and existing memory stores, §9.12), never as mode branches or "not available in this mode" gaps in managers and handlers.
- **Modular and swappable.** New capabilities are separate components behind interfaces, registered through DI, feature-flagged where behaviour changes, and removable (the coherence modes in §9.11 are the model).
- **One path per concern.** One publication rule for all saves and loads, one validation path for all reads, one policy-acquisition path for all enforcement inputs, one identity resolver for cache and storage.
- **Correctness before speed.** Capacity events, errors and uncertainty may only cost I/O or a surfaced error, never a stale read or a dropped restriction (F5, F6). Policy reads fail closed.
- **Evidence first.** Every behaviour change requires a focused reproduction or acceptance test; performance is measured as counts, never gated on timings; claims about current code are marked V or H.

## 0. Reconciliation with current beta

| Area | Merged foundation / current evidence | Remaining work and decision |
|---|---|---|
| Definition cache | Existing mutable `ElementCache` and history-based scan invalidation remain | Shared read facade, immutable definitions, publication ordering and all-path migration are proposed |
| DB revision | 0056 advances revision on every parent UPDATE and invalidates memory entry projection; 0057 adds tag invalidation | Exact cache projection, raw-byte digest verification on changed revision; preexisting dirty/backfill and locked reconciliation gates remain |
| DB heads/read scope | `IMemoryHeadStore` and guarded DB snapshots/writes; bounded repeatable-read reconciliation inspector | Production all-writer routing, apply authorization, archive phantom/reference coverage and lifecycle qualification remain; diagnostic scope is read-only |
| File ownership/head | Durable owner snapshots, tenant fence/coordinator, conditional UPDATE, read-only diagnostics, bounded finalization/forward recovery | Ordinary create/rename/delete/erasure and all-writer integration remain separate; no automatic repair/lease removal |
| File archives | #2916 A-only exclusive publication merged; exact receipt/marker identity proof | Public read/list, cleanup parity, retention/erasure and common interface qualification remain; no runtime activation |
| DB archives | Owner-bound database volume store exists | Composite lifecycle/rollback/phantom/reference semantics and file parity are not certified by this design |
| Memory entries | #2867 Map fix merged; #2868 draft | Runtime overlay separation, provenance-preserving conflicts, rollover integration after shared gates |
| Persona lookup | #2806 user-scoped lookup dedup fix merged | #2799 cache engine and #2801 validated cache-hit optimization remain |
| Live policy/activation | Source defects summarized in §5/§11, not repaired by storage foundations | Track A early focused policy/activation fixes, consumer contract and per-slice decisions |

| Superseded recommendation | Reconciled rule |
|---|---|
| Content-hash CAS plus automatic append remerge/retry | Existing monotonic memory revision/dirty guards; retain typed conflicts and pending provenance; future explicit no-resurrection rebase only |
| File memory path/frontmatter as owner identity | Captured tenant + durable owner UUID; paths are locators and names are display |
| New lockfile, PID/age recovery and automatic seqlock certification | Existing tenant fence/coordinator for memory; optional portfolio snapshot decision composes it and preserves unknown evidence |
| Immutable archive means no coherence work | Body bytes may be reused, but current access/expiry/reference/tombstone checks remain mandatory |
| New hash trigger is mandatory because no revision exists | Existing 0056 revision is available; body-hash maintenance optional/separately justified; changed revision cannot trust stale stored hash |
| Activation is always more restrictive | Allow rules can relax policy; durable-publication failure grants no permissions and ambiguity blocks with working remediation |
| Large feature-branch landing then enablement | Bite-sized beta PRs, dormant foundations, one qualified enablement; affected decisions gate each slice, not all independent fixes |

Source contracts: [memory head interface](../../src/storage/IMemoryHeadStore.ts), [file fence/coordinator](file-memory-fence.md), [owned-head update/recovery](../guides/file-memory-owned-head-update.md), [archive publication](file-memory-archive-publication.md), [DB tag invalidation/qualification](../developer-guide/database-memory-tag-invalidation.md). These are authority boundaries, not cache implementation details to replace.

## 1. Summary

**Problem.** Element caching is incoherent. In database mode the gatekeeper's per-operation refresh wipes the persona, skill and ensemble caches on nearly every call, so the cache is effectively disabled: correct-ish but slow. The obvious fix (evict only what changed) was built and abandoned. It exposes a structural flaw: cache validity is inferred from the scan index's **separately evictable history** (DB per-user index state, file mtime manifest), not from what the cache actually holds. Any path that advances that history without evicting, or publishes without checking, serves stale data, including stale gatekeeper policy.

**Beta is not simply "correct but slow".** Independent of #2799, analysis of the current code found existing defects: policy collection and scans swallow errors and treat failure as absence (fail-open); the policy export to the bridge reads active personas from the cache only and can write a partial policy; cache-dependent persona cleanup and list-based skill/ensemble/memory cleanup can deactivate elements on misses or partial/failed lists; agent cleanup preserves a thrown error but removes an undefined lookup result; implementing qualification must establish authoritative absence; activations are bound to display names and silently re-bind to a recreated element; cached objects are mutable references, and ensembles keep their own copies of member instances; `LRUCache.entries()` ignores TTL; one memory delete flushes every user's caches; and more (§11).

**Direction:**
1. Every cached definition carries a **version captured in the same read as its content**.
2. Freshness is established by comparing **authoritative storage observations with the versions actually held in the cache**, never with remembered scan history.
3. Scans and index reads become **side-effect-free hints**: they can't validate or "use up" invalidations.
4. **Every publication (load and save) is fenced, and observations are ordered**, so nothing older than an observed version can enter the cache or move shared state backwards.
5. **Policy reads fail closed** (gatekeeper enforcement and the bridge policy export): uncertainty blocks enforcement instead of dropping restrictions.
6. **Active-element identity is durable and independent of cache residence, for every activatable type**: eviction, a failed list, or a failed restore/load at startup never changes policy, and a recreated same-name element never silently inherits an activation.
7. **No retained definition instances outside the definition cache** (ensemble member instances, agent recovery sources): runtime state is separate.
8. One contract for **both storage modes**, with file-mode limits stated explicitly where the filesystem can't provide them.
9. Delivered behind a **DI-swappable coherence mode** (`legacy | authoritative | versioned`), with a safe no-cross-request-cache mode as the reference implementation and kill switch **once every path is on the contract** (§9.11).

---

## 2. Background and root cause

### 2.1 How the cache works today (verified)
**Context.** DollhouseMCP is an MCP server. Clients call it through **MCP-AQL**, its operation protocol, exposed either as five CRUDE endpoint tools (create, read, update, delete, execute) or as one unified tool. Every operation passes through the **gatekeeper**, the server's permission layer. It combines per-operation default permission levels with **element policies**: allow/confirm/deny operation lists and external-tool restriction patterns carried by the currently **active** personas, skills, agents and ensembles (and the members of active ensembles). Evaluating that combination for an operation is **enforcement**. The same active-policy set also feeds the **bridge policy export**, a JSON file written to `~/.dollhouse/bridge/imports/policies/` so that a separately installed companion, DollhouseBridge, can answer an MCP client's tool-permission prompts locally. It also feeds the **prescriptive digest**, a short summary of active policies appended to tool responses. Storage is either a local file portfolio (single user, typically over stdio) or PostgreSQL with row-level security (RLS), used by the multi-user hosted HTTP server.

- `BaseElementManager` composes `ElementCache` (LRU per type: 1000 entries / 50 MB, TTL default 1h), `ElementLoader`, `ElementPersister`, `ElementResolver` and `ElementListOperations`. All six managers extend it. Managers are **root singletons shared by all HTTP sessions**; isolation relies on cache-key namespaces (`getCacheNamespace()`: session userId → resolver → `'system'`; AgentManager adds `:agent-session:<sessionId>` in DB mode).
- Storage: `AbstractDatabaseStorageLayer` (+ `DatabaseStorageLayer`, `DatabaseMemoryStorageLayer`) and file `ElementStorageLayer` / `MemoryStorageLayer`, behind `IStorageLayer`. DB keeps per-user index state (name↔UUID maps, scan watermark), pruned above 256 users. File keeps a per-directory index plus an mtime manifest (and, for memories, `_index.json`).
- **Gatekeeper refresh** (commit `805ceae6`): before each MCP-AQL operation, `collectActiveElementsForPolicy({freshAfterInFlight:true})` calls `refreshIndex()` on personas, skills and ensembles → `scanAndEvict()` → `invalidate()` + `scan()` → uncache `modified`+`removed`. In DB mode `invalidate()` nulls the watermark, the next scan is full, and every known row is reported `modified`, so the whole type is evicted.
- **Two policy collection paths** (V, `ElementCRUDHandler.getActiveElementsForPolicy`): enforcement calls it with `allowCoalescing: false` (fresh; personas via async `resolveActivePersonas`). Every other caller gets the **coalesced** path (shared `activePolicySnapshots` promise per scope; personas via the **cache-only** `getActivePersonas()`). The coalesced path feeds the bridge policy export and the prescriptive digest (§5.6).

### 2.2 Previous attempt: selective eviction, and why it failed
The earlier attempt is preserved on branch `archive/2799-selective-eviction-attempt` (reference only).

Per-row DB versions (`updated_at` µs), a load-generation guard, incremental same-name handling, and `added`-row eviction. It fixed every reported scenario, but a systematic analysis of every scan and index consumer found three gaps no local patch closes:
- **Lost history:** after index pruning/reset, a cached element deleted elsewhere is never evicted.
- **Unconsumed diffs:** `listSummaries()`, `getIndexedPaths()`, the resolver's first scan, AgentManager and MemoryManager discovery all record the new version and discard the diff.
- **Late own-save publication:** a save publishes after a newer version was observed.

**Root cause:** validity is derived from history, not carried by the cache entry. The redesign starts from scratch; only the earlier attempt's **tests** are reused, as acceptance tests (§12).

---

## 3. Scope

**In scope:** the element definition cache and every path that publishes to it, reads from it, invalidates it, or indexes storage for it; retained definition instances outside it; all six element types; DB and file storage; gatekeeper policy freshness **and the bridge policy export**, as they depend on cached definitions; active-element sets and their identity; the fail-open error paths that affect freshness; **memory cache integration** (existing version-checked stores and provenance-preserving conflicts, §10.5), because memories are appended to from many sessions and whole-document saves can lose entries.

**Out of scope (tracked separately, §11):**
- The cross-user persona lookup de-duplication leak: **fixed separately** (#2805 / PR #2806, merged in `4d2bbf5c`).
- Authorization-through-execution fencing (revocation between decision and side effect).
- Collaborative/conflict-free editing of element definitions in general (memories are the exception above).
- The console test-harness `seedWorld` FK flake.
- Performance tuning unrelated to coherence.

---

## 4. Requirements: the freshness contract

Definitions: a **commit** is the backend's specified commit event (DB transaction commit; each file-memory protocol's documented boundary, not any intermediate rename). A **read** is any way of obtaining a definition (get, list, find, snapshot, activation lookup, policy resolution). An **operation** is one MCP-AQL call (or one console/API request).

| ID | Requirement |
|---|---|
| **F1 Policy reads** | Every **enforcement input** evaluates a **fresh authoritative snapshot** acquired after its trigger T: gatekeeper enforcement for an operation starting at T, **and every bridge policy export** (§9.7). The snapshot includes active definitions and every member/dependency definition the policy rules need, and reflects every commit that completed before acquisition, from any process or replica. It never reuses an older in-flight or coalesced snapshot. Evaluated definitions are pinned until the decision (or export write) finishes. Revocation between decision and side effect is out of scope (§3). File mode: see D12 for what "snapshot" can mean across several files. |
| **F2 Ordinary reads** | Default: a read that starts after an operation begins must not return a predecessor of any version committed before its storage observation. Repeated reads within one operation may share one pinned view. Bounded-stale reads exist only as an explicitly named, opt-in API with a stated maximum age. **TTL never defines freshness.** Advisory policy surfaces (the prescriptive digest, dashboards) are ordinary reads (§5.6). |
| **F3 Read-your-writes** | After this process commits a save/delete, every **later operation** in any session of the same user sees it and never an older version. Within the operation that wrote, the writer's view of that identity is replaced by its own write receipt (it never reads its pre-write pinned version again). |
| **F4 Monotonic per entry** | Once a version V of X has been observed by a context whose logical-clock capture is at or after X's last shared change (§9.4), no older version of X may be published into the shared cache, and no older observation may move X's shared state backwards. Bookkeeping is bounded; once it's discarded (clear/eviction), revalidation is compulsory. |
| **F5 Fail closed** | For policy reads (enforcement and export), any infrastructure error, parse failure, incomplete enumeration or unstable read yields a typed, retryable failure that **blocks** enforcement and puts the **export/consumer into an explicit unavailable state** under the agreed AD2 contract, including rejected stale policy after failed publication (D14), never a partial file and never a silently retained older file. It is never translated into empty/absent/unchanged. An activation store that is not ready (loading, load failed) is a policy-read failure, not an empty active set. Ordinary reads on validation failure bypass the cache (direct read) or surface the error; they never serve unvalidated cache. |
| **F6 Capacity ≠ semantics** | TTL, LRU, memory-budget eviction, index-state loss and **list/scan failures** may only cause **more I/O or a surfaced error**. They never change active sets or policy, and never hide a change or deletion. |
| **I1 Isolation** | A read never returns another user's private data, including via shared in-memory structures (dedup maps, shared promises, index states, coalesced snapshots). Visibility (RLS / ownership / public) is rechecked at validation, not inferred from the cache namespace. |
| **I2 Scoped side effects** | One user's action (delete, reload, clear) doesn't flush other users' caches, including subclass caches (e.g. MemoryManager's content-hash indexes). |
| **I3 Durable activation identity** | An activation refers to one durable element identity. If that element is deleted, the activation doesn't silently move to a different element that later takes its name (policy effect of deletion: §15 PD1). Persisted activations survive restarts and transient failures: only authoritative absence removes one. Legacy name-only migration is an explicit PD5 decision. General nonmemory file creation identity remains D13; owned file memories already have durable UUIDs and get no same-path exception. |
| **X1 Replicas** | Correctness never depends on local notifications or process-local state. Strict validation reads the authoritative primary (or an equivalent read-after-commit guarantee). |

### 4.1 Performance targets (measured as counts, not timings; perf never gates on time)
- **P1** Unchanged warm operation: **0** YAML re-parses for already-known definitions in both modes; **0** `raw_content` reads in **DB mode**. File mode: strict validation digests the bytes (D7), so body reads are expected and counted, not zero.
- **P2** Policy refresh when nothing changed (DB): ≤ 1 batched validation **data query** per refreshed type (first rollout), counted separately from transaction/RLS setup statements; an O(1) per-type revision check is a later optimization (§9.9).
- **P3** After a change: O(rows of that type for that user) validation; only changed, removed or unknown entries reloaded.
- **P4** ≥ 80% fewer raw-content bytes and parses on an unchanged warmed DB workload vs. beta; p95 no worse than baseline (thresholds set after the baseline, §13).
- **P5** File mode: no regression beyond the measured cost of the chosen strict-file contract (D7/D12); the target is set from the §13 baseline.

---

## 5. Inventory (consolidated; **V** unless marked H)

This inventory is the **D9 enablement checklist**: selective cache hits are enabled only when every row below is on the contract or explicitly classified as best-effort reporting.

### 5.1 Publication sites (the single primitive is `ElementCache.cacheElement`; none capture a version today)
| Site | Mode | Notes |
|---|---|---|
| `ElementLoader.load` | both | read → parse → `afterLoad` → publish; **never checks the cache first**, so DB `findByName` always re-reads |
| `ElementLoader.loadElementSnapshot` | file | cache-first; publish on miss |
| `ElementLoader.loadElementSnapshotFromDb` | DB | cache-first; publish on miss |
| `ElementPersister.save` commit hook | both | publishes the **caller's live mutable object** after write + `afterSave`; file mode then `notifySaved` **re-stats** the file |
| `MemoryManager.load` (file) | file | cache-first via `getCachedByAbsolutePath` |
| `BaseElementManager.cacheElement` / `findByStorageIdentity` | both | protected escape hatch; `findByStorageIdentity` returns cached first |
| Subclass hydration | both | `MemoryManager.afterLoad` mutates instructions/entries and may `addEntry`; AgentManager runtime hydration |

### 5.2 Invalidation sites
| Site | Notes |
|---|---|
| `ElementListOperations` list (file), `listFromDatabase`, `scanAndEvict` | evict `modified`+`removed` (current `beta` ignores `added`); `scanAndEvict` **swallows errors**; `list`/`listFromDatabase` return `[]` on error and drop elements that fail to load |
| `evictForeignRowsFromCache` | only with `includePublic`, **after** loads; never fires for memories (`DatabaseMemoryStorageLayer.mapRowsToSummaries` omits `userId`) |
| `ElementPersister.delete` commit | by UUID and by path, then file `notifyDeleted` |
| `ElementEventCoordinator.handleExternalChange` | file watcher: **off by default** (`DOLLHOUSE_ENABLE_FILE_WATCHER`), 500 ms debounce, non-recursive, ambient namespace (H) |
| `BaseElementManager.clearCache` / dispose | **global across namespaces**; DB `storageLayer.clear()` drops **every tenant's** index state. `MemoryManager.clearCache` also clears `contentHashIndex`/`contentHashByPath` globally. Triggered by `PersonaManager.reload()` (persona delete/edit, collection install, handler reload, bootstrap), skill `reload_elements`, and **every memory delete** (`deleteElement.ts`). Incidentally, the global clear is today the only thing that evicts other users' cached shared-pool public rows after a `SharedPoolInstaller` install |
| Passive | TTL (from set time; **`LRUCache.entries()` ignores TTL**), LRU, `CacheMemoryBudget.enforce` (150 MB global, cross-tenant). None notify activation sets |
| Save rollback | **does not uncache** |

### 5.3 Scan / index consumers
| Consumer | Mode | Diff handling |
|---|---|---|
| `ElementListOperations` list / listFromDatabase / scanAndEvict | both | consume (current `beta` drops `added`) |
| `listSummaries()` / `getIndexedPaths()` | both | scan and **discard** |
| `ElementResolver.findByName` first scan | DB | **discard**; a completed-index miss is treated as authoritative absence |
| `AgentManager.listForFlexibleRead` | DB | scan + summaries: **discard, advance watermark** |
| `MemoryManager.getAutoLoadMemories` | both | scan then `getAutoLoadEntries`: **discard**; in DB mode it throws (method missing), is caught, and returns `[]` |
| `MemoryManager.list` (file) | file | `getIndexedPaths()` → cache-first load: **never evicts** |
| `MemoryStorageLayer.rebuildIndex` / `coldStartForDir` | file | change index/manifest outside any eviction |
| `EnsembleManager.activateEnsemble`, AgentManager activate/deactivate, `ElementCRUDHandler.getIndexedPolicyManager` | both | consume via `scanAndEvict` |

### 5.4 Version sources available today
- **DB:** `elements.storage_revision` (0056 all-parent UPDATE trigger) and `elements.id` (UUID); `elements.content_hash` = sha256(raw_content). **Every application write sets `raw_content` and `content_hash` together** (V: `DatabaseStorageLayer` computes the hash and writes it in the same values object; `buildElementUpdateSet` spreads all values plus `updatedAt = NOW()`; the name is part of the row identity; `DatabaseMemoryStorageLayer` and the `SharedPoolInstaller` upsert do the same). `updated_at` (timestamptz, `NOW()` = transaction start; no independent timestamp-maintenance trigger, but child/tag invalidation writes it); `byte_size`. `readContent` returns only `raw_content`; `writeContent` returns only the UUID.
- **DB child tables (V):** `DatabaseMemoryStorageLayer.addEntry`/`removeEntry`/`purgeExpiredEntries` have **no callers** in src (every `addEntry`/`removeEntry` call is on the in-memory `Memory` / `MemorySearchIndex`); `memory_entries` rows are rewritten from `raw_content` in the save transaction (`syncEntriesInTx`). Policy reads ensemble membership from the definition's `metadata.elements`, **not** from `ensemble_members` (only `RelationshipExtractor` and `userDataPurge` touch that table). `agent_states` is runtime state, not part of the definition.
- **File:** `mtimeMs` from a separate path-based `stat` (size stored but not compared); no hash; the loader never stats. Application writes use `FileLockManager.atomicWriteFile` (temp file + `rename`), so **every save gives the path a new inode**.
- **Current DB revision coverage:** migration 0056 advances `elements.storage_revision` on every parent UPDATE, including same-content updates and direct SQL. It also bumps memory revisions and marks heads dirty on child entry changes; 0057 does this for tag mutations. Stored `content_hash` is still app-computed and can be stale after direct SQL. File external editors remain outside the cooperating owner protocol. These facts do not certify production routing or preexisting rows.

### 5.5 Lifecycle and namespaces
TTL/LRU/budget; DB index pruning at 256 users (doesn't touch the element cache); `invalidate()` (DB nulls the watermark; file resets the cooldown); file scan cooldown 1 s with `freshAfterInFlight`; namespaces as in §2.1; **agent per-session namespaces never freed on disconnect** (the per-session scoping is intended per `AgentManager.getCacheNamespace`'s doc; freeing them is §10.4); HTTP session dispose doesn't evict its namespace; web console writes go through `ManagerBackedPortfolioElementStore` (same managers; `portfolio_elements` table dropped in migration 0037).

### 5.6 Additional read paths, retained instances and active-set consumers
Each row states its disposition. None may remain as an unclassified raw cache read when `versioned` is enabled (D9).

| Path | Mode | What it does today | Disposition |
|---|---|---|---|
| **Bridge policy export**: `PolicyExportService` → registrar lambda → `ElementCRUDHandler.getActiveElementsForPolicy()` (coalesced) | both | Personas from the cache-only `getActivePersonas()`; per-element failures swallowed by the `appendActive*` helpers; the result is written to `~/.dollhouse/bridge/imports/policies/…json`, overwriting the last good file. Export is on by default (`DOLLHOUSE_POLICY_EXPORT_ENABLED` = true) and writes whenever the bridge folder exists. (Note: the registrar's `catch { return [] }` doesn't catch async rejections, because the promise is returned without `await`; a rejection reaches `capturePolicySnapshot`, which skips the write. The live gap is cache-only personas plus partial collection.) | **Policy read** (F1/F5, §9.7): fresh snapshot; on failure the D14 unavailable state; never a partial write |
| `ElementCRUDHandler.collectActiveElementsForDeadlockRelief` | both | Personas from the cache-only `getActivePersonas()` | Reads the **active-identity store** (§10.0), not the cache; relief must cover every active identity |
| `ServerSetup.appendPrescriptiveDigest` → coalesced `getActiveElementsForPolicy()` | both | Digest on every tool response | **Advisory ordinary read** (F2); may share one pinned view within the operation; never feeds enforcement |
| `ElementCRUDHandler.activePolicySnapshots` (coalescing map) | both | Shares an in-flight collection per scope | Allowed only for advisory reads; enforcement and export never join it |
| `PersonaManager.getPersonas()` | both | Sync map over cached values; no src callers | **Delete** (or route through the facade if a caller appears) |
| `PersonaManager.create` duplicate check (`await super.list()` then `findPersona`) | both | Cache-based duplicate check | Use a validated name resolution; DB unique constraint remains the backstop |
| `PersonaManager.editExistingPersona` (`findPersona` after `editPersona` → `reload()`) | both | Cache-only re-find after a global clear | Use the save's write receipt / validated read |
| `PersonaManager` sync accessors (`getActivePersona(s)`, `isPersonaActive`, `getPersonaIndicator`, `deactivatePersona`) and the Container `activePersona` accessor (`getActivePersona()?.filename`, root and HTTP) | both | Cache-dependent | Read the active-identity store (§10.0/§10.1); display data from the store, not the cache |
| `ElementResolver.findInCache` (first step of `findByName`) | file (DB only for UUID identifiers) | Unvalidated `getCachedByAbsolutePath` hit | Through `ensureValid` (§9.5) |
| `BaseElementManager` `protected get elements(): LRUCache<T>` | both | Raw LRU exposed to subclasses (unused) | **Remove** |
| **`Ensemble.elementInstances`** (per-Ensemble map of member `IElement` instances, reused by `activateSingleElement`; nested ensembles re-activated on the retained instance) | both | A second, unvalidated instance cache living inside a cached (mutable) Ensemble | **Request-local**: member instances come from the validated facade per activation; no member instances retained on a definition (§10.3) |
| **AgentManager recovery binding** (`createRecoveryAgent` → `getCachedElementByStorageIdentity` → `recoverySourceAgents`; `synchronizeRecoveryState` mutates that cached instance) | both | Runtime state written into a cached definition instance | Move to the agent **runtime-state store keyed by storage identity** (§10.4); never mutate a cached definition |
| **Active-set cleanup**: persona cache `findPersona`; skills/ensembles/memories compare list results; agents resolve names/identities | both | Persona cache miss and partial/failed lists can deactivate; agent thrown errors preserve records, undefined results remove them | Authoritative absence only (§10.0); preserve error distinctions |
| **Name-bound activations**: skills, ensembles and memories store `metadata.name` and re-resolve by name (`getActiveSkills`/`getActiveEnsembles`/`getActiveMemories`); personas store filenames | both | A delete + recreate under the same name silently inherits the activation (I3) | Active-identity store with durable refs for all types (§10.0) |
| **Activation restore and store lifecycle**: `Container.restoreActivations` restores personas/skills/memories/ensembles **by name/filename** through the normal activation paths (only agents use the persisted identity) and **prunes the persisted record on `success: false` and on any exception**; `DatabaseActivationStateStore.initialize` sets `initialized = true` before I/O and, on a load error, logs "starting fresh" (`handleDbInitializeError`) and leaves an empty map; `IActivationStateStore` documents starting fresh on corrupt/missing data; persistence writes go through a fire-and-forget `PersistQueue`; HTTP sessions intentionally don't initialize persisted activation stores (ephemeral per connection) | both | Restore can prune records on failure. Store load failure leaves an initialized empty in-memory map; it does not by itself immediately delete durable rows, but a later persist can overwrite them; name-based restore can re-bind and can run current ensemble membership as a side effect | §10.0 readiness states, identity-based restore, prune only on authoritative absence; not-ready = policy-read failure (F5) |
| **Independent metadata/index caches**: `search_portfolio` → `Portfolio.search` (`PortfolioIndexManager`), `search_all` → `Portfolio.searchAll` (`UnifiedIndexManager`), `find_similar_elements` / `get_element_relationships` / `search_by_verb` → `EnhancedIndex.*` (`EnhancedIndexManager`) | both | Serve element names/metadata from caches with their own lifetimes, outside `ElementCache` and §9.5 | **Named bounded-stale discovery APIs** (D10): never used for activation, policy or any decision; results carry refs that are re-read through the facade before any use. Their staleness bound is documented, not certified |
| **D12 writer participants** (file mode): every app path that writes element files: `ElementPersister`, `ElementFileOperations`, `MemoryManager` (incl. `_index.json` rebuilds), `ElementInstaller` (collection install), `PortfolioPullHandler`, `PortfolioSyncManager`, `MigrationManager`, and the `ElementCRUDHandler` direct write (H: confirm the exact list at implementation by grepping `fileOperations.writeFile`/`atomicWriteFile` under the portfolio root) | file | Write element files without any multi-file protocol | Inventory participants if D12 coordination is selected; memory paths already delegate tenant transactions. No new writer protocol is selected here |

---

## 6. Failure-mode catalogue

Each failure mode is closed by the design element in the last column (§9/§10 numbering).

| FM | Mode | Description | Closed by |
|---|---|---|---|
| FM1 Unconsumed diffs | both | readers scan, record, discard → next evictor sees "unchanged" | validate vs cache (§9.5); scans are hints |
| FM2 Lost history | both | DB index pruning/clear; file first scan, `rebuildIndex`, manifest wholesale replace clobbering `notifySaved` → changes/deletes never evicted | validation enumerates **cached identities**, not history (§9.5) |
| FM3 Late publication | both | load or save publishes after a newer version was observed; loads racing saves; concurrent same-name creates | publication fence on loads **and** saves, keyed for creates on the name identity (§9.4) + next validation evicts |
| FM4 Non-persisted state | both | save publishes the caller's mutable object; rollback doesn't uncache; in-place edits mutate the cache | immutable definitions; publish the committed form; uncache on rollback (§9.3) |
| FM5 Negative staleness | DB | completed-index misses treated as authoritative; remote creates not found | resolver misses use a fresh context when correctness matters (§9.6) |
| FM6 Expired entries served | both | `LRUCache.entries()` ignores TTL | TTL check on all reads (§9.8), **after** active identity is independent of the cache (§14) |
| FM7 Swallowed errors | both | `scanAndEvict` catch-all; `list`/`listFromDatabase` → `[]`; file `performScanForDir` → EMPTY_DIFF; policy append helpers drop failed elements | typed errors + fail-closed policy (§9.7) |
| FM8 Wall-clock watermark | DB | app-clock watermark vs transaction-start `NOW()`; long transactions missed by incremental scans; clock skew | the watermark is never a correctness cursor (§9.2) |
| FM9 Invisible deletes | DB | incremental scans can't see deletes | full enumeration / targeted `observeMany` (§9.5) |
| FM10 Out-of-band writes | DB | raw SQL can advance revision while retaining a stale stored hash; restores may invalidate incarnation assumptions | existing revision plus exact raw digest on change; explicit restore/epoch and projection qualification (AD1) |
| FM11 Foreign public rows | DB | readable via RLS, cached, never reconciled; visibility revocation unseen | don't cache foreign rows (D6); validate visibility under the requester (§9.10) |
| FM12 Data purge | DB | `userDataPurge` deletes without notification (H) | validation handles absence; sessions terminated (confirm) |
| FM13 Coarse file versions | file | mtime-only; same-size/preserved-mtime/in-place rewrites | strict observation **always digests** the bytes (D7); stat is only a hint |
| FM14 `notifySaved` re-stat | file | external write between save and stat → manifest records the external mtime | save returns the committed digest; manifest is a hint (§9.2, §9.4) |
| FM15 External file writers | file | pull/sync handlers, git, editors rely on scans | validation vs cache + digest (§9.5) |
| FM16 Symlinks / case aliases | file | keys use the link path (H); case-insensitive filesystems | secure rooted locators for general definitions; memory identity is tenant + durable owner UUID (§9.2) |
| FM17 Eviction/failure changes policy | both | cleanup deactivates on a cache miss or a failed/partial `list()` | active identity independent of cache; authoritative absence only (§10.0) |
| FM18 Cross-session agent staleness | DB | refreshing one session's namespace doesn't validate another's hydrated instance | per-instance definition version check (§10.4) |
| FM19 Global flush | both | one user's delete/reload clears all users' caches and index states | namespace-scoped clear, including subclass caches (§9.8) |
| **FM20 Retained instances** | both | `Ensemble.elementInstances` and the agent recovery source keep definition instances outside the cache; validation never sees them | request-local instances; runtime state keyed by identity (§10.3, §10.4) |
| **FM21 Name-bound activation** | both | activations re-resolve by name and silently re-bind to a recreated element | durable activation refs for all types (§10.0, I3) |
| **FM22 Observation downgrade** | both | an older read context's observation (V1) lands after a newer one (V2) and moves shared "last observed" state backwards; a load then publishes V1. Includes a snapshot context that **first touches** X after another context's newer observation | logical-clock ordering captured before the storage snapshot, with the `discardedAt` bound for forgotten state (§9.4) |
| **FM23 Mixed file snapshot** | file | a policy read sees root R0 with member AD1 that never coexisted (each file individually consistent) | separately selected file policy coordination or explicit approved per-file bound (D12, §9.7) |
| **FM24 Partial policy export** | both | export writes from the coalesced, cache-dependent path and swallows per-element failures | export is a policy read: fresh snapshot, never a partial file (§9.7) |
| **FM25 Restore erases activations** | both | startup restore prunes persisted activations on any error; a failed store load looks empty; name-based restore re-binds | §10.0 readiness + identity restore + prune only on authoritative absence |
| **FM26 Index caches** | both | search/relationship indexes serve stale names/metadata outside the definition cache | classified bounded-stale discovery; never a decision input (§5.6) |
| **FM27 Stale permissive export** | both | policy-change/export failure can leave stale permissive policy, including failed unavailable-marker publication | consumer-confirmed unavailable/freshness enforcement including failed writes (D14/AD2) |
| **FM28 Lost memory entries** | both | per-session unsaved copies plus unconditional whole-document saves: concurrent sessions overwrite each other's new entries | existing revision-checked memory stores; identity-keyed, provenance-preserving pending attempts (§10.5) |

---

## 7. Options considered

| Option | Verdict | Why |
|---|---|---|
| **A. Version-stamped definitions validated against authoritative observations** | **Core** | Removes dependence on history (FM1/FM2/FM9) by construction; late publication is bounded by the next validation; enables cheap body reuse. Needs the extra rules in §9 (immutability, fences, observation ordering, visibility, request boundaries). |
| B. Acknowledged centralized invalidation (every scan delivers diffs, consumers ack) | Rejected as core | Keeps validity derived from history; correct only if every present and future producer/consumer participates; doesn't solve lost history or remote writes without a durable, commit-ordered log. |
| C. Request-scoped memo / no cross-request cache | **Adopted as `authoritative` mode**: reference implementation and kill switch **once every path is on the contract** (§9.11) | Coherent only when every read, retained instance and active-set consumer goes through fresh contexts; "no cross-request body reuse" alone is not enough. |
| E1. Postgres LISTEN/NOTIFY | Later latency hint only | Notifications are lost across reconnects, and pgbouncer's transaction pooling doesn't support session-scoped `LISTEN`; never proof of freshness. |
| E2. Per-(user,type) revision counter (trigger) | Later optimization (P2 → O(1)) | Needs a migration; serializes per-user writes; must cover the actual projection. Measure first. |
| E3. Content hashing | Body reuse/dedup evidence after verified raw bytes, not memory mutation authority | DB observation uses existing revision coverage. Changed revision requires exact raw read/digest; stored app hash alone can be stale. File strict observation digests exact bytes. |

---

## 8. Decisions (recommendations in **bold**)

The **Status** column shows which decisions are settled and which are open; open ones are restated in **§15** with status rows.

| # | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| D1 | DB version token | Existing `storage_revision` and body digest; optional separately qualified hash maintenance | Use the existing all-parent monotonic revision as an observation candidate, with visibility/name from the same observation. Content hashes permit parsed-body reuse, never memory mutation authorization. Changed revision requires reading exact raw content with that revision and computing/verifying its digest; stale app-written hash alone cannot authorize reuse. | Reconciled → AD1 |
| D2 | What the cache holds | (a) mutable element instances (today); (b) cloned/frozen instances; (c) **immutable definition DTOs + separate per-request/per-session runtime hydration** | **(c)**. Include ensemble member instances and the agent recovery source in the caller inventory (§5.6). Cloning is a migration aid, not a coherence proof: a live mutable instance can't also be the authoritative DTO. | Open → AD6 |
| D3 | Safe mode / kill switch | legacy wipe; authoritative no-cross-request cache | **`authoritative`**, but it only counts as the oracle/kill switch once the active-identity store, the read facade, retained-instance removal and the file contract are in (§9.11, §14). Until then it's labelled a partial reference. **Never** fall back to the earlier selective-eviction approach (§2.2). | Open → PD6 |
| D4 | Refresh fast path | full batched validation per type; per-type revision counter | **Batched validation first; add the revision counter only if the §13 measurements show it's needed**, covering the actual projection and compared against the current request's snapshot. | Settled |
| D5 | Policy freshness bound | decision-start snapshot; fenced through mutation commit | **Decision-start snapshot (F1)**, subject to confirmation (AD3); stronger fencing is a separate design. | Open → AD3 |
| D6 | Foreign public rows | cache with requester-scoped validation; don't cache | **Don't cache (initially)**; fix memory summaries' `userId`. A prior owner/public classification is never reusable permission. | Open → AD5 |
| D7 | File strict version and identity | Same-descriptor bytes/digest plus identity evidence | Strict observations digest exact bytes with bounded no-follow reads; stat is a hint for general definitions. For memories use the existing owner/head token: tenant + durable owner UUID is identity, locator is a path, and revision is mutation authority. General nonmemory file creation identity remains D13. | Reconciled; remaining identity choices open |
| D8 | Failure semantics | Typed policy unavailable; direct read/error for ordinary | Enforcement blocks; export attempts agreed unavailable publication, with consumer-side stale rejection even on write failure. Never partial/absence on error. Ordinary reads bypass reuse or surface failure. | Constraint retained; AD2 consumer protocol open |
| D9 | Enablement boundary | incremental per path; single switch | **Single enablement boundary**: selective cache hits are enabled only when *every* row of §5 is on the contract or classified best-effort. The same all-path gate applies before `authoritative` is trusted as the kill switch. Preparatory code can ship disabled. | Settled |
| D10 | Strict vs bounded-stale ordinary reads | strict by default; bounded-stale opt-in | **Strict by default; bounded-stale only via a named API.** File costs are measured honestly (no promise of zero body reads). | Open → PD4 |
| **D11** | DB version coverage and enablement | Existing revision; separately justified hash-maintenance trigger | 0056 already revisions every parent update; 0057 covers memory tags. Do not require a redundant new revision migration or a hash trigger merely to detect changed bodies. Define the actual cache projection, verify raw bytes on changed revisions, and qualify preexisting dirty/reconciliation gates before memory activation. Optional DB-enforced hash maintenance has its own justified scope and migration approval. | Open → AD1; memory release gates remain |
| **D12** | File multi-definition policy snapshot | Explicit portfolio coordination composed with tenant fences; or per-file consistency with qualified F1 | This is a separate open decision under PD2, not a new memory persistence lock. Any proposed portfolio protocol must define lock order and compose existing tenant transactions without nested acquisition, preserve crash evidence, and prohibit age/PID stealing. No seqlock/automatic-recovery implementation is approved here. | Open → PD2 |
| **D13** | Activation identity across recreate | Durable refs for all types; legacy migration | DB UUID; file memories use existing durable owner UUID with ACTIVE head/sidecar/registry proof, never frontmatter/path/name. Other file types still need a separately decided creation-identity format and import/copy rules. Do not silently apply a same-path exception to owned memories. | Open → PD3, PD1, PD5 |
| **D14** | Export failure | Explicit consumer-recognized unavailable state; restrictive missing/unreadable/expired handling | Recommendation: explicit unavailable state, but no guarantee that writing it succeeds. Consumer-side freshness and failure semantics must block use of a stale permissive file when marker write itself fails. Single-user export scope or a requester/session-scoped destination also needs approval. | Open → AD2 |

---

## 9. Design

### 9.1 Invariants
1. A cached definition is served only after a validation, in the caller's read context, that its `(ref, version)` equals storage's current `(ref, version)` and that the requester may currently see it.
2. Only validation decides validity. Scans, indexes, manifests and summaries are hints; they never validate an entry or consume an invalidation.
3. Every publication carries the version of the exact bytes it represents and passes a fence; nothing older than an observed version enters the cache, and no older observation moves shared state backwards.
4. Cached definitions are immutable. Runtime state lives elsewhere; no definition instances are retained outside the cache.
5. Capacity events and list/scan failures cause I/O or surfaced errors only (F6).
6. Policy acquisition (enforcement and export) is complete or fails closed (F5).
7. Activations reference durable identities (I3).

### 9.2 Storage contract (additive to `IStorageLayer`, via a capability adapter during migration)
```ts
type Version = string;            // opaque; equality only (ordering only where a backend guarantees it)
interface StorageRef { backendId: string; ownerId?: string; elementType: string; durableId: string } // DB: row UUID; file memory: durable owner UUID. Paths are locators, not memory identity
interface Scope { backendId: string; requesterUserId: string; elementTypes: string[]; visibility: 'own' | 'own+public' }
type Observation =
  | { kind: 'present'; ref: StorageRef; name: string; version: Version; access: AccessProjection; hint?: string }
  | { kind: 'unavailable'; ref: StorageRef };         // infrastructure/parse errors are typed errors, never 'unavailable'

interface IVersionedStorage {
  withReadContext<T>(scope: Scope, freshness: 'policy' | 'ordinary', fn: (ctx: ReadContext) => Promise<T>): Promise<T>;
  resolve(ctx: ReadContext, nameOrRef: string): Promise<{ kind: 'unique'; obs: Observation } | { kind: 'unavailable' } | { kind: 'ambiguous'; refs: StorageRef[] }>;
  readVersioned(ctx: ReadContext, ref: StorageRef): Promise<{ ref: StorageRef; name: string; version: Version; raw: string }>; // same statement / same fd
  observeMany(ctx: ReadContext, refs: StorageRef[]): Promise<Map<string, Observation>>;       // exhaustive for those refs
  enumerate(ctx: ReadContext, cursor?: string): Promise<{ entries: Observation[]; complete: boolean; snapshotId: string; next?: string }>;
  // Read/coherence capability only; durable mutations remain with existing persistence owners.
}
```
- **Types.** `AccessProjection` is the visibility-relevant part of a row (owner, visibility) used to recheck access at validation (§9.5). `FrozenSerializedDefinition` is the immutable, fully normalized serialized form that a save writes and publishes (§9.3). `hint` carries non-authoritative change evidence (e.g. `dev:ino`, size, mtime) that may trigger a re-read but never certifies freshness (D7). A cache write publication consumes the backend's exact committed result and exact stored serialization. It never creates a durable commit or reclassifies an unknown outcome. Nonmemory persistence is not replaced wholesale by this read facade. Memory UPDATE/delete always require the current tenant/owner/revision contract; no optional expected-token fallback or name-upsert is allowed. Memory create is a distinct explicit exclusive/adoption operation under existing ownership rules, not UPDATE with an omitted token. File-memory delete authority and archive cleanup are unfinished prerequisites, not capabilities supplied by this pseudocode.
- **Scope is pinned at entry.** No ambient resolver decides where a result belongs after an `await`. One identity resolver serves both cache namespace and storage user (today the cache uses `SessionContext.userId` while storage prefers the per-session `dbUserId` override).
- **ReadContext** captures the namespace **logical clock** once, **before its storage snapshot is established** (§9.4), and, in DB mode, carries **one transaction handle** through `resolve`/`observeMany`/`enumerate`/`readVersioned`. The existing helpers (`withUserRead`, `withUserContext` in `src/database/rls.ts`) each open their own transaction (V), so the adapter needs a context-bound variant for the general cache projection. Memory diagnostic read scope already exists and must be composed rather than bypassed (§10.5).
- **DB:** `readVersioned` = one `SELECT raw_content, <version>, user_id, visibility …` under RLS. `observeMany`/`enumerate` = `SELECT id, name, <version>, visibility` (no content). General nonmemory write adapters may return the backend's committed observation. Memory writes use their existing FINAL SELECT after child/tag/clear trigger effects, never an initial RETURNING token; publish only after transaction commit. `<version>` uses the existing monotonic parent revision candidate (§8 D1), with exact access projection. `content_hash` is a body-reuse hint until validated against raw bytes; changed revision requires raw read + computed/verified digest before reuse. Child/archive projections require their own explicit coverage; archive insertions do not automatically bump the parent. Policy acquisitions needing several statements run in one `REPEATABLE READ` transaction: RLS scope and isolation are set before the first snapshot-taking statement. **Nested closure within one snapshot:** the policy-snapshot acquirer (§9.7) runs its whole walk inside one `withReadContext(scope, 'policy', …)`, which in the DB adapter is one transaction. The acquirer (policy layer, not the adapter) parses only the dependency-bearing metadata (`metadata.elements`) of each newly read definition to find the next level, and fetches that level through the same context; cached, already-validated definitions supply theirs without re-parsing. Full YAML parsing of bodies, `afterLoad` and runtime hydration happen **after** the context (and its transaction) is released. Acquisition has an upper duration bound (depth and row count) compatible with `statement_timeout` and `idle_in_transaction_session_timeout`; exceeding it is a policy-read failure (F5), not a partial snapshot. Pool/pgbouncer behavior is deployment-tested (AD4). No transaction is held through the protected side effect.
- **File:** general definition reads use secure open → `fstat` → bounded same-fd bytes/digest → `fstat` again, with bounded read retries or typed failure on change. Memory reads consume the existing stricter owner/token/journal guards and never hide interrupted evidence by retrying a mutation. **`observeMany` for strict/policy contexts digests every observed file** (D7); for hint-only uses (listing, discovery) it returns `stat` hints. General file locators are securely rooted and alias-checked. File memory identity is the durable owner UUID captured with an agreeing ACTIVE head/sidecar/registry; normal atomic head replacement preserves that owner and advances revision. Never infer memory ownership from `realpath`, filename, display name, `Memory.id` or frontmatter `unique_id`. General nonmemory writes retain their existing persistence contract. File-memory publication follows its documented journal/owner boundary, not a generic rename receipt.
- **File multi-definition policy coordination (D12, unresolved):** choose either a separately specified cooperating portfolio snapshot protocol or a clearly qualified per-file contract. A portfolio generation is not a memory mutation revision. Any generation/intent proposal must define bounded acquisition, crash outcomes, supported local POSIX environment, all writer participation, and composition/lock order with the existing tenant fence. If a memory operation already holds its tenant transaction, the adapter consumes that scope; it never takes another tenant lease or nests `perform`. No new PID/start-time or age-based lease stealing is allowed. An interrupted write remains unavailable until separately reviewed recovery establishes exact evidence; parsing several files alone cannot certify a recovered multi-file state or authorize automatic "even generation" publication. Memory power-loss, multi-host and network-filesystem guarantees are not expanded here. Actual out-of-application editors remain outside a cooperating multi-file guarantee. A first-party writer that bypasses a selected D12 contract is an integration blocker and must be routed or disabled before enablement; it cannot be relabeled external to waive the all-path gate.
- `updated_at` remains for display and incremental listing only; **never** a correctness cursor.
- **Restore/rollback boundary:** parent revisions order normal triggered updates, not restored snapshots or manual revision resets. Quiesce reads/writes for a coordinated restore, reset/restart every replica's cache epochs and require fresh revalidation before resuming (or separately qualify a durable incarnation/generation). Never keep live caches across restored history or infer freshness because a revision/hash happens to match.
- Existing hardening is preserved: `PathValidator`, `SecureYamlParser`, `FileOperationsService` checks, RLS. "Not visible to this caller" is distinguishable from operational failure, without leaking cross-tenant existence.

### 9.3 Definition cache (immutable) and runtime separation
- `DefinitionCache` stores `{ ref, version, name, frozenParsedDefinition, rawDigest, parserSchemaVersion, namespace, fetchedAt }`, keyed by `namespace + ref.durableId`.
- Returned values are **immutable**. Callers that mutate get a hydrated runtime instance built from the definition. Runtime state (agent execution and recovery state, memory dirty/debounced entries, activation flags, ensemble member activation state) lives in per-request or per-session structures keyed by durable identity, never in the definition cache and never on a definition instance.
- The save path runs type-specific pre-save normalization (e.g. `TemplateManager.save` deriving variables), serializes a frozen input, writes it, and publishes `stored` + the returned `version`. Never the caller's live object, never after `afterSave` mutation. **Cache rollback/failed publication invalidates or fences reuse; it never deletes durable memory artifacts or rolls back a proven commit.**
- Transition: inventory callers that rely on instance identity (MemoryManager "same instance on repeated load", `Ensemble.elementInstances`, the AgentManager recovery source) and in-place mutation; provide clones behind a shim until they're migrated (D2).

### 9.4 Publication fence and observation ordering (loads and saves)
- **Logical clock.** Each namespace has a monotonic, never-reused counter `clock` (process-local; it orders events in this process's shared cache, which is all the shared cache needs). Every **shared change** to an identity (invalidation, accepted observation of a different version, publication, clear) takes a new clock value and stamps the identity's `lastChange`. Per-identity state (`lastChange`, `lastObserved` version + access) is bounded by live entries plus in-flight operations; **Discarding** an identity's state (entry eviction by LRU/TTL/budget, bounded cleanup, release of a name reservation) advances the namespace watermark `discardedAt = max(discardedAt, that state's lastChange)`. For identities with no state, the conservative `lastChange` is `max(clearedAt, discardedAt)`, where `clearedAt` is the last clear/epoch stamp. This keeps the bound conservative without tombstones; it costs some rejected publications right after evictions, never correctness.
- **Capture before snapshot.** A ReadContext captures `ctx.clock = clock` **before** its storage snapshot is established: before `BEGIN` for a DB REPEATABLE READ context (a safe lower bound for a snapshot taken at the first statement); for READ COMMITTED or file reads, per observation, immediately before issuing the read. A context never refreshes this value because it discovers an identity later ("first touch" doesn't matter).
- **Observation ordering.** An observation of X is **shared-authoritative** only if `ctx.clock ≥ X.lastChange`. Otherwise it is *stale for shared purposes*: it may serve that context's own pinned view (§9.5), but it can't update `lastObserved`, take a clock value or authorize a publication. This closes FM22, including late first touch, without treating a content hash as an ordered mutation version. Rejecting some legitimate observations costs cache hits, not correctness.
- **Epochs are per namespace** (I2): a clear takes a clock value, bumps that namespace's epoch and sets `clearedAt`; other users' in-flight publications are unaffected. Process dispose bumps all epochs.
- **Publication.** `beginPublish(scope, identity)` is acquired **before I/O** and captures `token.clock` and the namespace epoch. `publish(entry, token)` succeeds only if the namespace epoch is unchanged **and** `token.clock ≥ X.lastChange`, except when `X.lastChange` was stamped **by this token's own accepted read** (tracked by provenance: the change record names the token that caused it). Then the loader's own read doesn't block its own publication, and nothing else is exempt.
- **Creates.** DB non-exclusive saves upsert on `(user_id, element_type, name)` (V), so the **fence identity for a create is the name identity** `namespace + type + name` under the **same name equivalence as the backend's uniqueness rule** (not a display normalization), acquired before I/O with `token.clock`. The name reservation stays registered while the operation is in flight. When the commit returns the UUID, the token is atomically bound to the UUID identity **only if** `token.clock ≥ lastChange` for **both** the name identity and the UUID identity (for a UUID with no state, `max(clearedAt, discardedAt)`). Otherwise publication is skipped and the write receipt is still returned. The token keeps its original namespace epoch through binding, so a clear between commit and binding refuses the publication.
- **Failed publication** never undoes a successful commit and never republishes under a newly acquired token to force a hit; it only costs a future miss. The caller still gets its write receipt or its request-local value.

### 9.5 Validation (replaces diff-driven eviction)
`ElementCoherence.ensureValid(ctx, type)`:
1. Determine the identities to validate: the **union of cached identities for (namespace, type)** and in-flight publishers. This is independent of index state, so lost history is irrelevant (FM2).
2. `observeMany(ctx, identities)` (targeted), or `enumerate` for discovery/list operations.
3. Keep entries whose version and access match; evict (and fence) mismatched or absent ones. An explicit `unavailable` evicts; a typed error propagates (§9.7).
4. Update hint indexes (name maps) from the same observation.
5. Return two distinct things (one rule each):
   - **Pinned view** (request-local capability): `{ identity → exact immutable entry (version, access) }` for this context. Reads **within this context** are served from the pinned view until the context ends, whatever happens to the shared cache meanwhile, so an operation never mixes versions. Exceptions: after this operation's own save/delete of X, its view of X is replaced by the write receipt (F3); a clear/dispose of the namespace ends the context's use of the view for **new** decisions (it may finish the one in progress); a policy decision already made on the view stands (F1 pins until the decision finishes).
   - **Shared certificate**: the right to publish, or to serve a *shared-cache* entry to a **different** context, requires the §9.4 test (`ctx.clock ≥ X.lastChange`, epoch unchanged). A pinned view never grants it. The certificate is an **additional** condition, never a substitute for invariant 1: a context is served a shared entry only after its **own** storage observation matches that entry's version and access.
   - A context never revalidates just because the shared cache advanced; it revalidates only when it needs an identity that isn't in its pinned view.

**Reads** go through a context-aware facade: `get`/`find`/`list`/snapshot/`findByStorageIdentity`/`findPersona`-style accessors either validate in context or are explicitly marked best-effort reporting APIs that policy code can't use. No raw getter that looks validated remains (§5.6 lists the removals).

### 9.6 Index, names and negative lookups
- Name→ref indexes are hints, rebuilt from observations. A miss, a rename, an ambiguity or a UUID-shaped name decides nothing on its own when correctness matters: resolve in a fresh context (FM5).
- Deleting and recreating under the same display name produces a **new identity** (DB: new UUID; file: see D13); durable activations never re-bind to it silently (I3, §10.0).

### 9.7 Policy snapshot acquisition and fail-closed
- **Consumers:** gatekeeper enforcement (per operation) and the **bridge policy export** are policy reads. Deadlock relief reads the active-identity store directly (it must cover every active identity; it doesn't need definitions to decide what to relieve).
- **The proposed infrastructure-first path keeps authenticated remediation independent of unavailable policy snapshots; implementation must preserve the exact infrastructure policy and authorization checks.** Today `MCPAQLHandler.enforceOperationGatekeeper` awaits `getActiveElements()` **before** `gatekeeper.enforce({ …, skipElementPolicies: isGatekeeperInfraOperation(operation) })` (V), so a policy-read failure would block every operation. The design moves the infrastructure check **before** acquisition:
  - `GATEKEEPER_INFRA_OPERATIONS` (V: `UNGATABLE_OPERATIONS` = `verify_challenge`, `release_deadlock`, `abort_execution`, `approve_cli_permission`, `permission_prompt`, plus `confirm_operation`) never acquire a policy snapshot.
  - `permission_prompt` with an unavailable snapshot returns **deny** (fail closed), not an error.
  - **Deadlock relief** works while the store is `unavailable` and covers unresolved legacy records: it reads the persisted records directly and can clear them.
  - A **targeted remediation** (deactivate one specific unresolved/unavailable record, or release all activations) is exempt from the snapshot requirement **for that record only**, is authenticated like any operation, and emits its own audit event. No generic bypass for other operations.
  - Every blocking error names the remediation operation that works in that state. The prescriptive digest and dashboards are advisory ordinary reads and may use the coalescing map; policy reads never join it.
- **Acquisition:** capture the activation identities for every policy-bearing type (personas, skills, agents, ensembles; memories carry policy only as ensemble members) from the **active-identity store** (§10.0), not the cache; then, within one fresh policy read context, resolve roots → ensemble membership (from the definition's `metadata.elements`, §5.4) → members (all types, nested closure) → missing bodies, validating cached definitions against **that** snapshot. Never mix fresh roots with stale members. Multi-file consistency for a policy context is the storage adapter's job, behind `withReadContext` (the DB adapter uses one transaction; the file adapter uses the approved D12 contract, if one is selected), so the acquirer has no storage-mode branch.
- **Result:** a complete immutable policy snapshot, or `PolicyUnavailableError` (retryable). Enforcement **denies** with a retryable error. The export never writes a partial file and never silently keeps an older one: it attempts the agreed D14 unavailable publication only after AD2 is settled; if that write also fails, the consumer must independently reject stale/missing/unreadable/expired policy. Log and expose the unavailable state; never claim an atomic write is guaranteed. An activation store that isn't ready is a `PolicyUnavailableError` too (§10.0). Lower layers stop converting failures into `[]`/EMPTY_DIFF/`undefined`: `scanAndEvict`, `list`, `listFromDatabase`, `performScanForDir`, and the `appendActive*` helpers.
- Uncertainty **preserves** activation references; only authoritative absence changes them, and even then the policy effect of a deleted active element is a product decision (PD1).
- **Export scope (AD2):** the export writes one file under the server host's `~/.dollhouse/bridge/imports/policies/`, and `capturePolicySnapshot` returns early unless that folder exists (V), so in a hosted deployment it's normally inert (H). In multi-user HTTP mode it would reflect whichever session triggered it, which breaks I1. **Recommendation:** export runs only in single-user (stdio) mode, and is disabled/refused in multi-user HTTP mode unless a session-scoped destination and consumer contract exists. Open decision (AD2).
- **Cost note:** every export is now a fresh policy acquisition. In legacy DB mode that adds a `refreshIndex` wipe per activation/deactivation (performance only; counted in §13).

### 9.8 Namespaces, clear and TTL
- `clear()` is namespace-scoped by default (I2), **including subclass caches** (`MemoryManager.contentHashIndex`/`contentHashByPath`). User clear and process dispose are distinct operations; only dispose is global. DB index-state clear is per user.
- **Shared-pool installs:** today's global clear is the only thing evicting other users' cached public rows after a `SharedPoolInstaller` install. Namespace-scoped clear therefore ships **with or after D6** (foreign rows not cached), or keeps an explicit global invalidation of public rows on install until then.
- TTL is checked on every read path, including `entries()`/`getScopedValues()` (FM6), **but only after** active-set consumers stop depending on cache residence (§14): honoring TTL earlier makes `findPersona` miss and increases cleanup deactivations. TTL, LRU and budget are hygiene only.
- Session dispose evicts that session's agent namespace (§10.4).

### 9.9 Refresh cost
Per operation, policy validation = one batched `observeMany` per involved type (P2). If §13 measurements show that's too costly, add the per-(user,type) revision counter (§7 E2; D4): skip validation when the revision equals the last one validated for the namespace, capturing the revision **before** observing.

### 9.10 Foreign / public rows
Not cached (D6): read under the requester's context and returned as request-local values. Memory summaries gain `userId`. Revisit only with requester-scoped validation.

### 9.11 Coherence modes (DI-swappable, feature-flagged, removable)
`elementCoherenceMode = legacy | authoritative | versioned`, registered in `ElementManagerServiceRegistrar`, selected at startup (switching modes requires a quiescent epoch flush).
- **legacy:** today's behavior (default until the gates in §14 pass).
- **authoritative:** no cross-request content reuse; every read goes through fresh contexts; stale indexes and negative answers are not trusted; retained instances are request-local; activation identities come from the active-identity store; the file contract (D7/D12) applies; the fail-closed policy path applies. **It is only trusted as the reference oracle and kill switch after the same all-path gate as D9** (§14); before that, it's labelled a partial reference.
- **versioned:** the full design. Shadow comparison against authoritative is allowed for measurement, but on disagreement the **authoritative result wins**; an unvalidated result is never returned.

### 9.12 Components and interfaces
Every new component is an interface with implementations registered through DI (the element-manager registrar, alongside the coherence mode), so each can be swapped, feature-flagged or removed:

| Interface (proposed) | Responsibility | Implementations |
|---|---|---|
| `IVersionedStorage` (proposed read/coherence capability) | Fresh contexts, observations, enumeration; normal writes delegated to existing persistence owners | DB adapter; file adapter; memory integration consumes existing scope/token APIs |
| `IElementCoherence` (with the `DefinitionCache`) | Validation, publication fence, pinned views (§9.3–§9.5) | one per coherence mode (`legacy`, `authoritative`, `versioned`) |
| `IPolicySnapshotProvider` | Policy-snapshot acquisition for enforcement and export (§9.7) | one; uses `IVersionedStorage` read contexts |
| `IActiveIdentityStore` | Durable activation references, readiness, restore, migration (§10.0) | DB-backed; file-backed |
| `IAgentRuntimeStateStore` | Agent execution and recovery state keyed by storage identity (§10.4) | DB-backed; file-backed |
| Optional portfolio policy-snapshot coordination (D12) | Multi-definition snapshot support only if selected; compose existing tenant scopes without nested fences | Separate unresolved protocol; no new memory lock/owner/recovery authority |
| Existing `IMemoryHeadStore`, `FileMemoryTransactionCoordinator`, owner snapshots and volume stores | Conditional memory persistence/exclusion, owner proof and archive publication; adapters may unify interfaces only after parity qualification | Existing DB head/volume implementation; dormant POSIX owner/head/archive primitives |

---

## 10. Per-element-type design

### 10.0 Active-identity store (all activatable types)
- One store, per session, holding **durable `StorageRef`s** plus display data for every activatable type (personas, skills, ensembles, memories, agents). It replaces the per-manager activation sets of filenames/names.
- Sync accessors read the store (non-mutating, best-effort display), never the cache.
- **Cleanup** (every manager's `cleanupStale*`) acts only on **authoritative absence** observed in a fresh context; a list error, a parse failure of one element, a cache miss or an eviction preserves the activation (F6, FM17).
- **Readiness states.** The store is `loading | ready | unavailable`. `ready` means "loaded from persistence (or authoritatively empty)". A load failure is `unavailable`, never "empty": enforcement and export get `PolicyUnavailableError` (F5) and retry loading with backoff. The current behavior (`initialized = true` before I/O; load failure logged as "starting fresh", V) is replaced. "Authoritatively empty" (a successful load of no records, or a new session) is distinct from "unavailable".
- **Durability.** Activation changes that affect policy are persisted before the operation reports success, or the operation reports that persistence failed. They don't go only to a fire-and-forget queue (today's `PersistQueue`). Retries are idempotent. **On persistence failure or ambiguous publication:** do not infer that activation always adds restrictions: element allow rules can relax policy. A failed activation must not grant new permissions. Preserve durable and attempted identities with typed failure/provenance, make policy acquisition unavailable where the authoritative active set cannot be proved, and keep authenticated remediation available. Deactivation failures likewise cannot silently publish a less restrictive active set. Exact transactional persistence/publication, idempotence, retry attribution and restart behavior remain an open protocol decision; an in-memory "more restrictive" assumption is insufficient. Latency is measured (§13).
- **Restore (startup).** Restore reads persisted **identities** and re-establishes them **without** calling name-based activation paths. It doesn't re-run ensemble activation side effects; membership is resolved at policy time (§9.7). A record is removed only on authoritative absence of its identity. A transient error, a parse failure or an ambiguous legacy name keeps the record. This replaces `Container.restoreActivations`' prune-on-any-failure (V). Persisted identities that exist today (agents' `identity`; any `identity` field the store already supports) are used as-is and never re-resolved by name.
- **Migration of legacy name/filename records** (no historical identity proof):
  - **Resolved:** a unique fresh resolution binds the record to that identity once, and the identity is persisted. This is an **explicit one-time exception to I3**: if the original element was deleted and another already took its name before migration, the binding can't detect it (PD5).
  - **Unresolved** (ambiguous or absent): the record stays as a visible legacy ref. **Policy effect: it blocks the policy read with a retryable, user-actionable error** naming the element (re-activate or deactivate), rather than silently dropping restrictions. The alternative, ignoring it, is fail-open (PD5).
  - **Transient errors** during migration are retried; they never make a record "unresolved" or absent.
- **Persisted format and rollback.** The new format adds an identity to each record and keeps `name`/`filename`, so old code can still read it (it ignores the unknown field and restores by name). Rolling back therefore degrades to today's behavior without losing records, but old code restores by name and so reintroduces name re-binding: an **old-binary rollback** is an operator decision, separate from switching coherence modes on new code. A rollback never rewrites stored identities as names.
- **Sessions.** HTTP sessions remain ephemeral as today: they don't **load** prior activations at connect (V). Per-session persistence stores still exist and may write reporting records; that stays. Unchanged: two sessions of one user never share active refs. Async migration/restore work is bound to `(user, session, lifecycleGeneration)` (a counter bumped whenever the session's activations change or the session is disposed), so late work can't resurrect a disposed session or undo a deactivation that happened meanwhile.
- **Acceptance:** for every activatable type: active element survives LRU/TTL/budget eviction and index loss; a transient list failure deactivates nothing; one unparseable element deactivates nothing; delete + recreate with the same name doesn't inherit the activation (DB) / documented behavior (file, D13). **Plus:** store load failure → enforcement refuses (retryable) and nothing is erased; restore with a transient DB error keeps every record; restore by identity after a rename; unresolved legacy record blocks with an actionable error; migration completing after a deactivation or session dispose changes nothing; old code reads the new format.

### 10.1 Personas
- Shared contract (§9) for definitions; active set via §10.0.
- Sync accessors (`getActivePersona(s)`, `isPersonaActive`, `getPersonaIndicator`, `deactivatePersona`, the Container `activePersona` accessor) read §10.0. `getPersonas()` is deleted. `create`'s duplicate check and `editExistingPersona`'s re-find use validated resolution / the write receipt (§5.6).
- `cleanupStaleActivePersonas`: §10.0 rules (FM17).
- The #2800 async lookups stay. The cross-user lookup leak is fixed (#2806).
- **Acceptance:** cold-cache activation/deactivation/validation (existing #2800 tests); authoritative-mode accessors (indicator, `activePersona` accessor, cleanup); persona policy change visible to the next enforcement and the next export; a deleted active persona per PD1.

### 10.2 Skills
- Shared contract. Refreshed per operation by the gatekeeper; carry policies, so they need a fresh policy snapshot (§9.7). Active set via §10.0 (today name-bound, list-based cleanup).
- Skill `reload_elements` → namespace-scoped clear.
- **Acceptance:** skill policy edit by another process visible to the next enforcement and export; no global flush from one user's reload; delete + recreate doesn't inherit the activation.

### 10.3 Ensembles
- Shared contract. Membership comes from the definition's `metadata.elements` (V; not `ensemble_members`). The policy snapshot resolves membership and members **in the same snapshot** (§9.7), including nested ensembles.
- **No retained member instances** (FM20): `Ensemble.elementInstances` goes away as a cross-request cache; member instances are obtained per activation through the validated facade, and a nested ensemble is activated from its own validated definition, not from an instance retained on the outer ensemble. Runtime activation state that must persist lives in the runtime store keyed by durable identity.
- Active set via §10.0 (today name-bound, list-based cleanup).
- `RelationshipExtractor` empty-member early return leaving stale `ensemble_members` rows: verified in source; separate issue, harmless to policy while membership stays definition-based.
- **Acceptance:** membership change visible to the next enforcement; a member edit visible even when the ensemble is unchanged; nested ensemble closure; nested ensemble edit + reactivation through a previously activated outer ensemble, in both `authoritative` and `versioned`.

### 10.4 Agents
- **Definition** is user-scoped and versioned once; **runtime** (execution state, recovery state, hydrated instance) is user + session scoped, keyed by storage identity.
- Per-instance validation: each hydrated instance carries its definition version and validates before use. Never reset a running agent's state just because its definition was evicted.
- **Recovery binding:** `createRecoveryAgent`/`synchronizeRecoveryState` update the runtime-state store for the storage identity, not a cached definition instance (§5.6).
- `listForFlexibleRead` discovery becomes a hint reader (no watermark side effects that matter).
- Session dispose evicts the session's agent namespace (AD7). Per-session scoping itself is intentional (§5.5, §15 "Answered from the code").
- **Acceptance:** two sessions of the same agent see a definition edit; a running agent's state survives definition eviction; recovery state survives definition eviction and reaches the right identity; no namespace leak after disconnect.

### 10.5 Memories: consume the merged storage contracts

Memory definition reuse fits the shared facade, but mutable heads, pending entries and archives keep their existing authority boundaries.

- **Identity:** `(captured tenant/user, durable owner UUID)`. DB owner is the memory row UUID; file ownership comes from ACTIVE head/sidecar/registry proof. A path/name/frontmatter identifier is a locator or display field. RESERVED adoption, journals, unsafe aliases, unknown evidence and dirty projections block normal use.
- **Mutation authority:** [`IMemoryHeadStore`](../../src/storage/IMemoryHeadStore.ts) reads content and a user/owner/revision token together; conditional writes compare that token atomically. [`DatabaseMemoryStorageLayer`](../../src/storage/DatabaseMemoryStorageLayer.ts) rejects dirty heads, locks/rechecks the owner, qualifies entry/tag projections, returns the final revision after trigger-driven synchronization, and publishes it only after transaction commit. Same-content and A→B→A mutations advance revision. `content_hash` is not a replacement for that token.
- **File composition:** use [`FileMemoryTransactionCoordinator`](../../src/storage/FileMemoryTransactionCoordinator.ts) and [`FileMemoryOwnerSnapshots`](../../src/storage/FileMemoryOwnerSnapshots.ts), constructed for the same captured tenant context. One tracked operation has same-flow ACTIVE authority. No nested transaction/`perform`, independent lock, detached mutation, or cache-specific owner journal. The coordinator gives exclusion/lifetime, not rollback. File UPDATE's exact journal unlink is its commit event; committed tokens survive later hooks/read/fence errors. Unknown outcomes preserve operation/artifact evidence. [Fence contract](file-memory-fence.md) and [owned-head update/recovery contract](../guides/file-memory-owned-head-update.md) remain authoritative.
- **Existing DB coverage:** migrations [0056](../../src/database/migrations/0056_memory_head_revision.sql) and [0057](../../src/database/migrations/0057_memory_tag_revision.sql) advance revision on all parent updates and mark memory heads dirty on direct entry/tag changes. Installation alone does not qualify preexisting data. [Tag invalidation and bounded backfill gates](../developer-guide/database-memory-tag-invalidation.md) require owner inventory, idempotent dirty/revision backfill, separately reviewed locked reconciliation apply, archive phantom protection and all-writer routing. The existing [`DatabaseMemoryReconciliationInspector`](../../src/storage/DatabaseMemoryReconciliationInspector.ts) uses bounded REPEATABLE READ READ ONLY scope; `canApply:false` remains diagnostic, not write authority. A broader policy read adapter may compose this pattern, but cannot treat diagnostic output as a repair receipt or claim parent revision covers archive mutations.
- **Pending state:** identity-keyed runtime overlays retain `(tenant, owner, session, attempt, expected revision)` provenance. A fresh cached definition never overwrites dirty/debounced entries. Different sessions' pending attempts are not automatically pooled or merged. On `EHEADCONFLICT`, preserve the pending attempt and return a typed conflict. Do not automatically reread/reapply append-only entries/retry: rollover, expiry, clear, delete and erasure can make replay resurrect archived or removed content. Any future explicit rebase is a separately reviewed operation proving entry identity, current head/archive/reference/tombstone/expiry state and no resurrection before obtaining a new conditional-write token.
- **Archive bytes:** [`FileMemoryVolumeStore`](../../src/storage/FileMemoryVolumeStore.ts) is merged A-only dormant exclusive publication: private owner/volume/generation reservation, exact UTF-8/hash/YAML/count/writer-identity proof, sole exclusive COMMITTED mkdir event, and original receipt retention after committed failures. Its [publication protocol](file-memory-archive-publication.md) governs this adapter; do not weaken it to cache hash or invent delete/rollback. [`DatabaseMemoryVolumeStore`](../../src/storage/DatabaseMemoryVolumeStore.ts) supplies owner-bound DB volume primitives. Common read/list/cleanup parity, exact receipt semantics, reference checks and erasure/retention are later slices. Immutable bytes can permit body reuse, but every access still needs fresh tenant visibility, owner/reference, expiry and tombstone checks; immutability is not authorization or retention exemption.
- **Release state:** #2867's entry LRU→Map fix is merged. #2868 rollover remains draft; no production caller uses the guarded head primitives as the all-writer path yet. [#2870](https://github.com/DollhouseMCP/mcp-server/issues/2870), [#2871](https://github.com/DollhouseMCP/mcp-server/issues/2871), [#2902](https://github.com/DollhouseMCP/mcp-server/issues/2902), [#2903](https://github.com/DollhouseMCP/mcp-server/issues/2903) and the #2904–#2907 qualification/activation gates remain open. Foundation merges authorize no production data operations or runtime enablement.
- **Remaining live paths:** file list cache-first reads move through the facade. DB auto-load still calls a file-only method and catches failure; hosted startup intentionally skips auto-load. The public delete handler still calls global `clearCache()` although manager deletion has targeted eviction. Hash-index telemetry and watcher scans remain hints.
- **Acceptance:** no stale whole-head overwrite, dirty projection refusal, monotonic revision across ABA/same bytes, original committed/unknown outcomes retained through outer transactions, provenance-preserving conflicts, no stale pending replay after rollover/expiry/erasure, owner recreation isolation, fresh archive access checks, both-backend read/list/cleanup parity before integration, and explicit production routing gate. Reuse the storage contract tests instead of introducing a second persistence test oracle.

### 10.6 Templates
- Only the shared paths (no independent cache). Pre-save normalization (`TemplateManager.save` deriving variables before `super.save`) runs before the frozen serialization (§9.3).
- **Acceptance:** edit, delete and rename by another process visible on the next read, in both modes.

---

## 11. Verified live defects and placement

These are source observations at the reconciled beta base; focused reproductions remain the implementing PR's first gate.

| Evidence | Current behavior | Placement |
|---|---|---|
| [`Container.restoreActivations`](../../src/di/Container.ts) | Restore prunes on `success:false` and exceptions | Early Track A lifecycle fix; preserve uncertain records |
| [`DatabaseActivationStateStore.initialize`](../../src/state/DatabaseActivationStateStore.ts) | Marks initialized before I/O; failure leaves an empty map. This alone does not immediately delete durable rows; later persistence can overwrite them | Distinguish unavailable/empty and define publication protocol |
| [`PersonaManager`](../../src/persona/PersonaManager.ts), [`SkillManager`](../../src/elements/skills/SkillManager.ts), [`EnsembleManager`](../../src/elements/ensembles/EnsembleManager.ts), [`MemoryManager`](../../src/elements/memories/MemoryManager.ts) | Persona cleanup depends on cache presence; skill/ensemble/memory cleanup depends on potentially partial lists | Track A authoritative-absence cleanup before TTL fix |
| [`AgentManager.cleanupStaleActiveAgents`](../../src/elements/agents/AgentManager.ts) | Thrown resolution errors preserve records; an undefined result removes them | Preserve this error distinction; no blanket "every throw deactivates" claim |
| [`ElementListOperations`](../../src/elements/base/ElementListOperations.ts), [`ElementCRUDHandler`](../../src/handlers/ElementCRUDHandler.ts) | List failures can become empty/partial; policy append helpers swallow errors; coalesced persona path is cache-only | Early complete policy/failure propagation; no partial enforcement/export |
| [`PolicyExportService`](../../src/services/PolicyExportService.ts) | Failed acquisition or write leaves prior file; no consumer-confirmed unavailable contract | AD2 gates server/consumer fix; hosted destination also unresolved |
| [`MemoryManager.getAutoLoadMemories`](../../src/elements/memories/MemoryManager.ts), [`Container`](../../src/di/Container.ts) | DB path calls a file-only method and catches failure; hosted startup intentionally skips auto-load | Separate PD7 product-visible fix; do not auto-load every HTTP user's memories at boot |
| [`LRUCache.entries`](../../src/cache/LRUCache.ts) | Enumeration lacks TTL filtering | Wait until cleanup is independent of residence |
| [Public memory delete handler](../../src/handlers/element-crud/deleteElement.ts) | Still calls global clear although manager deletion has targeted eviction | Scoped clear only with foreign-public-row/subclass strategy |

The wider §5 inventory remains a migration checklist: mutable cached instances, retained ensemble/agent definitions, index-driven history, foreign visibility, namespaces and unresolved file alias behavior. Recheck each source path when implementing it; do not infer that a foundation merge repaired these cache paths. #2806 user lookup dedup and #2867 entry Map are already merged. #2801 is a validated-hit optimization after correctness. Search/relationship indexes stay named advisory discovery, and unrelated relationship/test-harness defects remain separate. Core cache architecture is still unimplemented; merged memory contracts constrain its integration.

---

## 12. Test strategy and acceptance matrix

**reproduction stage (before any design code; fail on the base commit):**
- File mode: external edit → `listSummaries()`/`getIndexedPaths()`/`MemoryManager.list` → stale served (FM1); `notifySaved` re-stat window (FM14); load-before-first-scan; delete-before-first-scan; same-size/preserved-mtime rewrite; `_index.json` restore; directory remove/recreate.
- Active-set cleanup: reproduce persona cache misses and skill/ensemble/memory partial or failed lists; verify agent thrown errors preserve records and distinguish an undefined result (the §10.0 fix makes these pass).
- Policy export: cold cache → exported policy missing an active persona's patterns (FM24).
- Query/body/parse **counting instrumentation** (test-only wrappers) and a baseline.

**Acceptance suite (both modes, every element type; run against `authoritative` and `versioned`):**
- All tests from the earlier attempt (branch `archive/2799-selective-eviction-attempt`): unchanged refresh; an update within the same millisecond is still detected; delete; rename/swap/same-name replacement (full and incremental); the in-flight load, incremental same-name and added-row cases; the five deterministic PostgreSQL counterexamples for the three gaps in §2.2; the end-to-end MCP check that cached entries survive an unchanged refresh (as a count assertion). Assertions adapted to "validated content/version", not "eagerly evicted".
- Version/content atomicity; own-save V2 vs external V3; mutation without save; `afterSave` mutation; failed/rolled-back writes; clear/dispose during loads and saves; index-state churn beyond 256 users (injected small limit); independent primary/path LRU expiry; budget pressure; first-observed and deleted in-flight identities; every scan consumer; **every row of §5**.
- **Mechanism counterexamples:** old REPEATABLE READ observation completing after a newer one (FM22); pre-UUID concurrent same-name creates, including clear and observations between commit and binding; exact token + entry version across `await`s and own saves; loader's own read accepted as an observation.
- **File:** unchanged stat hints with changed bytes (in-place, same size, preserved mtime); open-fd atomic replacement during a read; aliased paths (symlink, case); active element across the application's own atomic-rename save (identity stable); same-path recreate (per D13); root/member mixed-view detection under the selected D12 contract (or its explicitly approved weaker bound).
- **Retained instances:** nested ensemble edit + reactivation through a retained outer ensemble; agent recovery state after definition eviction.
- **Activation identity:** delete + recreate same name for every activatable type; transient list failure; eviction; TTL expiry after the §10.0 change.
- **Memory concurrency:** two concurrent sessions/processes receive a successful conditional write or a typed conflict retaining their pending attempt; no blind append replay; a rollover racing another session's pending save neither restores sealed entries nor loses the volume index.
- **Cross-process/replica:** two storage instances (and two server instances on one DB): remote edit/delete; a late-commit long transaction; name ambiguity and recreate; visibility revocation; foreign public rows; two sessions of the same agent; another user with the same name.
- **Policy:** snapshot before vs after commit; multi-member transactional updates; injected validation failure → enforcement refuses (retryable) and export/consumer enforce the agreed D14 unavailable contract even if publication fails; transient error preserves activations; deadlock relief completeness on a cold cache.
- **Ordering, snapshot and lifecycle counterexamples:** a snapshot context that first touches X after another context's newer observation (FM22); pre-UUID create binding against an already modified known UUID; clear between commit and binding; an old pinned view after another operation's publish (no mixing, no publication); cold root with a new nested member in one transactional update (nested closure inside one snapshot); two processes writing the file portfolio; if D12 coordination is selected, a crash at each specified boundary preserves unknown evidence and blocks until qualified recovery; export failure right after a restrictive activation (bridge rejects stale permissive state under its agreed consumer contract, including a failed unavailable-marker write); activation store load failure and restore errors (§10.0 acceptance).
- **Recovery, eviction and persistence counterexamples:** an old-snapshot context first-touching X after X's state was evicted following a newer observation (the `discardedAt` bound rejects it); create binding to a UUID whose state was evicted; `release_deadlock`, `abort_execution`, `confirm_operation` and targeted deactivate succeed with an unresolved legacy record and with the store `unavailable`; `permission_prompt` denies in that state; activation/deactivation failure cannot grant permissions, ambiguity blocks policy-dependent work and remediation remains usable; conditional D12 crash qualification; no lease is stolen by PID, age or missing metadata.
- **Existing revision and any separately approved migration (AD1):** direct SQL parent updates advance revision even with an unchanged/stale stored hash; changed-revision observations reread raw bytes and verify digest before parsed-body reuse; same-byte ABA and direct child/tag invalidation; existing dirty/backfill/reconciliation gates. If hash maintenance is selected, qualify Unicode/backslash parity, privileges and rolling compatibility separately.
- **Determinism:** injectable barriers (`afterRead`, `beforePublish`, `betweenWriteAndPublish`, `afterSave`, `beforeBind`) and IPC barriers for multi-process tests. No sleeps. No timing gates.

---

## 13. Performance measurement plan
- Instrument: SQL statements (validation data queries vs transaction/RLS setup), rows, raw-content bytes, file bytes digested, YAML parses, hydration CPU, transaction/connection occupancy, latency p50/p95/p99, memory after churn, in-flight bookkeeping after failures.
- Matrix: 0/1/10/100 active refs; small/large catalogs; warm/cold; unchanged/edit/delete; one and multiple users; one and two replicas; file portfolios of realistic size for the D7 digest cost, **including list-heavy workloads** (a strict file `list()` of N elements digests N bodies); nested ensemble depth for the in-transaction dependency parsing; export frequency (each export is a fresh acquisition); synchronous activation-persistence latency; publications rejected by the `discardedAt` bound after evictions.
- Compare **beta (legacy)**, **authoritative**, **versioned**.
- CI asserts **counts** (P1–P3), never timings (performance is never gated on timings). Latency thresholds are set from the baseline.

---

## 14. Delivery plan: bite-sized beta PRs

Delivery policy requires small independently reviewable PRs targeting `beta`. The earlier large feature-branch landing recommendation is superseded. No single landing PR bundles activation changes, memory routing, migrations and the complete cache rewrite. Foundations land dormant; one separately qualified enablement boundary follows only when the all-path and storage release gates are met.

### 14.1 Track A: early live correctness fixes

Each fix starts with a focused reproduction, has a clear behavior/rollback boundary, and gets exact-head review and required checks.

1. **Activation lifecycle/cleanup:** distinguish empty from unavailable; preserve records on restore errors; make persona/skill/ensemble/memory cleanup act only on authoritative absence and preserve agent error behavior. Split these by cohesive boundary rather than one all-manager rewrite. Any fail-closed change includes working infrastructure-first remediation.
2. **Live policy collection:** replace partial error swallowing with complete snapshot or typed unavailable. Address enforcement inputs early, including complete nested closure and activation readiness. Do not wait for performance redesign to repair the live correctness gap.
3. **Bridge export:** fresh complete policy and consumer-confirmed unavailable/freshness semantics; AD2 must cover marker-write failure and hosted scope before enabling the change. Until then record the gap and do not promise a fail-closed bridge from server writes alone.
4. **DB auto-load:** separate product-visible fix after PD7; hosted startup skip remains intentional.

TTL enumeration fixes wait until cleanup is independent of cache residence. Namespace-scoped clear waits for the foreign-public-row strategy (or explicit public-row invalidation), including subclass/index caches.

### 14.2 Dormant foundations and one enablement

| Slice | Focused beta delivery | Gate |
|---|---|---|
| Inventory/repros | Current source claims, all publication/read/retained-instance paths, counting baseline | Reproductions distinguish hypotheses and already merged fixes |
| Read capability | Context-bound observations, exact bytes/version/access, adapter compatibility; no new memory write protocol | Backend contract tests, existing memory scope/token consumption, bounded complete enumeration |
| Immutable definitions | DTO boundary and type-by-type runtime separation, including ensemble members/agent recovery/pending memory provenance | No mutable retained definitions; explicit compatibility tests |
| Activation foundations | Identity/readiness/persistence protocol, legacy migration and remediation in separately reviewed slices | AD/PD decisions and no permission grant on failure/ambiguity; existing memory owner identity preserved |
| Coherence foundations | Publication ordering, logical clocks, pinned views, scoped certificates, bounded bookkeeping; all read facade paths | Dormant mode, race/isolation/clear/eviction acceptance per small PR |
| Storage qualification | Use merged revision and owner/archive contracts; separately justified migrations only | Existing dirty/backfill/reconciliation/archive/erasure/all-writer gates; no production data authorization from merge |
| Single enablement | Small PR selects the qualified mode/default after every §5 path is migrated or explicitly advisory | Both backends/all six types, policy/activation/identity acceptance, required checks/reviews, deployment topology/rollback plan and named go/no-go |
| Optimization/cleanup | #2801 validated cache hits, measured narrowing, optional hints; removal after stable window | Count targets, documented beta soak, no new authority shortcuts |

`authoritative` is an oracle/kill switch only after the same all-path gate; a partially migrated no-cache mode is labeled partial. Runtime fallback does not roll back schema, dirty qualification or durable owner state. Every slice states active versus dormant behavior and refreshes current beta before qualification; no prolonged feature branch is an approved delivery mechanism.

Risks remain immutable-instance dependencies, projection/revision coverage, pending-attempt semantics, file digest cost, unsupported filesystems, public visibility, activation migration/failure, snapshot duration and bounded metadata. Tests and measurements precede enablement. D12 portfolio coordination remains optional/open and cannot silently expand the memory crash model.

---

## 15. Open decisions and scope ledger

Adopted reconciliation and bite-sized delivery do not constitute blanket acceptance of the original recommendations. Each implementation slice must settle its affected decisions before changing behavior; independent Track A reproduction/fixes need not wait for every cache-engine choice. Proposed interfaces, targets and recommendations do not imply runtime or operator execution authorization.

**Accepted constraints:** complete fail-closed policy acquisition with working remediation; existing memory ownership/revision/commit authority; immutable definition/runtime separation as design direction; small dormant beta foundations and one qualified enablement. Product details and transaction protocols below remain open.

| ID | Open question / alternatives and recommendation | Status |
|---|---|---|
| **AD1** | Use existing all-parent `storage_revision` as cache observation candidate with exact access/projection coverage and raw digest verification on changed revisions. Optional separately qualified DB-maintained hash may optimize consistency. Never require a redundant revision/hash migration just because the old design omitted 0056; memory dirty/backfill/reconciliation gates remain mandatory. | Open projection/optional migration decision; no execution approval |
| **AD2** | Bridge unavailable contract: explicit marker versus restrictive missing/unreadable/expired handling. Recommendation: consumer-recognized unavailable plus freshness enforcement, including failed marker writes. Decide single-user-only export or authenticated requester/session destination for hosted mode. | Open consumer/scope proof; export fix gated |
| **AD3** | Complete decision-start policy snapshot: nested members, static rules, defaults, activation identities/readiness. Recommendation: yes, with bounded cycles/depth/rows. Revocation-to-side-effect fencing is separate. | Open precise snapshot semantics |
| **AD4** | Deployment replicas, sticky sessions, primary/read replicas, pool mode and transaction duration. Assume no stickiness correctness, policy reads on primary, local transaction timeouts until verified. | Information required |
| **AD5** | Foreign/public rows: initially avoid cross-request reuse under requester visibility, or provide complete requester-scoped certificates. Memory summaries need ownership projection. Scoped clear requires this strategy or explicit public invalidation. | Open; recommendation no foreign reuse initially |
| **AD6** | Immutable DTOs plus separate memory/agent/ensemble runtime state; cloning only a migration aid. Freeze in tests to expose mutation assumptions. | Open compatibility details; direction retained |
| **AD7** | Release agent session cache namespace after execution finishes/aborts while preserving durable runtime recovery. | Open lifecycle boundary |
| **AD8** | Memory integration consumes existing stores/coordinator; pending state retains session/attempt provenance on typed conflict. Explicit future rebase must prove no resurrection; no blind retries, new locks or owner protocol. Common archive/cleanup parity and release gates precede rollover enablement. | Existing authority fixed; integration/rebase choices open |
| **AD9 (reconciled gap)** | Exact activation persistence/publication transaction: failed activation may add allow rules, so cannot be retained as "more restrictive" by assumption. No permission grant before proven durable publication; ambiguity becomes unavailable with idempotent attributed remediation. | Open protocol; not satisfied by fire-and-forget persistence |
| **PD1** | Deleted active identity: recommended performing session explicitly acknowledges/deactivates with audit; other sessions block until acknowledgement/remediation. Uncertainty never means deletion. | Open product behavior |
| **PD2 / S1** | File multi-definition policy consistency: optional coordinated portfolio protocol composed with existing tenant scopes versus explicitly qualified per-file bound. External edits, unsupported shared filesystems and crash guarantees remain limits. No PID/age stealing or parse-only automatic recovery. | Open; no seqlock implementation selected |
| **PD3** | Recreated name never inherits activation. DB UUID and owned-file-memory UUID already support distinction; general nonmemory file IDs/import/copy rules need design. | Open general format/product confirmation |
| **PD4** | Strict authoritative observations by default versus measured stat-based ordinary file hint path. Recommendation strict; bounded stale only via named non-policy API. | Open performance tradeoff |
| **PD5** | Legacy activation migration: one audited unique fresh name binding is an explicit historical-identity exception; ambiguous/absent records stay unresolved and block with remediation, transient errors preserve them. Old-binary rollback reintroduces name binding and needs operator decision. | Open migration/product approval |
| **PD6** | Count targets, named enablement/soak owner, authoritative kill switch only after all-path gate. Shadow comparison optional until justified; schema rollback is separate. | Open measured thresholds/operations |
| **PD7** | DB auto-load product-visible bug fix with release note/partial failure reporting; hosted startup skip remains intentional. Context cap only after measurement. | Open product confirmation |
| **PD8** | Hosted fail-closed errors with actionable retry/backoff/remediation and sustained-failure alerting. | Open operational UX details |
| **S2** | First enablement may keep file cross-request body reuse disabled via adapter capability (no manager mode branches), while still meeting owner, policy and read correctness. It does not waive owned-memory UUIDs or preexisting storage gates. | Open scope recommendation |
| **S3** | Defer aggregate per-user/type revision fast paths (not existing per-row `storage_revision`), LISTEN/NOTIFY, distributed hints, shadow tooling, search-index redesign, foreign-row caching and general nonmemory creation-ID migration as compatible with required identity guarantees. | Open scope; cannot cut immutable/policy/activation/isolation/publication/all-path/storage gates |

Roles still to assign: bridge consumer owner, activation protocol owner, deployment/topology qualification owner, operator/data-maintenance owner, kill-switch operator, and beta soak go/no-go owner. Record answers with evidence in the implementing slice, not inferred from this combined document.
