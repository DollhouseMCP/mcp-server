# Memory-safe graceful replacement (qualification pending)

This change addresses #3049, a child of #2870/#2998. It does not inherit the
one-time internal beta cutover exception for transient test RAM.

The root lifecycle closes mutation admission synchronously, retains all admitted
requests and every original persistence promise, and holds root/session owners
until known completion. A drain deadline or failure keeps admission closed,
the old process alive, and storage available. After the original attempt settles,
a later explicit helper/drain request can retry an exact candidate that
definitely failed before persistence began. Do not retry by sending a direct
Docker signal. An unknown
write or a committed write whose publication failed remains retained and refuses
automatic replay; this change provides no operator reconciliation endpoint.

Legacy addEntry replies now await persistence instead of acknowledging a pending
debounce. Same-process legacy mutations use an effective-owner/root FIFO and a
fresh raw read. Stale loaded candidates refuse rather than overwrite a newer
read. This is not a cross-process writer fence or guarded cohort admission.
Existing guarded delayed/retry refusal remains in force.

The supported hosted update and rollback paths invoke
`scripts/hosted-graceful-stop.sh FULL_CONTAINER_ID 60` before migrations or
replacement. The deployment host needs Bash, Python 3, and the Docker CLI.
The helper requires the qualified image's
`org.dollhousemcp.memory-upgrade-drain=v2` label and exactly one opt-in setting,
`DOLLHOUSE_MEMORY_UPGRADE_CONTROL_DIR=/app/.memory-upgrade-control`.
Supported hosted Streamable HTTP containers have a writable root and no mount covering
that private UID1001, mode0700 directory. The admission latch persists in the
container's writable layer across process/container restart; it is not in tmpfs
or the customer portfolio. Read-only roots, covering mounts, invalid opt-in
settings and unsupported images refuse. Opting into this control in stdio or standalone --web mode refuses startup before
the private channel or normal owner graph is created. Standard non-opted stdio
keeps its existing startup behavior; its retry and deferred-setup drain contract
is not qualified by this change. Future stdio support is tracked in
[#3056](https://github.com/DollhouseMCP/mcp-server/issues/3056).

The helper requests drain through the private Unix operator channel and requires
a bounded nonce/boot/generation-bound known-drained acknowledgement before its
single Docker TERM. It then accepts only an observed clean exit. A requested
hold or an incomplete/corrupt/unknown successor latch holds admission closed and refuses
completion; a known-drained successor stays control-only until closure. Never
clear the latch or reopen admission automatically. The latch does not recover
transient payloads from a failed process. No public maintenance endpoint or
restart-policy mutation is added.

Its deadline bounds Docker commands and retains the old container before a known
acknowledgement; it never invokes stop/down/remove/KILL/recreate. The existing
10-second command cap can disconnect a longer drain while the original work
continues. Wait for settlement and make a fresh helper request; do not cancel,
force-stop or blindly replay it. Initially stopped status alone is not a drain
certificate. Do not follow a
refusal with an independent compose replacement or force-stop command. An older
unlabeled image refuses; the helper cannot retrofit accounting into that process.
Standalone migrations remain separately protected maintenance operations.

This is drain/reconnect behavior, not zero downtime. The label alone is not
qualification: the exact image must have passed source review, required CI and
actual process tests and the native Docker four-case restart/closure witness.
Fresh final-head gates remain pending for this draft. Local process
fault injection before the original persistence method demonstrates definite
pre-write failure; it does not demonstrate a database unknown-commit recovery.
