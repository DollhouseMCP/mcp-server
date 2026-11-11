# Reconcile recovered legacy controls before another window

Recovery and reconciliation are separate. Recovering beta.2 does not release a
failed forward control or authorize another deployment. Reconciliation runs
under the deployment lock while the receipt-bound legacy app, PostgreSQL and
proxy keep serving. It performs read-only runtime checks, preserves source and
control-file evidence, and qualifies a new transition without replaying a stop.

Use the exact pinned helper outside the source cache being reconciled. Give
it the eight recovery request fields and a ninth field, `manual_evidence_dir`.
Use null for a completed automated `RECOVERED` operation. For the accepted
pre-journal manual recovery only, give the protected directory containing the
exact filesystem archive/manifest, original inspect record and final recovery
receipt. Those files and the checkpoint must match the retained accepted hashes.
No other historical operation is adopted by this path.

For that manual recovery, **generate the request; do not copy a token from a
clone log, handoff or container name**. The staged transition token selects the
failed state and reconciliation namespace. The serving proxy's recovery label
proves a different identity, bound to the immutable proxy ID and boot in the
accepted manual receipt. The previous-bundle recovery receipt has its own path
and content hash. These identifiers need not be equal.

Prepare a private input containing only `deploy_dir`, `instance`,
`checkpoint_dir` and `manual_evidence_dir`, using the accepted historical paths:

    python3 /pinned/source/scripts/hosted-deploy/legacy_reconcile_action.py \
      prepare-legacy-reconciliation < /protected/reconciliation-input.json \
      > /protected/current-reconciliation-request.json

Use an exclusive output file in a protected directory with umask 077. The
preparation action takes the deploy lock, reads the hash-bound failed state and
accepted archives/checkpoint, and inspects only the receipt-bound serving proxy.
It performs no service, source, configuration, database or volume operation.
It refuses token overrides. Its output binds the transition token and raw state
hash, recovery-receipt path/hash, and serving proxy ID/recovery token separately
in `receipt_identities`. Execution requires that field for manual adoption and
rechecks every binding under the lock before installing any control files.
Do not substitute a token after a refusal or reuse a request after evidence
changes. A generated request is not a successful reconciliation or window GO.

    python3 /pinned/source/scripts/hosted-deploy/legacy_reconcile_action.py \
      reconcile-legacy < /protected/current-reconciliation-request.json

The action verifies the old source/receipt, current app and database profiles
and boots, schema/globals/ledger, serving proxy configuration, original and
partial volume identities, and public 200/200/401 with beta.2. It checks the
entire proxy label inventory; an extra unqualified container refuses before
installation. It uses the original receipt-bound Caddyfile and does not require
the running legacy proxy's writable volume contents to stay byte-identical
while serving. The next offline source qualification and clone capture their
own current volume evidence.

Original Compose and both historical overlays are kept privately. The restored
control Compose file is a private selection model derived from the verified
running containers: cached image IDs, literal environment, commands, network,
and mount identities. It is **not a legacy recreate recipe**. No build,
environment-file interpolation, image pull or service recreation occurs.
The guarded v2 update renders its own new configuration before any migration
or app replacement. Historical optional files absent from the archive are left
unchanged and named in the reconciliation receipt.

The original cached source remains at its receipt-bound previous path. A
verified copy becomes the current source, and the failed source and changed
control files are retained under the private reconciliation operation directory.
Each move has a separate durable intent and acknowledgement. Any failure
retains the partial evidence and leaves the failed controls blocking forward
work. The action never starts, stops, renames or removes a service container,
and never changes a volume or the database.

`RECONCILED.json` is written last. It binds the original failed state bytes,
handoff hashes, current source/configuration, host, helper and exact retirement
authority. The failed state and handoff bytes are unchanged at this point. A
later new qualified update archives those raw state bytes before consuming
the disposition, records separate issued/completed lineage, and uses a new
token-specific handoff directory. A stale checkpoint, missing acknowledgement,
changed file or unknown consumption refuses. Do not clear or edit markers.

Retained labels remain on the stopped containers. Only an exact protected
retirement record can exclude an immutable stopped ID from service selection.
Every profile field, boot, name and ownership label is checked. The old
serving proxy's protected receipt bind is permitted only for that exact
qualified legacy identity. Before rendering, its bytes must also match the
deployment copy. After rendering, prestart validation checks the unchanged
private bind instead of mistaking the new root Caddyfile for the old mount.

When retained labels are present, replacement uses checked Docker create/start
with the admitted digest and no pull, never Compose selection. The stopped
original is retained. Unknown starts are not promoted by later observations;
an exact, acknowledged compensating stop may supply a separate offline
recovery fence. Unproven ownership or unknown fencing still requires
independent reconciliation. Normal hardened v2 updates keep their existing
proxy and do not repeat this legacy conversion.

A reconciled state is still not a window approval. Use new destination volumes,
fresh standard SQL/env backups, a fresh immutable checkpoint, VM read-back
and disposable restore proof, and all immediate go/no-go checks for the next
window. Do not reuse the old checkpoint or start a window based on a fixture.
