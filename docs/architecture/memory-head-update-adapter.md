# Dormant central memory UPDATE adapter

This document describes the accepted first integration slice of [#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5974017381). It is an implementation contract, not a qualification receipt. The adapter is selected only through explicit `MemoryManager` construction in qualification tests. Production dependency injection, configuration and storage factories do not enable it. A manager without the adapter retains existing behavior; test injection is not a deployable mixed legacy/guarded writer mode.

## Authority and scope

The slice supports same-name, same-locator UPDATE of an existing owned memory. It reuses the database and file conditional head primitives rather than introducing a lifecycle protocol. File operations use the existing tenant coordinator, with no nested lease or per-locator lock presented as lifecycle exclusion.

Capture the authenticated tenant before the first await. Read content and its complete backend authority together, then hydrate exactly that content through the existing memory load pipeline. Retain authority privately on the genuine working instance. File authority includes ownership, tenant root and file identity; it must not be reduced to a database-shaped revision token. Reads never adopt an unowned head. A cached instance may reuse its previously bound authority; a list-created, copied or imported instance cannot acquire fresh authority at save time.

In the injected path, unbound saves, creation, exclusive overwrite, name repair/rename and delete refuse before legacy mutation. The conditional UPDATE branch cannot fall through to ordinary database upsert, raw file writes, backup or directory creation. Non-memory behavior remains outside this memory-specific contract.

## Candidate and outcome handling

Before persistence awaits, capture detached attempted bytes, name, metadata and original authority. Refuse overlapping saves on the same instance and tenant or locator mismatches. Mutations made to the working instance while persistence is suspended are later unsaved edits, not part of the committed candidate.

After a genuine durable commit, publish a detached memory hydrated from the committed bytes to cache/index and retain the returned authority. Do not publish the potentially edited caller instance as the durable snapshot. Successful audit follows durable publication.

On rejection, preserve attempted content, original authority and the exact causal error in pending state. Stale, dirty-head, conflict and candidate refusals remain distinct from infrastructure or ownership failures. Do not silently merge, drop changes, refresh an old candidate's token or retry blindly. Unknown outcomes block further writes on that instance; choosing a newly loaded working instance is an explicit recovery step, not evidence that the old attempt failed.

A file error carrying a known-committed receipt remains a durable outcome even when subsequent cleanup or lease release fails. Preserve its token and receipt separately from the cleanup failure so the caller cannot retry the old authority as if no write occurred. Database conditional UPDATE uses its existing transaction outcome contract; this slice does not invent a new transport classifier. Failure audit must not replace the original error.

## Qualification boundaries

Adapter acceptance must exercise central load/mutate/save and `Memory.save`, same-read hydration, competing loaded copies, database child/tag invalidation and dirty heads, captured tenant changes across awaits, working edits during commit, refusal preservation and known-commit cleanup outcomes. Injection must prove that guarded UPDATE cannot reach legacy persistence. Generic non-memory and adapter-absent compatibility also require coverage.

Synthetic backend ports establish manager publication and error behavior. Actual cooperating POSIX process tests and isolated PostgreSQL tests in the existing required CI establish backend enforcement. Prior foundation results do not qualify the new adapter's final head. This guide makes no test-success claim.

## Remaining integration and activation gates

Central UPDATE does not complete the writer inventory. Each remaining family needs its adapter or explicit guarded-mode refusal:

- AQL immediate/debounced append, clear, retry and shutdown flush, retaining authority through pending and failure ledgers.
- Console ETag/update/delete and installer, pull, sync, copy, import and restore paths.
- Background trust, retention, seeds, name repair and backup replacement.
- Direct database child mutations and conditional CREATE/RENAME/DELETE, rollover and account purge.

Before file writer activation, adoption, CREATE and UPDATE must exclude physical canonical archive descendants, with alias-safe admission and preservation tests. Shared namespace-refusal audit must redact paths/tokens and preserve the original refusal if delivery fails. These remain the [archive-admission](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5945613602) and [refusal-audit](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5956682199) follow-ups; merged head DELETE and archive erasure do not establish every writer's admission boundary.

The existing [#2870](https://github.com/DollhouseMCP/mcp-server/issues/2870), [#2871](https://github.com/DollhouseMCP/mcp-server/issues/2871) and [#2907](https://github.com/DollhouseMCP/mcp-server/issues/2907) activation gate retains complete route-or-refuse coverage, legacy-writer drain, qualified data reconciliation, protected backup/restore, ownership-aware rollback and combined lifecycle acceptance. Remaining rename/manual-lease procedures, mixed-expiry retention and practical capacity/concurrency qualification retain their existing scopes. Foundation merges do not authorize activation, maintenance execution or deployment. Separate performance, maintainability and dependency/image remediation follow-ups are not replaced by this adapter.
