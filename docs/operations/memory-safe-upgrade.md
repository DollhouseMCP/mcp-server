# Memory-safe graceful replacement (qualification pending)

This change addresses #3049, a child of #2870/#2998. It does not inherit the
one-time internal beta cutover exception for transient test RAM.

The root lifecycle closes mutation admission synchronously, retains all admitted
requests and every original persistence promise, and holds root/session owners
until known completion. A drain deadline or failure keeps admission closed,
the old process alive, and storage available. A later explicit signal can retry
an exact candidate that definitely failed before persistence began. An unknown
write or a committed write whose publication failed remains retained and refuses
automatic replay; this change provides no operator reconciliation endpoint.

Legacy addEntry replies now await persistence instead of acknowledging a pending
debounce. Same-process legacy mutations use an effective-owner/root FIFO and a
fresh raw read. Stale loaded candidates refuse rather than overwrite a newer
read. This is not a cross-process writer fence or guarded cohort admission.
Existing guarded delayed/retry refusal remains in force.

The supported hosted update and rollback paths invoke
`scripts/hosted-graceful-stop.sh FULL_CONTAINER_ID 60` before migrations or
replacement. The helper requires the qualified image's
`org.dollhousemcp.memory-upgrade-drain=v1` label, sends TERM once, and accepts only
an observed clean exit. Its deadline bounds Docker commands and retains the old
container; it never invokes stop/down/remove/KILL/recreate. Do not follow a
refusal with an independent compose replacement or force-stop command. An older
unlabeled image refuses; the helper cannot retrofit accounting into that process.
Standalone migrations remain separately protected maintenance operations.

This is drain/reconnect behavior, not zero downtime. The label alone is not
qualification: the exact image must have passed source review, required CI and
actual process tests. Those gates remain pending for this draft. Local process
fault injection before the original persistence method demonstrates definite
pre-write failure; it does not demonstrate a database unknown-commit recovery.
