# Dormant central memory UPDATE adapter

This document describes the accepted first integration slice of [#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5974017381). It is an implementation contract, not a qualification receipt. The adapter is selected only through explicit `MemoryManager` construction in qualification tests. Production dependency injection, configuration and storage factories do not enable it. A manager without the adapter retains existing behavior; test injection is not a deployable mixed legacy/guarded writer mode.

## Authority and scope

The slice supports same-name, same-locator UPDATE of an existing owned memory. It reuses the database and file conditional head primitives rather than introducing a lifecycle protocol. File operations use the existing tenant coordinator, with no nested lease or per-locator lock presented as lifecycle exclusion.

Capture the authenticated tenant before the first await. Read content and its complete backend authority together, then hydrate exactly that content through the existing memory load pipeline. Retain authority privately on the genuine working instance. File authority includes ownership, tenant root and file identity; it must not be reduced to a database-shaped revision token. Reads never adopt an unowned head. A cached instance may reuse its previously bound authority; a list-created, copied or imported instance cannot acquire fresh authority at save time.

In the injected path, unbound saves, creation, exclusive overwrite, name repair/rename and delete refuse before legacy mutation. The conditional UPDATE branch cannot fall through to ordinary database upsert, raw file writes, backup or directory creation. Non-memory behavior remains outside this memory-specific contract.

## Candidate and outcome handling

Before persistence awaits, capture detached attempted bytes, name, metadata and original authority. Refuse overlapping saves on the same instance and tenant or locator mismatches. Mutations made to the working instance while persistence is suspended are later unsaved edits, not part of the committed candidate.

After a genuine durable commit, publish a deep detached normal-runtime copy of the captured committed state to cache/index without replaying on-load retention or quarantine and retain the returned authority. Do not publish the potentially edited caller instance as the durable snapshot. Successful audit follows durable publication.

On rejection, preserve attempted content, original authority and the exact causal error in pending state. Stale, dirty-head, conflict and candidate refusals remain distinct from infrastructure or ownership failures. Do not silently merge, drop changes, refresh an old candidate's token or retry blindly. Unknown outcomes block further writes on that instance; choosing a newly loaded working instance is an explicit recovery step, not evidence that the old attempt failed.

A file error carrying a known-committed receipt remains a durable outcome even when subsequent cleanup or lease release fails. Preserve its token and receipt separately from the cleanup failure so the caller cannot retry the old authority as if no write occurred. Database conditional UPDATE uses its existing transaction outcome contract; this slice does not invent a new transport classifier. Failure audit must not replace the original error.

## Qualification boundaries

Adapter acceptance must exercise central load/mutate/save and `Memory.save`, same-read hydration, competing loaded copies, database child/tag invalidation and dirty heads, captured tenant changes across awaits, working edits during commit, refusal preservation and known-commit cleanup outcomes. Injection must prove that guarded UPDATE cannot reach legacy persistence. Generic non-memory and adapter-absent compatibility also require coverage.

Synthetic backend ports establish manager publication and error behavior. Actual cooperating POSIX process tests and isolated PostgreSQL tests in the existing required CI establish backend enforcement. Prior foundation results do not qualify the new adapter's final head. This guide makes no test-success claim.

## Remaining integration and activation gates

Central UPDATE does not complete the writer inventory. Each remaining family needs its adapter or explicit guarded-mode refusal:

- AQL debounced append, retry/rebase and shutdown durability; the dormant immediate append/clear route below does not enable these paths.
- Console delete and installer, pull, sync, copy, import and restore paths; dormant console ETag/UPDATE is delivered in [#2996](https://github.com/DollhouseMCP/mcp-server/pull/2996).
- Guarded background trust mutation, retention, seeds, name repair and backup replacement; background trust currently refuses as described below.
- Direct database child mutations and conditional CREATE/RENAME/DELETE, rollover and account purge.

Before file writer activation, adoption, CREATE and UPDATE must exclude physical canonical archive descendants, with alias-safe admission and preservation tests. Shared namespace-refusal audit must redact paths/tokens and preserve the original refusal if delivery fails. These remain the [archive-admission](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5945613602) and [refusal-audit](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5956682199) follow-ups; merged head DELETE and archive erasure do not establish every writer's admission boundary.

The existing [#2870](https://github.com/DollhouseMCP/mcp-server/issues/2870), [#2871](https://github.com/DollhouseMCP/mcp-server/issues/2871) and [#2907](https://github.com/DollhouseMCP/mcp-server/issues/2907) activation gate retains complete route-or-refuse coverage, legacy-writer drain, qualified data reconciliation, protected backup/restore, ownership-aware rollback and combined lifecycle acceptance. Remaining rename/manual-lease procedures, mixed-expiry retention and practical capacity/concurrency qualification retain their existing scopes. Foundation merges do not authorize activation, maintenance execution or deployment. Separate performance, maintainability and dependency/image remediation follow-ups are not replaced by this adapter.

## Guarded background validation refusal

The [#2906 route-or-refuse contract](https://github.com/DollhouseMCP/mcp-server/issues/2906#issuecomment-5894882753) includes background trust updates. `BackgroundValidator.processUntrustedMemories` checks the manager's required `isGuardedHeadUpdateEnabled()` API inside its existing error/finally boundary, before discovery. An injected guarded manager refuses before list, extraction, trust mutation or save; a selection-probe error also prevents discovery. The static unsupported diagnostic uses existing processing-error reporting, and the finally block resets processing state. Entries remain unchanged for a future supported process.

The existing `Promise<void>` API, configuration and timers remain unchanged. A refused pass is not processed success, accepted queued work or a durable retry promise. Each scheduled or direct pass checks selection independently. Adapter-absent managers retain the ordinary pipeline. This refusal captures no tenant data or ownership because it performs no memory access; it does not cancel a legacy pass already in flight. Activation still requires legacy-writer quiescence and the remaining shared audit prerequisites above.

## Dormant immediate MCP-AQL mutations (#2993)

When the manager has the adapter injected, `MemorySaveHandler.dispatch` routes `addEntry` and `clear` through immediate conditional save. Production DI remains unchanged. The handler requires an authenticated session context, captures the raw session tuple and the manager's effective storage owner, and claims their name-specific slot before the first lookup await. The effective owner may be a database UUID resolved by the activation registry while the stdio session still names the local user. Both identities are rechecked across awaits and isolate retained outcomes. Concurrent case-normalized requests refuse rather than overwrite evidence. Missing context, invalid input or missing/ambiguous targets refuse; preparation-only failures release the slot.

`loadGuardedMemoryByName` discovers a locator from fresh duplicate-preserving summaries that reread current names independently of cached mtimes and then hydrates a new working object from its own head snapshot. Discovery/read errors fail closed. Database summaries already query fresh rows; file discovery pins its root and returns readonly observations without changing the index. This is not an atomic global name snapshot. Inventory and cached content never acquire a fresh token. `deriveGuardedMutation` synchronously deep-copies working state and binds only that candidate to the original full authority. Candidate mutation and validation happen after this capture. The source's content/token stay untouched; a later direct source save and candidate save compete under the existing backend conditional write, so one stale candidate refuses.

Only this mutation-hydration route suppresses on-load retention; ordinary public loads retain their configured behavior. Before append, the quiet candidate applies opted-in on-load retention and counts its removals for postcommit reporting. Optional policy-lookup failures retain the legacy fallback, while actual enforcement errors propagate. Clear removes the original entries once without a separate retention pass.

A private unresolved marker is shared by the source and all derived siblings. Derivation, save admission and dispatch check it. Any unknown outcome blocks later replay across that lineage, including candidates derived before the error was learned; an already-dispatched successful write cannot clear another sibling's unknown outcome. Only explicit fresh same-read load starts a new lineage.

Preview append/clear suppress mutation and removal audit until durable save and publication qualify. Plain entry response fields and removal warnings are prepared before save. The handler then emits durable addition/clear and actual removal audit. Known commit remains known if the handler audit throws; exact candidate, manager and cause remain retained. This contract does not promise delivery of the response over the network.

Conflicts, unknown outcomes and known-committed publication failures remain in a session-scoped guarded-operation map; another request refuses instead of probing/reloading/rebasing automatically. Guarded requests create no debounce timers and never enter the legacy failed-save ledger. Session cleanup and shutdown report fixed-size aggregate outcome counts without paths, tokens or raw content, retain the operations, and perform no guarded replay. Existing non-guarded debounce, cleanup and retry behavior is unchanged. Recovery/rebase UX and guarded delayed writes remain separate work; this immediate slice is not an activation gate waiver.
