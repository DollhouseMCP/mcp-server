# Guarded manager reads and early maintenance refusal

A MemoryManager with the internal guarded UPDATE adapter refuses name repair before
cache invalidation, discovery, progress callbacks or runtime name mutation. Seed
installation refuses inside its existing startup error containment before seed
lookup, file reads, deletion or import; it reports failure rather than installation
success. Neither operation is converted into a guarded rename/create workflow.

All guarded snapshot hydration, including public load, list and auto-load,
suppresses load-time retention. This prevents load-time retention removals while preserving existing
validation, quarantine filtering and sanitization. Captured raw bytes and the
privately bound ownership token are unchanged; arbitrary legacy entry identity
is not established by this suppression. Ordinary legacy
hydration retains its opted-in load policy. Explicit supported guarded mutation
preparation retains its existing operation-time retention/capacity semantics.

This is an early boundary for the current guarded manager only. Adapter absence is
not durable legacy permission; mandatory production composition and sticky DB mode
admission remain separate prerequisites. Other retained managers/processes,
background quiescence, derived index writes and DB auto-load selection are not
qualified by these file-backed route tests. The existing BackgroundValidator
pass-level refusal remains unchanged. Account purge/direct privileged SQL and
parent-row cascades require separate route/refusal and operational exclusion proof.
No activation, deployment, replay or recovery authority is added.
