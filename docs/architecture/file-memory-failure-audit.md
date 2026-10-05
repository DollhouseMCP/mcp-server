# File-memory component failure audit

`FileMemoryFence` and `FileMemoryOwnedHeadEvidence` emit best-effort
`OPERATION_FAILED` events when their effectful component boundaries fail.
The event identifies a fixed component/stage and explicitly leaves the storage
outcome unclassified. A unique invocation value in `details` prevents the
monitor's existing deduplication from collapsing separate same-stage failures.
Paths, locators, content, digests, owner tokens, and error messages/codes are not
included in the event payload.

Fence callback failures are observed after the lease release attempt. A callback
may already have committed before throwing, and a successful callback followed by
release failure does not establish rollback or commit. Original rejection values,
including null/undefined and callback-plus-release aggregate causes, are preserved.
Evidence helpers share a private invocation scope, so a composed read/write/close
failure is observed once at the outer evidence boundary after its cleanup/error
composition. Partial evidence writes may remain; the event does not claim that
nothing changed. Neither component emits new success events inside safety proofs.
Audit delivery and fallback warning failures are contained and do not replace the
storage error or grant authority.

`FileMemoryAbortIntentCodec` remains a pure bounded value parser/serializer. Its
internal `validate()` calls do not perform filesystem operations, ownership or
authorization decisions, or lifecycle mutations. The central suppression registry
therefore excludes only `DMCP-SEC-006` for that exact file. Other rules and adjacent
storage files remain covered. Re-review that disposition if effects or authority
are added; operational abort audit remains the effectful caller's responsibility.

These events use the existing in-memory monitor and forwarding listener. They do
not establish crash-durable logging, guaranteed delivery, complete tenant/session
attribution, or coverage for every other writer. The broader audit and activation
contracts in [#254](https://github.com/DollhouseMCP/mcp-server/issues/254),
[#2789](https://github.com/DollhouseMCP/mcp-server/issues/2789), and
[#2906](https://github.com/DollhouseMCP/mcp-server/issues/2906) remain open; this
change does not activate the file writer.
