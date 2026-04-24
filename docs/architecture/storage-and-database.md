# Storage Architecture and Database Internals

**Audience:** Developers extending, debugging, or adding new element types to DollhouseMCP.

For operator-facing configuration of storage backends and environment variables, see the [Deployment & Configuration Guide](../guides/deployment-configuration.md).

---

## Contents

1. [Architecture overview](#architecture-overview)
2. [Transport and storage interaction](#transport-and-storage-interaction)
3. [Interface hierarchy](#interface-hierarchy)
4. [Filesystem storage path](#filesystem-storage-path)
5. [Database storage path](#database-storage-path)
6. [Schema design](#schema-design)
7. [Row-level security](#row-level-security)
8. [Migrations](#migrations)
9. [State stores and the sessions table](#state-stores-and-the-sessions-table)
10. [DI registration and backend selection](#di-registration-and-backend-selection)
11. [Authentication architecture](#authentication-architecture)
12. [Shared pool](#shared-pool)
13. [Testing database code](#testing-database-code)

---

## Architecture overview

DollhouseMCP's storage system has two independent dimensions:

**The I/O abstraction** (`IStorageBackend`) — raw file operations: list, stat, read. This exists so storage layers can be tested with mocks without touching the filesystem.

**The business-logic abstraction** (`IStorageLayer` / `IWritableStorageLayer`) — scanning, indexing, caching, change detection, and (in database mode) persistence. Element managers depend only on these interfaces; they never import a concrete backend.

The backend is selected at startup via the `DOLLHOUSE_STORAGE_BACKEND` environment variable. Setting it to `database` swaps every `IStorageLayer` implementation for its database-backed counterpart through DI — no element manager changes required.

```
               ┌─────────────────────────────────┐
               │        BaseElementManager        │
               │ (PersonaManager, SkillManager…)  │
               └────────────┬────────────────────┘
                            │ depends on
                            ▼
               ┌─────────────────────────────────┐
               │   IStorageLayer /                │
               │   IWritableStorageLayer          │
               └──────┬──────────────────┬────────┘
                       │ file mode        │ database mode
        ┌──────────────▼───┐     ┌────────▼──────────────────┐
        │ ElementStorageLayer │   │ AbstractDatabaseStorage-  │
        │ MemoryStorageLayer  │   │ Layer                     │
        └──────────┬──────┘     │  ├─ DatabaseStorageLayer    │
                   │             │  └─ DatabaseMemoryStorage-  │
        ┌──────────▼──────┐     │     Layer                   │
        │ IStorageBackend │     └───────────────────────────┘
        │  (FileStorage-  │
        │   Backend)      │
        └─────────────────┘
```

The factory that produces storage layers (`IStorageLayerFactory`) is the seam. `BaseElementManager.createStorageLayer()` calls it at construction time:

```typescript
// src/elements/base/BaseElementManager.ts
protected createStorageLayer(): IStorageLayer {
  return this.storageLayerFactory.createForElement(this.elementType, {
    elementDir: this.elementDir,
    fileExtension: this.getFileExtension(),
    scanCooldownMs: getValidatedScanCooldown(),
  });
}
```

In file mode the factory is `FileStorageLayerFactory`. In database mode, `DatabaseServiceRegistrar` registers `DatabaseStorageLayerFactory` over it.

---

## Transport and storage interaction

### The storage layer is transport-agnostic

Transport (stdio vs HTTP) and storage backend (file vs database) are orthogonal configuration axes. Switching transport does not change how elements are read or written. Switching storage backend does not change how MCP messages are received. All four combinations are valid deployments.

The only place transport touches storage is at identity resolution: the storage layer needs to know which user's data to operate on, and that identity comes from the active transport session.

### How SessionContext flows to storage

Every MCP tool call runs inside a `ContextTracker.runAsync()` scope. That scope carries a frozen `SessionContext`:

```typescript
// src/context/SessionContext.ts
export interface SessionContext {
  readonly userId: string;    // 'local-user' for stdio, JWT sub for HTTP
  readonly sessionId: string; // 'default' for stdio, UUID for HTTP
  readonly tenantId: string | null;
  readonly transport: 'stdio' | 'http';
  readonly createdAt: number;
  readonly displayName?: string;
  readonly email?: string;
}
```

In stdio mode, `createStdioSession()` reads `DOLLHOUSE_USER` (defaulting to `'local-user'`) and `DOLLHOUSE_SESSION_ID` (defaulting to `'default'`) from the environment once at startup. The resulting `SessionContext` is static for the life of the process.

In HTTP mode, `createHttpSession()` is called per connection, generating a unique UUID `sessionId` for each session. In the current implementation (Phase 2), `userId` defaults to `'http-user'`; Phase 3 wires JWT authentication to populate `userId`, `tenantId`, and `displayName` from the auth provider.

The `SessionContext` is set on the `ContextTracker`'s `AsyncLocalStorage` before any handler code runs. Storage layers read it on demand through a `UserIdResolver` callback — they never hold a reference to the `SessionContext` itself.

### The UserIdResolver pattern

Storage layers are singletons in the DI container — one instance per element type, created at startup. In HTTP mode, each request serves a different user. If the storage layer captured `userId` at construction time, it would hard-code the wrong user for every subsequent request.

The `UserIdResolver` callback solves this:

```typescript
// src/database/UserContext.ts
export type UserIdResolver = () => string;

export function createUserIdResolver(contextTracker: ContextTracker): UserIdResolver {
  return () => {
    const session = contextTracker.getSessionContext();
    if (!session) {
      throw new UserContextMissingError('No active user context for database operation');
    }
    validateUserId(session.userId);
    return session.userId;
  };
}
```

Every database operation calls `this.getCurrentUserId()` — which calls the resolver — to read the current user from `AsyncLocalStorage` at call time. In stdio mode the session is static, so every call returns the same UUID. In HTTP mode, each request has its own `AsyncLocalStorage` scope, so concurrent requests resolve to their respective users without any mutex or thread-local state.

Calling a database operation from outside a `ContextTracker.runAsync()` scope throws `UserContextMissingError`. There is no silent fallback: a fallback would silently cross-contaminate tenants.

The resolver is also the right seam for tests: `fixedUserId(userId)` (from `tests/integration/database/test-db-helpers.ts`) wraps a literal UUID as a `UserIdResolver`, letting integration tests construct storage layers without a live `ContextTracker`.

### What changes between deployment modes

The following table summarizes the storage-relevant differences between common deployment configurations:

| Configuration | userId source | Per-user file paths | Database queries |
|---------------|--------------|---------------------|-----------------|
| stdio + file | `DOLLHOUSE_USER` env var | One set of directories for that user | Not applicable |
| stdio + database | Database bootstrap UUID | Not applicable | Always same UUID from static session |
| HTTP + file | Per-request session (currently `http-user`) | Resolver reads `AsyncLocalStorage` per call | Not applicable |
| HTTP + database | Per-request session (JWT sub in Phase 3) | Not applicable | Resolver reads `AsyncLocalStorage` per call |

In file mode, multi-user isolation is directory-level: each user's elements live under `~/.dollhouse/users/<userId>/portfolio/`. In database mode, multi-user isolation is row-level: every query carries an explicit `user_id` predicate and RLS enforces it independently at the database engine level.

---

## Interface hierarchy

### IStorageBackend

`src/storage/IStorageBackend.ts`

The lowest level — pure I/O, no business logic.

| Method | Description |
|--------|-------------|
| `listFiles(dir, ext)` | List files in a directory, filtered by extension |
| `stat(absolutePath)` | Metadata (mtime, size) for one file |
| `statMany(dir, paths)` | Parallel stat of multiple files; missing files silently omitted |
| `readFile(absolutePath)` | Full file contents as UTF-8 string |
| `directoryExists(dir)` | Returns true if the directory exists |

`FileStorageBackend` is the only production implementation. It wraps `FileOperationsService`, which provides path validation, atomic reads, and audit logging. Pass a mock to `ElementStorageLayer` in tests to avoid all I/O.

### IStorageLayer

`src/storage/IStorageLayer.ts`

The interface that element managers depend on for read operations and index management.

| Method | Description |
|--------|-------------|
| `scan()` | Diff current state against last snapshot; returns added/modified/removed/unchanged paths |
| `listSummaries(opts?)` | Trigger scan and return `ElementIndexEntry[]`. Pass `{ includePublic: true }` for cross-user public elements |
| `getIndexedPaths()` | All known paths/IDs after a scan |
| `getPathByName(name)` | O(1) name-to-path lookup without triggering a scan |
| `hasCompletedScan()` | True once at least one scan has completed |
| `notifySaved(rel, abs)` | Called after a file write to update the index without a full rescan |
| `notifyDeleted(rel)` | Called after a file delete to remove from the index |
| `invalidate()` | Force the next scan to hit disk by resetting the cooldown |
| `clear()` | Reset all state |
| `getNameById?(id)` | Optional reverse lookup (implemented by database layers where IDs are UUIDs) |

### IWritableStorageLayer

Extends `IStorageLayer` for database mode, where the storage layer is the persistence mechanism (no files exist).

| Method | Description |
|--------|-------------|
| `writeContent(type, name, content, metadata, opts?)` | Upsert an element row, replace its tags atomically, return the UUID |
| `deleteContent(type, name)` | Delete element row; cascades handle child records |
| `readContent(relativePath)` | Read `raw_content` by element UUID |

File-backed layers (`ElementStorageLayer`, `MemoryStorageLayer`) do not implement this interface. The type guard `isWritableStorageLayer(layer)` is the canonical way to detect which mode is active:

```typescript
// src/storage/IStorageLayer.ts
export function isWritableStorageLayer(layer: IStorageLayer): layer is IWritableStorageLayer {
  return 'writeContent' in layer
    && typeof (layer as IWritableStorageLayer).writeContent === 'function';
}
```

`BaseElementManager`'s persister uses this guard to branch between writing a file (file mode) and calling `writeContent` (database mode).

---

## Filesystem storage path

### ElementStorageLayer

`src/storage/ElementStorageLayer.ts`

Handles all non-memory element types in file mode: personas, skills, templates, agents, and ensembles (all `.md` files).

**Scan lifecycle:**

1. `scan()` is called. If within the cooldown window (`scanCooldownMs`, default 1 second), it returns an empty diff immediately without touching disk.
2. Concurrent calls to the same directory return the same in-flight promise rather than starting redundant scans.
3. On the first scan for a directory, it lists all `.md` files and stats them in parallel (`statMany`).
4. The result is diffed against `StorageManifest` (a mtime snapshot map) to produce added/modified/removed lists.
5. For added and modified files, frontmatter is parsed and entries are written to `MetadataIndex`.
6. Removed files are evicted from the index.
7. The manifest and `lastScanTimestamp` are updated.

**Multi-user state isolation:**

`ElementStorageLayer` maintains a `Map<string, DirScanState>` keyed by resolved directory path. When an HTTP-mode resolver provides different directories per user, each user gets independent manifest, index, cooldown, and in-flight scan state. A scan failure or stale cache for user A does not affect user B.

**Path resolution:**

In single-user (stdio) mode, the directory is static. In HTTP mode, an `elementDirResolver` callback is provided. The resolver reads the current user from `ContextTracker`'s `AsyncLocalStorage`, so the active user's portfolio directory is resolved per-call without storing it in the layer.

### MemoryStorageLayer

`src/storage/MemoryStorageLayer.ts`

Memories use pure YAML files (no frontmatter separator) and live across a multi-directory layout:

```
memories/
  system/           — system-provided memories
  adapters/         — adapter-specific memories
  2024-01-15/       — user-created, date-folder memories
  2024-01-16/       — (multiple date folders)
  legacy.yaml       — root-level legacy files
  _index.json       — cold-start persistence cache
```

`MemoryStorageLayer` differs from `ElementStorageLayer` in several ways:

- **Multi-directory enumeration:** it discovers `system/`, `adapters/`, all `YYYY-MM-DD/` folders, and the root in a single scan pass.
- **Cold-start persistence:** on first access it tries to restore from `_index.json`. This avoids a full directory walk on every server restart.
- **Deduplication:** the same memory name appearing in multiple date folders keeps the most-recently-modified copy only (`deduplicateByName`).
- **Debounced index writes:** after any index change, it schedules a write to `_index.json` debounced to 2 seconds by default.

`MemoryMetadataExtractor` reads YAML-specific metadata fields (`autoLoad`, `priority`, `memoryType`, `totalEntries`) that do not appear in other element types.

### FileStorageBackend

`src/storage/FileStorageBackend.ts`

Wraps `FileOperationsService` to satisfy `IStorageBackend`. The service is the security boundary — path validation, traversal prevention, and audit logging happen there. `FileStorageBackend` is a thin adapter. Always prefer passing a mock `IStorageBackend` in tests rather than a real `FileStorageBackend`.

---

## Database storage path

### AbstractDatabaseStorageLayer

`src/storage/AbstractDatabaseStorageLayer.ts`

Base class for `DatabaseStorageLayer` and `DatabaseMemoryStorageLayer`. Implements all `IStorageLayer` methods and `readContent`. Subclasses implement `writeContent` and `deleteContent`.

**In-memory index:**

The layer maintains two maps for O(1) lookups:
- `nameToIdMap: Map<string, string>` — element name → UUID
- `idToNameMap: Map<string, string>` — UUID → element name

These are populated on scan and updated on every write or delete. In database mode, `getPathByName` returns a UUID, and `getNameById` (the optional reverse) resolves names from UUIDs.

**Scan behavior:**

The first scan (`lastScanTimestamp === null`) is always a full query. Subsequent scans are incremental: the query adds `WHERE updated_at > lastScanTimestamp`. The result tells the layer which rows are new or changed. Removals are only detected on full scans (when no timestamp filter is applied).

The query uses an explicit `userId` predicate alongside RLS as defense-in-depth. This ensures the `idx_elements_scan` composite index `(user_id, element_type, updated_at)` is used efficiently:

```typescript
// src/storage/AbstractDatabaseStorageLayer.ts
return tx
  .select({ id: elements.id, name: elements.name, updatedAt: elements.updatedAt })
  .from(elements)
  .where(and(
    eq(elements.userId, this.userId),
    eq(elements.elementType, this.elementType),
    gt(elements.updatedAt, this.lastScanTimestamp!),
  ));
```

**listSummaries and includePublic:**

When `includePublic: true`, the owner predicate expands to `user_id = :me OR visibility = 'public'`. RLS's `elements_select` policy already allows reading public rows, so the database returns them. Tags for cross-user public elements go through a separate `batchLoadTags` path that works within the element_tags RLS context (which has its own public-visibility policy from migration 0006).

Foreign-owned elements (when `includePublic` is active) are identified by their `userId` field and are not cached in the per-manager LRU — only the calling user's own elements are cached.

**readContent:**

Reads `raw_content` by UUID using a primary-key lookup. The only predicate is `WHERE id = :uuid`. A user_id filter is intentionally absent here: the `elements_select` RLS policy handles cross-user visibility, so adding a filter would break reading public elements.

### DatabaseStorageLayer

`src/storage/DatabaseStorageLayer.ts`

Handles all non-memory element types (personas, skills, templates, agents, ensembles).

**writeContent — the write sequence:**

1. Parse frontmatter with `FrontmatterParser`.
2. Compute `content_hash` (SHA-256 hex) and `byte_size`.
3. Extract `body_content` (everything after the frontmatter separator) for the FTS vector.
4. Open a `withUserContext` transaction (sets `app.current_user_id` for RLS):
   - If `options.exclusive` is set, attempt an `INSERT`. A unique-constraint violation (error code `23505`) is caught and re-thrown as a human-readable "already exists" error matching the file-mode format.
   - Otherwise, upsert via `ON CONFLICT (user_id, element_type, name) DO UPDATE`.
   - Replace tags atomically within the same transaction using `replaceTags` (delete all, then insert).
5. Update the in-memory index (`setIndex`).
6. Fire-and-forget relationship extraction via `RelationshipExtractor.extractAndPersist`. This runs after the core transaction commits, so a relationship parse failure cannot roll back the element save.

The `buildUpdateSet()` pattern strips the conflict-target columns (`userId`, `elementType`, `name`) and forces `updatedAt = NOW()`. This means adding a new column requires exactly one change in the values object — it is included in both insert and update paths automatically.

**deleteContent:**

Deletes the row with `WHERE user_id = :me AND element_type = :type AND name = :name`. Cascading foreign keys handle `element_tags`, `element_relationships`, `agent_states`, and `ensemble_members`.

**RelationshipExtractor:**

`src/storage/RelationshipExtractor.ts`

Parses frontmatter fields that denote cross-element references:
- Agents: `activates.personas[]`, `activates.skills[]`, etc. → `element_relationships`
- Templates: `references[]`, `requires[]` → `element_relationships`
- Ensembles: `members[]` → `ensemble_members` (richer schema with role, priority, activation mode, conditions, and intra-ensemble dependencies)

Relationship extraction is soft-integrity — it runs after the main transaction commits. Failure is logged but does not propagate to the caller.

### DatabaseMemoryStorageLayer

`src/storage/DatabaseMemoryStorageLayer.ts`

Extends `AbstractDatabaseStorageLayer` for memories. Memories differ from other elements in three ways:

1. **Pure YAML** — parsed with `SecureYamlParser` and `MemoryMetadataExtractor` rather than `FrontmatterParser`.
2. **Split-source entries** — individual memory entries are stored in the `memory_entries` table. When `writeContent` is called, it syncs all entries from the parsed YAML into `memory_entries` within the same transaction as the element upsert. This means the element row, its tags, and all its entries either all commit or all roll back together.
3. **totalEntries** — `mapRowsToSummaries` is overridden to join against `memory_entries` counts, so list summaries include the number of stored entries without loading full content.

**Entry-level API:**

In addition to the `IWritableStorageLayer` methods, `DatabaseMemoryStorageLayer` exposes:

| Method | Description |
|--------|-------------|
| `addEntry(memoryId, entry)` | Upsert a single entry by `(memory_id, entry_id)` |
| `getEntries(memoryId, opts?)` | Read entries with optional since/until/privacyLevel/tags/limit filters |
| `removeEntry(memoryId, entryId)` | Delete a single entry |
| `purgeExpiredEntries()` | Delete all entries where `expires_at < NOW()` |

The default limit for `getEntries` is 1,000 rows. Pass an explicit `limit` for hot paths that only need a small window.

---

## Schema design

The database uses PostgreSQL with Drizzle ORM. All Drizzle-managed schema definitions are in `src/database/schema/`. PostgreSQL-specific features that Drizzle cannot auto-generate (generated columns, RLS policies, partial indexes, custom functions) are applied via hand-written SQL migration files in `src/database/migrations/`.

### Strategy C: raw content as source of truth

Every element row stores the original YAML/markdown content in `raw_content`. Metadata columns (`name`, `description`, `version`, `author`, `tags`, etc.) are extracted from that content and indexed for queries. This means:

- The content file can always be reconstructed from the database row.
- Metadata columns can be re-extracted if the extraction logic changes.
- There is no secondary serialization format to keep in sync.

### Table reference

#### users

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | Auto-generated |
| `external_id` | varchar(255) | Auth provider's user ID |
| `username` | varchar(255) NOT NULL | Unique; used for stdio bootstrap |
| `email` | varchar(255) | |
| `display_name` | varchar(255) | |
| `created_at` | timestamptz NOT NULL | |
| `updated_at` | timestamptz NOT NULL | |

Identity fields live exclusively in `users`. `user_settings` is a separate table to keep them isolated.

#### user_settings

One row per user. Configuration fields are JSONB to allow schema evolution without migrations.

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | uuid PK → users.id CASCADE | |
| `github_config` | jsonb NOT NULL DEFAULT `{}` | GitHub integration settings |
| `sync_config` | jsonb NOT NULL DEFAULT `{}` | Sync configuration |
| `autoload_config` | jsonb NOT NULL DEFAULT `{}` | Autoload preferences |
| `retention_config` | jsonb NOT NULL DEFAULT `{}` | Data retention settings |
| `created_at` | timestamptz NOT NULL | |
| `updated_at` | timestamptz NOT NULL | |

#### elements

The central table. All element types (personas, skills, templates, agents, ensembles, memories) share one table, discriminated by `element_type`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | Auto-generated; used as `relativePath` in DB mode |
| `user_id` | uuid → users.id CASCADE | Denormalized for RLS and composite indexes |
| `raw_content` | text NOT NULL | Full source of truth |
| `body_content` | text | Markdown body after frontmatter; used for FTS vector |
| `content_hash` | char(64) NOT NULL | SHA-256 hex of `raw_content` |
| `byte_size` | integer NOT NULL | |
| `element_type` | varchar(32) NOT NULL | `personas`, `skills`, `templates`, `agents`, `memories`, `ensembles` |
| `name` | varchar(255) NOT NULL | Unique within `(user_id, element_type)` |
| `description` | text | |
| `version` | varchar(32) | |
| `author` | varchar(255) | |
| `element_created` | date | Date from frontmatter's `created:` field |
| `metadata` | jsonb NOT NULL DEFAULT `{}` | Non-standard frontmatter fields |
| `visibility` | varchar(32) DEFAULT `private` | `private` or `public`; CHECK constraint enforced by migration 0005 |
| `memory_type` | varchar(16) | NULL for non-memory elements |
| `auto_load` | boolean | NULL for non-memory elements |
| `priority` | integer | NULL for non-memory elements |
| `fts_vector` | tsvector GENERATED ALWAYS | Full-text search over `name \|\| description \|\| body_content`; added by migration 0004, not in Drizzle schema files |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Updated by upserts via `updatedAt: sql\`NOW()\`` |

**Unique constraint:** `(user_id, element_type, name)` — the conflict target for all upserts.

**Indexes on `elements`:**

| Index | Columns / Predicate | Purpose |
|-------|---------------------|---------|
| `idx_elements_user_type_name` | `(user_id, element_type, name)` UNIQUE | Upsert conflict target; by-name lookup |
| `idx_elements_user_type` | `(user_id, element_type)` | Full-type listing |
| `idx_elements_name` | `(user_id, name)` | Cross-type name lookup |
| `idx_elements_author` | `(author)` | Author filtering |
| `idx_elements_metadata` | `(metadata)` GIN | JSONB containment queries |
| `idx_elements_scan` | `(user_id, element_type, updated_at)` | Incremental scan — filters changed rows efficiently |
| `idx_elements_autoload` | `(user_id)` WHERE `auto_load = true` | Partial; startup autoload query |
| `idx_elements_memory_type` | `(user_id, memory_type)` WHERE `element_type = 'memories'` | Partial; memory-type filtering |
| `idx_elements_public` | `(element_type, name)` WHERE `visibility = 'public'` | Partial; cross-user public discovery; added by migration 0005 |
| `idx_elements_fts` | `(fts_vector)` GIN | Full-text search; added by migration 0004 |

#### element_tags

| Column | Type | Notes |
|--------|------|-------|
| `element_id` | uuid → elements.id CASCADE | |
| `user_id` | uuid → users.id CASCADE | Denormalized for RLS; allows RLS to filter without a join |
| `tag` | varchar(128) NOT NULL | |
| PK | `(element_id, tag)` | One row per tag per element |

Tags are managed atomically with element writes: `replaceTags` deletes all existing tags for the element and inserts the new set within the same transaction.

#### element_relationships

| Column | Type | Notes |
|--------|------|-------|
| `source_id` | uuid → elements.id CASCADE | |
| `user_id` | uuid → users.id CASCADE | Denormalized for RLS |
| `target_name` | varchar(255) NOT NULL | Name of the referenced element |
| `target_type` | varchar(32) NOT NULL | Element type of the target |
| `relationship` | varchar(64) NOT NULL | e.g. `activates`, `requires`, `references` |
| PK | `(source_id, target_name, target_type)` | |

The index `idx_relationships_user_target` on `(user_id, target_name, target_type)` serves reverse-lookup queries within a user's partition. Migration 0004 replaces the earlier `(target_name, target_type)` index with this user-leading composite.

#### memory_entries

Individual time-series entries within a memory element.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid → users.id CASCADE | Denormalized for RLS |
| `memory_id` | uuid → elements.id CASCADE | Parent memory element |
| `entry_id` | varchar(255) NOT NULL | Application-assigned ID (not a UUID) |
| `timestamp` | timestamptz NOT NULL | |
| `content` | text NOT NULL | |
| `sanitized_content` | text | Privacy-scrubbed version of content |
| `sanitized_patterns` | jsonb | Patterns that were sanitized |
| `tags` | text[] | Tag array for overlap queries |
| `entry_metadata` | jsonb | Arbitrary entry-level metadata |
| `privacy_level` | varchar(32) | |
| `trust_level` | varchar(32) | |
| `source` | varchar(64) | |
| `expires_at` | timestamptz | For TTL-based purging |
| UNIQUE | `(memory_id, entry_id)` | Upsert conflict target |

#### sessions

One row per `(user_id, session_id)`. All session-scoped state lives in JSONB columns on this single row.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid → users.id CASCADE | |
| `session_id` | varchar(255) NOT NULL | Matches the MCP session identifier |
| `transport` | varchar(16) NOT NULL DEFAULT `stdio` | |
| `activations` | jsonb NOT NULL DEFAULT `{}` | Element activation state (per type) |
| `confirmations` | jsonb NOT NULL DEFAULT `[]` | Gatekeeper confirmation records |
| `cli_approvals` | jsonb NOT NULL DEFAULT `[]` | CLI approval records |
| `cli_session_approvals` | jsonb NOT NULL DEFAULT `[]` | Session-scoped CLI approvals |
| `permission_prompt_active` | boolean NOT NULL DEFAULT `false` | |
| `challenges` | jsonb NOT NULL DEFAULT `[]` | Verification challenge state |
| `last_active` | timestamptz NOT NULL | |
| `created_at` | timestamptz NOT NULL | |
| `updated_at` | timestamptz NOT NULL | |
| UNIQUE | `(user_id, session_id)` | Leading-column covers user-only queries |

#### agent_states

Runtime state for agent elements, separate from their `.md` definition.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `agent_id` | uuid → elements.id CASCADE | |
| `user_id` | uuid → users.id CASCADE | |
| `goals` | jsonb NOT NULL DEFAULT `[]` | |
| `decisions` | jsonb NOT NULL DEFAULT `[]` | |
| `context` | jsonb NOT NULL DEFAULT `{}` | |
| `last_active` | timestamptz | |
| `session_count` | integer NOT NULL DEFAULT `0` | |
| `state_version` | integer NOT NULL DEFAULT `1` | Optimistic lock counter |
| UNIQUE | `(agent_id)` | One state row per agent |

#### ensemble_members

Membership records for ensemble elements. Richer than `element_relationships` because ensemble membership carries role, priority, activation mode, conditions, and intra-ensemble dependency arrays.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `ensemble_id` | uuid → elements.id CASCADE | |
| `user_id` | uuid → users.id CASCADE | |
| `member_name` | varchar(255) NOT NULL | |
| `member_type` | varchar(32) NOT NULL | |
| `role` | varchar(32) NOT NULL DEFAULT `core` | |
| `priority` | integer NOT NULL DEFAULT `0` | |
| `activation` | varchar(32) NOT NULL DEFAULT `always` | |
| `condition` | text | Optional activation condition |
| `purpose` | text | |
| `dependencies` | text[] DEFAULT `'{}'` | Intra-ensemble dependency names |
| UNIQUE | `(ensemble_id, member_name, member_type)` | |

#### element_provenance

Side table for shared-pool elements. Tracks origin, source URL, version, content hash, and fork lineage. Separate from `elements` so the shared-pool feature is schema-modular — dropping it requires only removing this table and the SYSTEM user row.

| Column | Type | Notes |
|--------|------|-------|
| `element_id` | uuid PK → elements.id CASCADE | |
| `origin` | varchar(32) NOT NULL | `collection`, `deployment_seed`, or `fork` |
| `source_url` | text | |
| `source_version` | varchar(128) | |
| `content_hash` | char(64) NOT NULL | SHA-256 at install time |
| `forked_from` | uuid → elements.id SET NULL | NULL unless `origin = 'fork'` |
| `installed_at` | timestamptz NOT NULL | |

A CHECK constraint enforces that `origin = 'fork'` requires `forked_from IS NOT NULL`. The `(origin, source_url, source_version)` unique index (partial: `WHERE source_url IS NOT NULL`) prevents duplicate installs of the same versioned source.

---

## Row-level security

RLS is the primary isolation mechanism in database mode. It enforces per-user data boundaries at the database engine level, independently of application logic.

### Database roles

Two roles exist:

| Role | Capability | Used for |
|------|-----------|---------|
| `dollhouse` | Superuser, `BYPASSRLS` | Migrations, admin bootstrap |
| `dollhouse_app` | `NOBYPASSRLS` | All runtime application queries |

The application pool (`DOLLHOUSE_DATABASE_URL`) connects as `dollhouse_app`. The admin pool (`DOLLHOUSE_DATABASE_ADMIN_URL`) connects as `dollhouse` and is used only for identity bootstrap (creating the initial user row) and running migrations.

### FORCE ROW LEVEL SECURITY

Every RLS-enabled table also has `FORCE ROW LEVEL SECURITY`. This means RLS policies apply even when the query runs as the table owner. Without this, a table owner could bypass RLS silently.

### Setting user context

All application queries run inside one of two wrappers:

**`withUserContext`** — read-write transaction:

```typescript
// src/database/rls.ts
export async function withUserContext<T>(db, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    return fn(tx);
  });
}
```

**`withUserRead`** — read-only transaction (adds `SET TRANSACTION READ ONLY`):

```typescript
export async function withUserRead<T>(db, userId, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return fn(tx);
  });
}
```

`set_config` with `is_local=true` (the third argument) scopes the setting to the current transaction. It is automatically cleared at commit or rollback, so it cannot leak across pooled connections. The `userId` is passed as a prepared-statement bind parameter — it is never string-interpolated into SQL.

### withSystemContext

`src/database/admin.ts`

```typescript
export async function withSystemContext<T>(db, fn) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_user_id', '', true)`);
    return fn(tx);
  });
}
```

`withSystemContext` sets `app.current_user_id` to an empty string. If the calling code uses the `dollhouse_app` role, RLS policies that cast this to `uuid` will throw `invalid_text_representation` rather than silently returning data. This fail-visible design is intentional: a background task that forgets to use the admin role will get a clear error rather than unexpectedly reading across tenant boundaries.

`withSystemContext` is physically separated into `admin.ts` so any import of it in a code review immediately flags the question: "why does this code need to bypass tenant isolation?"

### RLS policies

Policies were applied incrementally across migrations 0004–0008. The current state for each table:

**`elements`** (migration 0005 — per-operation split):

| Operation | Policy |
|-----------|--------|
| SELECT | `user_id = :me OR visibility = 'public'` |
| INSERT | `user_id = :me` (WITH CHECK prevents user_id spoofing) |
| UPDATE | `user_id = :me` (USING and WITH CHECK) |
| DELETE | `user_id = :me` |

**`element_tags`** (migration 0006):

| Operation | Policy |
|-----------|--------|
| SELECT | `user_id = :me` OR EXISTS (element with same id and `visibility = 'public'`) |
| INSERT/UPDATE/DELETE | `user_id = :me` |

**`element_relationships`** (migration 0007):

Same pattern as element_tags, but the EXISTS check gates on the source element's visibility.

**`memory_entries`, `ensemble_members`, `agent_states`, `sessions`, `user_settings`**: strict owner-only (`user_id = :me`) for all operations.

**`users`**: SELECT only, restricted to `id = :me`. Writes go through the admin role.

**`element_provenance`** (migration 0008): SELECT permitted if the associated element row is visible (delegates to the elements_select policy). No INSERT/UPDATE/DELETE for the app role.

### The `missing_ok` argument

All policies use `current_setting('app.current_user_id', true)::uuid`. The `true` argument means a missing setting returns NULL rather than raising an error. NULL fails every `= user_id` comparison, so a session that forgot to set user context sees zero rows — fail-secure rather than fail-open.

---

## Migrations

### Database migrations

Migration SQL files live in `src/database/migrations/`. Drizzle Kit tracks applied migrations in `src/database/migrations/meta/_journal.json` — each entry records the migration tag and a timestamp. Run all pending migrations with:

```bash
npx drizzle-kit migrate
```

The command reads `_journal.json` to determine which files have already been applied and runs only the remainder, in order.

### Migration summary

| File | What it does |
|------|-------------|
| `0000_icy_mephistopheles.sql` | Creates all core tables: `users`, `user_settings`, `elements`, `element_tags`, `element_relationships`, `memory_entries`, `sessions`, `agent_states`, `ensemble_members`. Creates initial indexes. |
| `0001_spotty_ken_ellis.sql` | Fixes foreign key cascade behavior (`user_id` on agent_states, ensemble_members, memory_entries now CASCADE). Replaces two separate sessions indexes with the composite `idx_sessions_user_session`. Removes identity columns from `user_settings` (they belong only in `users`). |
| `0002_tense_warhawk.sql` | Adds unique index `idx_users_username`. |
| `0003_flat_rattler.sql` | Adds `user_id` column to `element_tags` and `element_relationships` for RLS and composite index support. Adds `idx_elements_scan (user_id, element_type, updated_at)` for incremental scans. |
| `0004_fts_and_rls.sql` | Adds `fts_vector` GENERATED ALWAYS column and GIN index. Enables RLS with `FORCE ROW LEVEL SECURITY` on all tables. Creates initial FOR ALL policies (owner-only). Replaces the old `(target_name, target_type)` relationship index with user-leading `(user_id, target_name, target_type)`. |
| `0005_visibility_rls.sql` | Adds `CHECK (visibility IN ('private', 'public'))` constraint. Splits the `elements` FOR ALL policy into four per-operation policies. SELECT now allows `visibility = 'public'`. Adds partial index `idx_elements_public` for cross-user discovery. |
| `0006_tags_public_visibility.sql` | Splits `element_tags` FOR ALL policy into per-operation policies. SELECT now allows tags on public elements via EXISTS subquery. |
| `0007_relationships_public_visibility.sql` | Same split for `element_relationships`. SELECT allows relationships whose source element is public. |
| `0008_shared_pool_provenance.sql` | Creates the SYSTEM user (`00000000-0000-0000-0000-000000000001`). Creates `element_provenance` table with origin/source tracking. Adds RLS on provenance (read-through from element visibility). |

### Adding a database migration

1. Modify the relevant Drizzle schema files in `src/database/schema/`.
2. Run `npx drizzle-kit generate` to produce a new numbered SQL file in `src/database/migrations/` and update `_journal.json`.
3. For PostgreSQL-specific features that `drizzle-kit generate` cannot express — RLS policies, generated columns, custom functions, partial indexes — create a hand-written SQL file following the `0004_fts_and_rls.sql` pattern. Register it in `_journal.json` manually so Drizzle knows to track it.
4. Use `IF NOT EXISTS`, `DROP ... IF EXISTS`, and `ON CONFLICT DO NOTHING` wherever possible to keep migrations idempotent. This allows safe re-runs against partially-applied environments.
5. Test the migration against the Docker development database before committing:

```bash
docker compose -f docker/docker-compose.db.yml up -d
npx drizzle-kit migrate
```

### Flat-to-per-user filesystem migration

`src/storage/migrations/flat-to-per-user/FlatToPerUserMigration.ts`

This migration moves a single-user (flat) portfolio layout to the multi-user per-user layout. It is a one-time filesystem restructuring, not a database operation.

**Before (flat layout):**

```
~/.dollhouse/
├── portfolio/personas/
├── portfolio/skills/
├── portfolio/.backups/
├── state/activations-*.json
├── .auth/github_token.enc
└── security/blocked-agents.json
```

**After (per-user layout):**

```
~/.dollhouse/
├── users/<userId>/
│   ├── portfolio/personas/
│   ├── portfolio/skills/
│   ├── backups/
│   ├── state/activations-*.json
│   ├── auth/github_token.enc
│   └── security/blocked-assets.json
├── shared/
└── .dollhouse-per-user-migrated    ← marker file
```

**Key design properties:**

- **Explicit only.** The migration is never triggered automatically at startup. It is not accessible via MCP-AQL. Invoke it from the CLI only:

  ```bash
  npm run migrate:per-user -- status
  npm run migrate:per-user -- preview
  npm run migrate:per-user -- execute
  npm run migrate:per-user -- execute --user-id alice
  ```

- **Idempotent.** If the marker file `.dollhouse-per-user-migrated` already exists, `execute()` returns immediately with `success: true`. Directories that have already been moved are skipped.
- **Safe to retry after partial failure.** Moves that succeeded in a previous run stay in place. A retry continues from where the previous run failed.
- **Cross-filesystem safe.** `moveDir` attempts `fs.rename()` first (atomic on the same filesystem). If that fails (cross-filesystem), it falls back to a recursive copy followed by `fs.rm()`. File permissions (such as `0600` on encrypted tokens) are preserved during the copy.

**Migration flow:**

1. `status()` checks whether the marker file exists, detecting `flat`, `per-user`, or `new-install` layout.
2. `preview()` returns the list of directories that would be created and the list of moves that would be made — without touching the filesystem.
3. `execute()` creates target directories, moves each source directory in order, and writes the marker file only if all moves succeeded.

The script is a thin CLI wrapper around `FlatToPerUserMigration`. It runs `validateUserId` on the `--user-id` argument before constructing the migration object, so invalid user IDs are rejected before any filesystem access.

A `SecurityMonitor` event is logged at the start and end of the migration.

### Data migration CLI scripts

Three CLI scripts handle data migration between storage backends. None of these are accessible via MCP-AQL — data migration is an operator-level action performed outside the LLM session boundary.

All three scripts follow the same dependency construction pattern: they call `bootstrapDatabase()` directly rather than using the DI container, then construct storage-layer instances manually with a fixed `UserIdResolver` derived from the bootstrap result.

```typescript
// Pattern shared by import and export scripts
const bootstrap = await bootstrapDatabase({ connectionUrl: dbUrl, ... });
const userId = bootstrap.userId;
const userIdResolver = () => userId;  // fixed resolver — no ContextTracker needed
```

`bootstrapDatabase()` connects to PostgreSQL and ensures a `users` row exists for the current OS user (matched by username). The returned `userId` UUID is used as the fixed resolver value. Because there is no active `ContextTracker.runAsync()` scope, these scripts cannot use the standard `createUserIdResolver()` — the fixed resolver replaces it.

#### `scripts/import-portfolio-to-database.ts` (`npm run db:import`)

Reads element files from a filesystem portfolio and writes them to the database. This is the tool for operators switching from file mode to database mode on an established installation.

```bash
npm run db:import                                 # import from default portfolio path
npm run db:import -- --dry-run                    # preview without writing
npm run db:import -- --portfolio-dir /path/to/portfolio
npm run db:import -- --verbose                    # show per-element progress
```

**How it works:**

1. Resolves the portfolio directory from `--portfolio-dir`, `DOLLHOUSE_PORTFOLIO_DIR`, or the platform default (`~/.dollhouse/portfolio`).
2. Scans all `ElementType` subdirectories for `.md`, `.yaml`, and `.yml` files.
3. For each file, reads its content and extracts `ElementWriteMetadata` from its frontmatter:
   - Non-memory elements: `FrontmatterParser.extractMetadata()` → `{ author, version, description, tags: string[] }`
   - Memory elements: `MemoryMetadataExtractor.extractMetadata()` → same shape
4. Calls `layer.writeContent(type, name, content, metadata)` on the appropriate storage layer. `DatabaseStorageLayer` handles all non-memory types; `DatabaseMemoryStorageLayer` handles memories.
5. The upsert-on-conflict semantics of `writeContent` make the script idempotent — re-running it updates existing rows rather than duplicating them.

The `tags: string[]` field in `ElementWriteMetadata` is required. Both extractors always return a `string[]` (empty array if no tags are present in the content). Passing `undefined` here causes a type error because `DatabaseStorageLayer.writeContent` calls `replaceTags` unconditionally.

The filesystem portfolio is not modified. After a successful import, operators can switch backends by setting `DOLLHOUSE_STORAGE_BACKEND=database` and restarting the server; the original files remain as a fallback.

**Extending the script:**

To add a `--user-id` flag (for importing into a specific user's account rather than the OS user derived from bootstrap), replace the `userIdResolver` line with `const userIdResolver = () => explicitUserId;` after validating the provided UUID with `validateUserId()`.

To support a new element type that uses a custom storage layer subclass, add a branch in the storage layer construction loop (where `ElementType.MEMORY` is already branched) and add the appropriate metadata extractor call in `extractWriteMetadata`.

#### `scripts/export-portfolio-from-database.ts` (`npm run db:export`)

Reads elements from the database and writes them as files to a target directory. Because the `elements` table stores the original content in `raw_content`, the export is lossless — exported files are byte-for-byte identical to what was originally imported or saved.

```bash
npm run db:export                                          # export all elements to default path
npm run db:export -- --dry-run                             # preview without writing files
npm run db:export -- --output-dir /tmp/dollhouse-export
npm run db:export -- --type skills                         # filter by type (repeatable)
npm run db:export -- --type skills --type personas
npm run db:export -- --name "code-reviewer"                # filter by name (repeatable)
npm run db:export -- --overwrite                           # replace existing files
npm run db:export -- --verbose                             # show per-element file paths
```

**How it works:**

1. Queries the `elements` table using `withUserRead()` with the bootstrapped `userId`. This scopes the query to the current user's rows and enforces the `SET TRANSACTION READ ONLY` flag.
2. Applies `--type` and `--name` filters as SQL predicates on `element_type` and `name` columns using `inArray`.
3. For each returned row, writes `raw_content` directly to `<output-dir>/<element_type>/<name>.<ext>`. Extension is `.md` for all non-memory types, `.yaml` for memories.
4. Skips existing files by default. Pass `--overwrite` to replace them.

The script does not go through the storage layer abstraction — it queries the `elements` schema table directly via Drizzle. This is intentional: export is a read-only operation that needs no scan index, cache, or metadata extraction.

**Extending the script:**

The `--type` and `--name` flags already accept repeated values (`--type skills --type personas`). To add a `--user-id` flag, replace the `userId` value from bootstrap with the validated provided UUID before constructing the `withUserRead` call.

#### `scripts/migrate-to-per-user-layout.ts` (`npm run migrate:per-user`)

See [Flat-to-per-user filesystem migration](#flat-to-per-user-filesystem-migration) above. This script is the CLI entry point for that migration. The migration class itself (`FlatToPerUserMigration`) has no dependency on `bootstrapDatabase` — it is a pure filesystem operation and does not require database credentials.

---

## State stores and the sessions table

Session-scoped state is persisted to the `sessions` table. Four JSONB columns hold the complete state for one `(user_id, session_id)` pair. This design concentrates all per-session state in one row, making session restore a single SELECT.

### The three database state stores

All three stores follow the same pattern:
1. Constructor validates `userId` and `sessionId` (must be non-empty strings passing UUID format check).
2. `initialize()` calls `ensureSessionRow` (upsert) then `loadSessionRow` (SELECT). Deserialized state is normalized before being placed into in-memory structures.
3. All mutation methods update in-memory state immediately (the hot path — no latency) then enqueue a database write.
4. Writes go through `PersistQueue`.

**DatabaseActivationStateStore** (`src/state/DatabaseActivationStateStore.ts`)

Persists element activation state to the `activations` JSONB column. Activations are keyed by element type and stored as arrays of `{ name, filename?, activatedAt }` objects. Writes are fire-and-forget.

**DatabaseConfirmationStore** (`src/state/DatabaseConfirmationStore.ts`)

Persists Gatekeeper confirmations and CLI approvals to `confirmations`, `cli_approvals`, `cli_session_approvals`, and `permission_prompt_active`. Business logic (LRU eviction, TTL management, scope promotion) lives in `GatekeeperSession`, not this store.

**DatabaseChallengeStore** (`src/state/DatabaseChallengeStore.ts`)

Persists verification challenge state to the `challenges` JSONB column. Includes a configurable auto-cleanup interval for expired challenges. Writes are fire-and-forget.

### PersistQueue

`src/state/PersistQueue.ts`

Ensures database writes from a single store never overlap and do not block the caller.

**Coalescing:** if a write is already in flight when `enqueue` is called, the new operation replaces the pending write rather than queuing behind it. When the in-flight write finishes, only the latest state is written — not one write per intermediate state change. This is safe because the write always captures the entire current state, not a delta.

**Two usage modes:**

- `enqueue(operation)` — awaitable; use when durability must be confirmed before proceeding.
- `enqueueFireAndForget(operation)` — the activation and challenge stores use this. Failures are logged via `SecurityMonitor` but not propagated to the caller.

**awaitPending():**

Returns a promise that resolves when the queue is drained. Required in tests that exercise fire-and-forget stores:

```typescript
await store.recordActivation('personas', 'my-persona');
await store.awaitPendingWrites(); // drain before asserting DB state
```

Writes are retried up to `DB_PERSIST_MAX_RETRIES` times with `DB_PERSIST_RETRY_DELAY_MS` delay between attempts before being considered failed.

### DatabaseAgentStateStore

`src/storage/DatabaseAgentStateStore.ts`

Persists agent runtime state (goals, decisions, context) to `agent_states`. Unlike the session stores, agent state is not session-scoped — it persists across sessions and is keyed by `agent_id` (a UUID referencing the agent's element row).

**Optimistic locking:**

`saveState` uses `SELECT FOR UPDATE` on the `agent_states` row before checking `state_version`. This acquires a row-level lock, preventing two concurrent writers from both passing the version check (TOCTOU prevention). The version is also included in the UPDATE's WHERE clause as a belt-and-suspenders guard:

```typescript
// src/storage/DatabaseAgentStateStore.ts
const existing = await tx
  .select({ stateVersion: agentStates.stateVersion })
  .from(agentStates)
  .where(and(eq(agentStates.userId, this.userId), eq(agentStates.agentId, agentElementId)))
  .for('update')
  .limit(1);

if (existing[0].stateVersion !== expectedVersion) {
  throw new Error(`State version conflict for agent ${agentElementId}: ...`);
}
```

On initial save (no existing row), the caller must pass `expectedVersion = 0`. Any other value throws immediately without touching the database.

---

## DI registration and backend selection

### Environment variable

```
DOLLHOUSE_STORAGE_BACKEND=database   # enables database mode
DOLLHOUSE_STORAGE_BACKEND=file       # default
```

For the full environment variable reference, see the [Deployment & Configuration Guide](../guides/deployment-configuration.md).

### Registration flow

At startup, `Container.preparePortfolio()` checks `env.DOLLHOUSE_STORAGE_BACKEND`. If set to `database`, it calls `DatabaseServiceRegistrar.bootstrapAndRegister(container)`.

`DatabaseServiceRegistrar` (`src/di/registrars/DatabaseServiceRegistrar.ts`):

1. Validates `DOLLHOUSE_DATABASE_URL` is set.
2. Calls `bootstrapDatabase(config)` to connect and ensure the current OS user has a row in `users`.
3. Dynamically imports and registers `DatabaseActivationStateStore`, `DatabaseConfirmationStore`, and `DatabaseChallengeStore` classes (not instances — these are constructed per session).
4. Registers `DatabaseConnection` and `DatabaseInstance` in the container.
5. Registers `BootstrappedUserId` and `CurrentUserId` (the UUID returned by bootstrap).
6. Registers `UserIdResolver` by resolving `ContextTracker` from the container and calling `createUserIdResolver(tracker)`. This is the per-call resolver used by storage layers.
7. Constructs a `DatabaseStorageLayerFactory` with the resolved `UserIdResolver` and registers it as `StorageLayerFactory`, overriding the file-mode factory.
8. Re-registers `StdioSession` with the bootstrapped UUID so session context carries a UUID identity in database mode (instead of the `DOLLHOUSE_USER` literal string).

All database imports are dynamic (`await import(...)`) inside `bootstrapAndRegister`. File-mode deployments never load drizzle-orm because the static import graph does not include these modules.

### UserIdResolver pattern

See [The UserIdResolver pattern](#the-useridresolver-pattern) in the Transport and storage interaction section above for the full explanation. The short version: storage layers are singletons but users change per-request, so the resolver reads `userId` from `AsyncLocalStorage` at call time rather than capturing it at construction time.

### Backend routing in DatabaseStorageLayerFactory

```typescript
// src/storage/DatabaseStorageLayerFactory.ts
createForElement(elementType: string, _fileOptions: FileStorageOptions): IStorageLayer {
  if (elementType === 'memories') {
    return new DatabaseMemoryStorageLayer(this.db, this.getCurrentUserId);
  }
  return new DatabaseStorageLayer(this.db, this.getCurrentUserId, elementType);
}
```

Memories get `DatabaseMemoryStorageLayer` because they sync `memory_entries`. Everything else gets `DatabaseStorageLayer`.

---

## Authentication architecture

Authentication is an optional layer, off by default. When enabled (`DOLLHOUSE_AUTH_ENABLED=true`), it gates all HTTP traffic through a JWT validation pipeline that runs before any MCP or web console logic. The auth module is completely separate from the storage layer — auth concerns end at `res.locals.authClaims`, and storage concerns start with the `UserIdResolver`.

### Auth module structure

All auth code lives in `src/auth/`.

#### `IAuthProvider.ts`

The pluggable contract. Every concrete provider implements:

```typescript
export interface IAuthProvider {
  readonly name: string;
  validate(token: string): Promise<AuthResult>;
  issue?(sub: string, options?: IssueOptions): Promise<string>;
}
```

`issue()` is optional — only providers that control their own signing keys implement it. `validate()` returns a discriminated union:

```typescript
export type AuthResult =
  | { ok: true; claims: AuthClaims }
  | { ok: false; reason: string };
```

`AuthClaims` carries `sub` (required), `displayName`, `email`, `tenantId`, `scopes`, and `exp`. These fields flow downstream into `SessionContext` and, in database mode, into the `users` table.

#### `LocalDevAuthProvider.ts`

Generates and validates self-signed ES256 JWTs. Intended for local development — no external dependencies, no network calls.

Key pair lifecycle:
- On first `validate()` or `issue()` call, the provider attempts to read a key pair from `keyFilePath`.
- If the file does not exist, `generateKeyPair('ES256')` produces a new pair, which is written as JWK JSON with mode `0600`.
- On subsequent server restarts, the existing file is read and the pair is reused. Tokens issued before a restart remain valid.
- Default key file path: `~/.dollhouse/run/auth-keypair.json`. Override with `DOLLHOUSE_AUTH_LOCAL_KEY_FILE`.

Issued tokens include standard JWT claims (`iss`, `sub`, `aud`, `iat`, `exp`) plus the optional `display_name`, `email`, `tenant_id`, and `scopes` payload fields. `validate()` checks signature, issuer, audience, and expiry; specific error strings are mapped to human-readable `reason` values (`'token expired'`, `'invalid signature'`).

#### `OidcAuthProvider.ts`

Validates JWTs issued by an external OIDC identity provider. Does not implement `issue()`.

Configuration:
- `DOLLHOUSE_AUTH_ISSUER` — issuer URL (for example `https://tenant.auth0.com/`)
- `DOLLHOUSE_AUTH_AUDIENCE` — expected audience claim
- `DOLLHOUSE_AUTH_JWKS_URI` — JWKS endpoint; if omitted, derived as `{issuer}/.well-known/jwks.json`

Keys are fetched and cached by `jose`'s `createRemoteJWKSet`. The cache is automatically refreshed when a token presents a key ID not in the current cache, so key rotation at the provider requires no server restart.

Claim extraction handles provider-specific field names. `displayName` is tried from `name`, `display_name`, then `preferred_username`. `tenantId` is tried from `tenant_id` then `org_id`. `scopes` is read from either a `scopes` array or a space-separated `scope` string, whichever is present.

#### `authMiddleware.ts`

An Express middleware factory (`createUnifiedAuthMiddleware`) that wraps any `IAuthProvider`. Mounted on the MCP HTTP transport and the web console API — one middleware, two surfaces.

Token extraction order:
1. `Authorization: Bearer <token>` header (primary)
2. `?token=<token>` query parameter (fallback for SSE/EventSource, which cannot set custom headers)

On success, claims are attached to `res.locals.authClaims` and `next()` is called. On failure, the middleware responds with `401` and logs a `SecurityMonitor` event. Public paths (configured via `publicPaths`) bypass validation entirely.

```typescript
// Public paths receive no auth check:
createUnifiedAuthMiddleware({
  provider,
  publicPaths: ['/healthz', '/readyz', '/version'],
})
```

#### `AuthProviderFactory.ts`

`createAuthProvider(config)` selects and instantiates the right provider based on `config.provider` (`'local'` or `'oidc'`). Both provider implementations are dynamically imported — file-mode or auth-disabled deployments never load `jose` or `node-fetch`.

For the `local` provider, the factory also issues a startup token and writes it to `process.stderr` so it is visible in the terminal without contaminating MCP's stdio JSON stream:

```
[DollhouseMCP Auth] Token for 'alice' (24h TTL):
  eyJhbGci...
Use in MCP client config:
  "headers": { "Authorization": "Bearer eyJhbGci..." }
```

The default subject is taken from `DOLLHOUSE_AUTH_LOCAL_DEFAULT_SUB`, then `DOLLHOUSE_USER`, then the OS username.

---

### Token flow through the system

The following sequence describes how a JWT becomes a database user UUID and reaches RLS.

```
Client
  │
  │  Authorization: Bearer <jwt>
  ▼
Express middleware (createUnifiedAuthMiddleware)
  │  provider.validate(token) → AuthResult
  │  on success: res.locals.authClaims = { sub, displayName, ... }
  ▼
StreamableHTTPServerTransport
  │  passes res.locals.authClaims to createStreamableHttpRuntime callback
  ▼
createStreamableHttpRuntime callback (src/index.ts)
  │  UserIdentityService.resolveOrCreateUser(authClaims.sub, authClaims.displayName)
  │  → returns UUID (creates users row if needed, via admin connection)
  │  createHttpSession({ userId: uuid, displayName, email, tenantId })
  │  activationState.dbUserId = uuid
  ▼
ContextTracker.runAsync(sessionContext, handler)
  │  AsyncLocalStorage holds the SessionContext for the request lifetime
  ▼
UserIdResolver (called inside database operations)
  │  contextTracker.getSessionContext() → session
  │  activationState.dbUserId takes priority over session.userId
  ▼
withUserContext(db, uuid, tx => ...)
  │  SET LOCAL app.current_user_id = '<uuid>'
  ▼
PostgreSQL RLS
  │  current_setting('app.current_user_id', true)::uuid
  │  every policy predicate evaluates against this value
  ▼
Query result scoped to the authenticated user
```

Key design points:

- `UserIdentityService.resolveOrCreateUser()` runs on the admin database connection (bypasses RLS) to INSERT if the user is new. Resolved UUIDs are cached in memory for the process lifetime — user rows are immutable once created.
- The UUID is stored on `SessionActivationState.dbUserId` so it survives across calls within the same MCP session without re-resolving.
- `UserIdResolver` checks `dbUserId` first, before falling back to `session.userId`. This means the UUID established at connection time (from the JWT `sub`) is what RLS sees — not the username literal.
- If `resolveOrCreateUser` fails (network error, schema mismatch), the session falls back to `fallbackUserId`. In database mode this causes subsequent RLS queries to fail rather than silently reading wrong data.

---

### DI wiring

`AuthServiceRegistrar` (`src/di/registrars/AuthServiceRegistrar.ts`) is called at startup. When `DOLLHOUSE_AUTH_ENABLED=false` (the default), it logs a single debug message and returns — no imports from `src/auth/` happen and the auth module never enters the import graph.

When enabled:

1. All imports from `src/auth/` are done dynamically inside `bootstrapAndRegister()`.
2. `createAuthProvider(config)` is called with values from `env`. It returns an `IAuthProvider` instance.
3. The provider is registered as `'AuthProvider'` in the DI container.
4. `createUnifiedAuthMiddleware({ provider, publicPaths: ['/healthz', '/readyz', '/version'] })` produces a `RequestHandler`.
5. The middleware is registered as `'AuthMiddleware'` in the container.

Downstream consumers resolve `'AuthMiddleware'` by name:

- The MCP HTTP transport (`src/index.ts`) passes it to `createStreamableHttpRuntime`, which mounts it on the Express app that serves the `/mcp` endpoint.
- The web console (`src/web/server.ts`) receives it as `options.unifiedAuthMiddleware` and mounts it at `/api` before the console token auth middleware.

Both surfaces use the same `RequestHandler` instance — one provider, one middleware, consistent validation across all HTTP surfaces.

---

### Web console coexistence

The web console operates two auth systems in parallel when `DOLLHOUSE_AUTH_ENABLED=true`:

| Layer | Middleware | Token type | Enforced when |
|-------|-----------|------------|--------------|
| Unified JWT auth | `createUnifiedAuthMiddleware` (from `src/auth/`) | ES256 JWT or OIDC JWT | `DOLLHOUSE_AUTH_ENABLED=true` |
| Console token auth | `createAuthMiddleware` (from `src/web/middleware/`) | 64-char hex token | `DOLLHOUSE_WEB_AUTH_ENABLED=true` or when unified auth is active |

Mounting order in `startWebServer` (`src/web/server.ts`):

```
app.use('/api', unifiedAuthMiddleware)       // 1. JWT validation
app.use('/api', consoleAuthMiddleware)       // 2. console token fallback
```

The console token middleware is constructed with `skipIfAlreadyAuthenticated: true` when unified auth is active. The `skipIfAlreadyAuthenticated` option checks for a truthy `res.locals.authClaims` — if the JWT middleware already authenticated the request, the console token middleware calls `next()` immediately.

This means a browser client holding a console hex token continues to work alongside an MCP client holding a JWT. Both tokens are accepted on all `/api` routes; neither is required to present both.

The console token auth middleware is always enforced (`enabled: true`) when unified auth is active, regardless of `DOLLHOUSE_WEB_AUTH_ENABLED`. This prevents a configuration where unified auth gates the MCP transport but the web console remains open.

---

### Adding a new auth provider

To add a provider beyond `local` and `oidc`:

**Step 1 — implement `IAuthProvider`:**

```typescript
// src/auth/MyCustomAuthProvider.ts
export class MyCustomAuthProvider implements IAuthProvider {
  readonly name = 'my-custom';

  async validate(token: string): Promise<AuthResult> {
    // Validate token against your identity source.
    // Return { ok: true, claims } or { ok: false, reason }.
  }

  // Implement issue() only if your provider controls its own signing keys.
}
```

The `validate()` method must be side-effect-free — it is called on every request. If the provider needs network calls (JWKS fetch, introspection endpoint), handle caching inside the implementation.

**Step 2 — register in `AuthProviderFactory.ts`:**

Add a branch before the `local` default:

```typescript
if (config.provider === 'my-custom') {
  const { MyCustomAuthProvider } = await import('./MyCustomAuthProvider.js');
  return new MyCustomAuthProvider({ /* config fields */ });
}
```

Use a dynamic import (`await import(...)`) so the module is excluded from the import graph when the provider is not selected.

**Step 3 — add the env var:**

In `src/config/env.ts`, extend the `DOLLHOUSE_AUTH_PROVIDER` enum:

```typescript
DOLLHOUSE_AUTH_PROVIDER: z.enum(['local', 'oidc', 'my-custom']).default('local'),
```

Add any provider-specific configuration fields (for example, `DOLLHOUSE_AUTH_MY_CUSTOM_ENDPOINT`) following the pattern of the existing OIDC fields.

**Step 4 — update `AuthConfig`:**

Add the new field to `AuthConfig` in `AuthProviderFactory.ts` and thread it from `AuthServiceRegistrar` through to the factory call.

No other changes are required — the middleware, DI wiring, and token flow are provider-agnostic.

---

### The `envBool` helper

All boolean environment variables in `src/config/env.ts` use `envBool()` rather than `z.coerce.boolean()`. This is a correctness fix, not a style preference.

The problem with `z.coerce.boolean()`:

```typescript
// z.coerce.boolean() delegates to JavaScript's Boolean():
Boolean('false')  // → true  (non-empty string)
Boolean('0')      // → true  (non-empty string)
Boolean('')       // → false (empty string)
```

Any string value other than the empty string coerces to `true`. Setting `DOLLHOUSE_AUTH_ENABLED=false` in a `.env` file would be silently read as `true`.

`envBool` treats only `'true'` and `'1'` as true:

```typescript
const envBool = (defaultValue: boolean) =>
  z.string().default(String(defaultValue)).transform(v => v === 'true' || v === '1');
```

Every boolean feature flag (`DOLLHOUSE_AUTH_ENABLED`, `DOLLHOUSE_WEB_AUTH_ENABLED`, `DOLLHOUSE_GATEKEEPER_ENABLED`, `DOLLHOUSE_SHARED_POOL_ENABLED`, and others) uses this helper. Any new boolean env var must use `envBool(defaultValue)` — never `z.coerce.boolean()` or `z.boolean()`.

---

### Testing auth code

Auth unit tests live in `tests/unit/auth/`.

#### `LocalDevAuthProvider.test.ts` patterns

**Temporary directory key pair isolation:**

Each test run generates its key pair into a fresh `os.tmpdir()` subdirectory created with `fs.mkdtemp`. The `afterEach` block removes it with `fs.rm({ recursive: true, force: true })`. This means:

- Tests are hermetic — no shared key state across test cases.
- Key generation is tested by asserting the key file exists after the first `issue()` call.
- Key reuse is tested by constructing two `LocalDevAuthProvider` instances pointing to the same file and asserting the file's `mtimeMs` is unchanged after the second provider issues a token.

**Round-trip coverage:**

`issue()` followed by `validate()` covers the happy path. Failure cases (tampered signature, expired token, wrong key) are tested by mutating the token string or constructing a second provider with a different key file before calling `validate()` on the original provider.

#### `authMiddleware.test.ts` patterns

**Mock provider factory:**

```typescript
function createMockProvider(validateFn: (token: string) => Promise<AuthResult>): IAuthProvider {
  return {
    name: 'mock',
    validate: validateFn,
  };
}
```

Passing a custom `validateFn` lets each test control the exact `AuthResult` without needing a real key pair or network call. Tests cover:

- Missing `Authorization` header → `401`
- Present but invalid token → `401` with provider's `reason` string in the response
- Valid token → `200` with `res.locals.authClaims` reflected in the response body
- `?token=` query parameter fallback → same as valid header
- Public path bypass → `validate()` never called; `200` returned
- Non-`Bearer` prefix (`Basic ...`) → treated as missing token, `401`

**Test app construction:**

```typescript
function createTestApp(provider: IAuthProvider, publicPaths?: string[]): express.Express {
  const app = express();
  app.use('/api', createUnifiedAuthMiddleware({ provider, publicPaths }));
  app.get('/api/data', (_req, res) => {
    res.json({ data: 'protected', claims: res.locals.authClaims });
  });
  return app;
}
```

Reflecting `res.locals.authClaims` in the response body lets assertions verify that claims were correctly attached without reaching for internal state. Use `supertest` for all HTTP assertions against this app.

---

## Shared pool

The shared pool feature enables a deployment to host public elements owned by the SYSTEM user. It is controlled by the `DOLLHOUSE_SHARED_POOL_ENABLED` feature flag (default: `false`).

### SYSTEM user

UUID `00000000-0000-0000-0000-000000000001`, username `dollhousemcp-system`. Inserted by migration 0008 (`ON CONFLICT DO NOTHING`, so idempotent). It is not a regular user — it has no auth credentials, no settings row, and no session. It exists solely as the FK target for shared-pool element rows.

The SYSTEM user UUID is defined as a constant in `src/collection/shared-pool/SharedPoolConfig.ts`:

```typescript
export const SYSTEM_USER_UUID = '00000000-0000-0000-0000-000000000001';
```

### element_provenance

When an element is installed from the shared pool, a row is written to `element_provenance`. The `content_hash` column records the SHA-256 of the content at install time. Subsequent installs of the same versioned source (`origin`, `source_url`, `source_version`) hit the unique index and are rejected — preventing duplicate installs and detecting tampering.

A fork records `forked_from` pointing to the shared original. The FK uses `ON DELETE SET NULL` so deleting the shared original does not cascade-delete users' forks.

### Current status

The `element_provenance` table and SYSTEM user exist in production schema (migration 0008). The services in `src/collection/shared-pool/` (`SharedPoolInstaller`, `DeploymentSeedLoader`, `ForkOnEditStrategy`, `SharedPoolServiceRegistrar`, etc.) are wired behind the feature flag. When `DOLLHOUSE_SHARED_POOL_ENABLED=false` (the default), `SharedPoolServiceRegistrar` skips all registrations and the rest of the codebase behaves identically to before.

---

## Testing database code

### Prerequisites

Database integration tests require a running PostgreSQL instance. The development Docker Compose file starts one:

```bash
docker compose -f docker/docker-compose.db.yml up -d
```

Default connection strings (can be overridden by environment variables):
- App role: `postgres://dollhouse_app:dollhouse_app@localhost:5432/dollhousemcp`
- Admin role: `postgres://dollhouse:dollhouse@localhost:5432/dollhousemcp`

Run only the database integration tests:

```bash
npm run test:integration
```

### Test helpers

`tests/integration/database/test-db-helpers.ts` provides:

| Export | Description |
|--------|-------------|
| `getTestDb()` | Returns (or creates) the test database instance using the app role |
| `ensureTestUser()` | Creates test user `test-integration-a` if absent; returns its UUID |
| `ensureTestUserB()` | Creates test user `test-integration-b` for RLS isolation tests |
| `cleanupAllTestData()` | Deletes elements and sessions for both test users |
| `cleanupTestSessions()` | Deletes sessions for the primary test user |
| `cleanupTestElements(userId)` | Deletes elements for a given user |
| `cleanupTestAgentStates(userId)` | Deletes agent states for a given user |
| `closeTestDb()` | Drains and closes the connection pool; call in `afterAll` |
| `isDatabaseAvailable()` | Returns true if Postgres is reachable; use in `beforeAll` to skip gracefully |
| `fixedUserId(userId)` | Converts a fixed UUID into a `UserIdResolver` for constructing storage layers in tests |
| `buildSkillContent(name, opts?)` | Builds valid skill YAML for test writes |
| `buildAgentContent(name, activates?)` | Builds valid agent YAML with optional activates block |
| `buildMemoryContent(name, entries?)` | Builds valid memory YAML with optional entries |

### Patterns

**Creating a storage layer in a test:**

```typescript
const db = getTestDb();
const userId = await ensureTestUser();
const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');
```

**Using `cleanupAllTestData` correctly:**

`FORCE ROW LEVEL SECURITY` applies even to DELETE statements. Cleanup must use `withUserContext`:

```typescript
// test-db-helpers.ts already handles this:
await withUserContext(db, testUserIdA, async (tx) => {
  await tx.delete(elements).where(eq(elements.userId, testUserIdA));
});
```

**Waiting for fire-and-forget stores:**

```typescript
const store = new DatabaseActivationStateStore(db, userId, 'test-session');
await store.initialize();
store.recordActivation('personas', 'my-persona');
// Without this, the test assertion may run before the DB write:
await store.awaitPendingWrites();
// Now assert against the database
```

**Checking RLS isolation:**

Use `ensureTestUserB()` to create a second user, then verify user A cannot read user B's elements. Because the test database uses the `dollhouse_app` role (no `BYPASSRLS`), RLS policies are enforced in tests exactly as they are in production.

**Skipping when Postgres is not running:**

```typescript
beforeAll(async () => {
  if (!await isDatabaseAvailable()) {
    console.warn('Postgres not available — skipping database integration tests');
    return;
  }
  userId = await ensureTestUser();
});
```
