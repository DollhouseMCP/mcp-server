# Portfolio Sync Architecture

**Last Updated:** October 2025  
**Audience:** Developers modifying GitHub sync, download, or portfolio comparison logic.  
**Primary files:**  
- `src/handlers/PortfolioPullHandler.ts`  
- `src/portfolio/PortfolioSyncManager.ts`  
- `src/sync/PortfolioSyncComparer.ts`  
- `src/sync/PortfolioDownloader.ts`  
- `src/handlers/SyncHandlerV2.ts`

---

## 1. Overview

Portfolio sync keeps the local portfolio and the user’s GitHub repo aligned. Two main workflows support this:

1. **Pull individual elements** (download or compare) through `PortfolioPullHandler`.  
2. **Bulk sync** via `PortfolioSyncManager` (push/pull/both) orchestrated by `SyncHandlerV2`.

The design avoids destructive operations unless explicitly requested and uses atomic file writes to prevent corruption.

---

## 2. Component Responsibilities

| Component | Role |
|-----------|------|
| `PortfolioPullHandler` | MCP handler exposing download/list/compare operations for GitHub elements. |
| `PortfolioSyncManager` | Executes sync strategies (`push`, `pull`, `both`) and coordinates with repo manager and indexers. |
| `PortfolioSyncComparer` | Computes diffs between local and remote elements, including version and content hashes. |
| `PortfolioDownloader` | Retrieves raw files from GitHub, handling retries and directory creation. |
| `PortfolioRepoManager` | (not detailed here) Handles Git operations (clone/pull/push) for the user’s repo. |
| `SyncHandlerV2` | User-facing MCP handler that validates sync requests and triggers `PortfolioSyncManager`. |

---

## 3. Individual Element Workflow (`PortfolioPullHandler`)

Operations supported:
- `download` – Fetch an element from GitHub to local disk (optionally force overwrite).  
- `compare` – Produce diff metadata between local and remote element versions.  
- `list-remote` – Enumerate GitHub elements (with filters).

Sequence (download example):
1. Validate permissions & arguments (`options.force`, element type).  
2. Resolve GitHub element path via the indexer.  
3. Use `PortfolioDownloader` with `FileLockManager` to write local file atomically.  
4. Trigger `portfolioIndexManager` reload to keep caches warm.

Security features:
- Path validation to avoid traversal.  
- Unicode normalization on element names.  
- Audit logging via `SecurityMonitor`.

---

## 4. Bulk Sync Workflow (`PortfolioSyncManager`)

Supports three modes (default: `additive`):

| Mode | Behavior |
|------|----------|
| `push` | Upload new/updated local elements to GitHub. |
| `pull` | Download missing/updated GitHub elements locally. |
| `both` | Two-way merge without deletions. |
| `mirror` | Exact match (can delete) – requires explicit confirmation. |
| `backup` | Treat GitHub as backup; only pull missing items. |

Steps:
1. Load configuration (`ConfigManager`) for sync preferences.  
2. Enumerate local and remote elements (using indexers).  
3. Use `PortfolioSyncComparer` to map diffs.  
4. Apply operations (upload/download/delete) respecting force/confirm flags.  
5. Update local index caches and emit state change events if personas were affected.

`PortfolioRepoManager` handles the underlying Git commands (branch checkout, commits). Sync manager assumes the repo is already initialized/configured.

---

## 5. MCP Handler Integration

`SyncHandlerV2` exposes MCP tools for sync operations. It:

1. Normalizes payloads (mode, direction, dry-run).  
2. Calls `PortfolioSyncManager.runSync()`.  
3. Formats results (summary of adds/updates/skips).  
4. On error, returns sanitized message while logging full details.

`SyncHandlerV2` also coordinates with `IndicatorService` so responses include persona banners.

---

## 6. Testing

- Unit tests for comparer/downloader ensure diff correctness and path safety.  
- Integration tests (e.g., `tests/integration/portfolio-sync.test.ts`) should cover:
  - Dry-run vs. real sync  
  - Mode behavior (additive vs. mirror)  
  - Conflict resolution scenarios

Use the test helpers to mock GitHub responses when running offline.

---

## 7. Future Enhancements

- Transaction summaries (e.g., list of persona names changed) for logging or UI display.  
- Automatic conflict resolution policies (prefer latest version, etc.).  
- Background sync with progress reporting via events.  
- Enhanced diff output (line-level diff preview).

---

## 8. Related Docs

- `docs/agent/development/GITFLOW_GUARDIAN_HOOKS_REFERENCE.md` – Workflow policies and hook behavior for Git usage.  
- `docs/architecture/unified-search-pipeline.md` – How synced items appear in search results.  
- `docs/architecture/capability-index-system.md` – Ensures new elements picked up post-sync contribute to discovery.
