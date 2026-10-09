# Admitted profile refuses deferred memory work

Guarded immediate AQL append/clear already persists before returning a receipt.
This boundary adds no deferred admitted save or automatic recovery/replay route.

A `MemorySaveHandler` that observes its current or retained manager as guarded
latches deferred refusal for that whole handler. It cancels timer execution while
retaining the exact queued Memory, manager and captured context. A later absent
or ordinary manager indication cannot reopen its legacy replay paths. A new
immediate request refuses before discovery when old deferred/failure work remains.

Tracked saves, enqueue, legacy append/clear, failure retries and deletion probes
respect the boundary. Checks after awaited validation/probing prevent source RAM
application or bookkeeping deletion after admission is observed. Destructive
bookkeeping cleanup refuses too. A partial flush keeps later queued candidates;
only a completed save or retained exact failure-ledger instance permits removing
its queued entry. Flush/dispose reject refused retained work instead of reporting
a successful drain. Session cleanup retains it without starting a retry.

An already-started write cannot be cancelled by this local latch. If it completes
while the boundary closes, its exact candidate/evidence is retained and no
rollback or cancellation is claimed. Ordinary legacy timer/flush/retry and
confirmed deletion behavior remain when this handler never observes admission.

This is process-local conservative denial, not durable mode/cohort selection,
a crash-durable candidate or a global shutdown fence. A retained OLD ordinary
handler cannot discover another process's mode through this manager check.
Activation must first drain/exclude all old handlers, processes and in-flight
writes; same-transaction legacy SQL denial is a separate final write barrier.
Container/process shutdown must respect unresolved work and verified handoff;
a rejected handler disposal alone does not prove that an outer shutdown caller
will keep the process alive. The restart/candidate retention contract and actual
production composition remain separate prerequisites. No public discard,
force-retry, token refresh, deployment or activation authority is added.
