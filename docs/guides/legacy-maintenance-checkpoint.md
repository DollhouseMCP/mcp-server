# One-time legacy maintenance handoff

The explicit `legacy-offline-update` action bridges the qualified legacy app to v2 inside an owner-approved maintenance window. It is not a v2 drain acknowledgement, a deployment authorization, or permission to start a window. The operator must first receive **START WINDOW**, pass the current runbook's go/no-go checks, and prepare the offline Caddy migration. No host action is performed by reviewing or merging this code.

The supported legacy image is the observed AMD64 store manifest `sha256:13d294b73a003c602676a8978f3ec27f2ab820fc45bf597eebc072629216c64a`, qualified config `sha256:2ba0fe4a3d0192990d2cf6ad0d4a4dc0f8d60022bcc0ec8278edc6d0bca6a6fd`, retained archive SHA256 `3324e25e3b6be147bdd396fced766abde54781061fbe1e0f9d49dca136f1d45e`. The bridge pins its inspected configuration/layer fingerprints and inherited command, not a mutable tag or a fabricated `Config.Image`. Other images and platforms are refused. The [negative legacy qualification](../security/legacy-handoff-qualification-2026-11-09.md) remains valid: this image cannot prove settlement of all accepted operations.

## Explicit recovery boundary

The legacy app can acknowledge work before its deferred save completes. Quiet traffic, an idle display, normal TERM and exit zero do not prove every acknowledged operation reached storage. The operator must explicitly accept the **persisted checkpoint** boundary; acknowledged in-memory work can be lost. A backup/restore rehearsal does not eliminate that limitation. Inventory and control all writers, bypass routes and restart supervision under the approved runbook; Docker mount checks do not discover arbitrary host processes or external database clients.

Mick's selected backup mechanism is a Hetzner server snapshot plus an off-server `pg_dump` on the Dev Work VM. The restore authority restores the VM-retained bytes into disposable Postgres and verifies all migration ledger hashes and user-table row counts against the same exported source snapshot as the dump. Globals/roles are captured separately. Table counts are not per-row content or production authentication tests.

The receipt supports a provider snapshot ID. For now the **only** permitted absence record is the literal `snapshot: not taken (no hcloud context)`. This records the owner-accepted standard-backup fallback when no usable context exists; it never claims a provider snapshot was taken. Do not ask for or improvise credentials when none are configured. Do not substitute the ephemeral PostgreSQL exported-snapshot hash for a Hetzner snapshot ID. The prior proposed Object Lock requirement is superseded by this owner decision.

## Protected checkpoint input

Stage a new canonical directory owned by the deployment operator, mode `0700`. Each file must be a regular single-link file owned by that operator, mode `0600`; symlinks and changed/unreadable artifacts refuse admission. Preserve the original VM copy and all earlier receipts. Stage these exact producer artifacts without editing their contents:

- `database.dump`, `globals.sql`, `observation.jsonl`, and `manifest.json` from the exported-snapshot backup.
- `vm-receipt.json` from the actual off-server transfer/read-back operation. Its source manifest and every artifact hash/size must match; its machine identity must differ from the live host.
- `restore-proof.json` and `restored-observation.jsonl` from the actual disposable restore of those VM-read-back bytes. The proof's dump, source manifest, VM receipt, observation hashes, 62 ordered migration hashes and complete table/count tuples must agree. Success flags or equal numbers of ledger rows alone are insufficient.
- `checkpoint.json`, assembled for this actual host/app boot using the following schema. Replace the placeholders with real observations and SHA256 values; this example is not a receipt:

```json
{
  "schema": 1,
  "kind": "legacy-offline-checkpoint",
  "app": {
    "id": "<64 lowercase hex container ID>",
    "image_id": "sha256:13d294b73a003c602676a8978f3ec27f2ab820fc45bf597eebc072629216c64a",
    "started_at": "<exact Docker StartedAt>",
    "restart_count": 0
  },
  "dump_sha256": "<database.dump SHA256>",
  "manifest_sha256": "<manifest.json SHA256>",
  "vm_receipt_sha256": "<vm-receipt.json SHA256>",
  "restore_proof_sha256": "<restore-proof.json SHA256>",
  "snapshot": "snapshot: not taken (no hcloud context)",
  "accepted_boundary": "persisted checkpoint; in-memory settlement not established"
}
```

When a provider snapshot exists, replace `snapshot` with `{"id":"12345678","status":"taken"}` using its real ID. A missing field, null, empty ID, vague absence string, wrong host/app/database identity or inconsistent artifact refuses admission. The local proof files are trusted operator evidence, not independent remote attestation; retain the actual transfer and restore operation receipts. Take the real checkpoint again under the window's approved writer/fence procedure rather than silently promoting an earlier live rehearsal.

## Execution order and refusal behavior

The standard remote wrapper creates its existing pre-action SQL dump and `.env`/`.env.production` backups before invoking the helper. For this one-time action it requires the existing Compose and both env files, successful database readiness and a nonempty dump; `--skip-backup` is refused. These supplementary plain SQL/env backups do not replace the VM-retained custom-format dump or the disposable restore proof bound by the handoff. SSH host access does not imply a Hetzner API context. If no usable existing `hcloud` context is available, Mick accepts the explicit absence record above plus these standard backups and the verified VM dump/restore proof. If a working context exists, take the provider snapshot immediately before the window and bind its real ID instead. Do not install/configure credentials or create a snapshot during source preparation.

Use the existing runbook to verify/pull the runtime, migration, Caddy and helper images by digest before any outage. The action requires explicit registry mode and an existing app/database; it cannot install a fresh stack or build images. The internal `legacy_handoff.py preflight` accepts its bounded request on stdin and validates checkpoint/current service identities without stopping anything; the action repeats that preflight before staging or proxy changes. The request keys are `deploy_dir`, `instance`, `data_volume`, `config_volume`, `token` (empty for preflight), `checkpoint_dir`, `app_id`, and `postgres_id`.

After START WINDOW and the approved offline Caddy preparation, invoke the remote wrapper with the same qualified image/volume selections and the actual remote checkpoint path:

```bash
DOLLHOUSE_HOSTED_IMAGE_MODE=registry \
DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT=/protected/actual-window-checkpoint \
  scripts/hosted-remote-deploy.sh legacy-offline-update
```

This follows the ordinary guarded update's image admission, PostgreSQL readiness, source/recovery binding and Caddy verification profile. Only after the active/startup Caddy profile and public negative probes are verified does it consume the checkpoint. It requires the exact legacy app/container boot, unchanged image/command/configuration/storage, no direct published app port, no other Docker writer to the portfolio, and the same running PostgreSQL identity/mounts as the backup.

Before issuing a signal it durably writes `.legacy-handoff/issued.json`, binding the checkpoint hash, dump/proof hashes, host/app/storage identities, snapshot record and current transition/fenced-proxy identities. It then issues one `docker stop --signal SIGTERM --timeout -1` with a bounded client deadline. Infinite daemon grace prevents Docker's ordinary SIGKILL fallback. Timeout, client error or an uncertain outcome never authorizes retry, restart, schema writes, or inference of success merely because the app later appears stopped.

Only that same command's success plus unchanged boot/restart/profile and clean exit zero produces `.legacy-handoff/receipt.json`. It never hides, removes or renames the old container to evade the v2 refusal. The bridge revalidates the stopped app, checkpoint, source database and active Caddy fence before migrations, bootstrap and normal app replacement. Normal migration/admin-connection/grants ordering is unchanged. Public acceptance checks run before the normal serving proxy profile is restored, under the merged release-ordering guard.

Any failed check keeps the pending state/fence and both completed and incomplete evidence. Stop and recover to the runbook's defined checkpoint point; do not retry or manually erase the issued marker. A new v2 container, if running, must stop through the unchanged v2 drain contract before recovery. Never start the old image against an unqualified migrated schema. Source-only rollback does not restore a database; restore the checkpoint into fresh destinations and verify it before reopening. The original image/archive, database/volume recovery point and proxy recovery identities remain required.

## Routine updates and test scope

### Recovery baseline and first-write boundary

For `legacy-offline-update`, the helper arms a private
`.legacy-recovery/window-<transition-token>/` baseline after selecting the pending
source/receipt and before rendering any deployment file. It binds the actual
qualified checkpoint, host, app/Postgres profiles, original source and configuration,
and current helper implementation. Environment snapshots remain `0600` inside a
`0700` directory. Required files must already be regular, single-link, protected
operator-owned files; symlinks and changed configuration refuse admission.

Before the first migration command, the helper revalidates the completed handoff
and database schema, globals/grants and all 62 ordered ledger hashes. It then
fsyncs an exclusive `forward-write-issued.json` before migrations, grants or
bootstrap can execute. Any such record, including an incomplete or unknown result,
requires qualified checkpoint restoration before legacy data recovery. Preserve
it; a missing write record alone is insufficient without the complete matching
armed baseline and supported execution path. Neither boundary action starts,
stops or restores a service.

Recovery compares Docker mount arrays after sorting complete records by
`(Destination, Type, Source/Name)`. Every field remains exact; missing, extra,
changed or duplicate mounts refuse. This canonicalization changes ordering only.
Database fingerprints cover schema, owners, grants/globals and the ordered ledger;
they do not claim universal row/WAL equality or prevent an administrator or external
client from writing outside the approved procedure.

Once v2 is live, use ordinary `update`. It continues to require the private boot-bound v2 drain and zero obligations; a stopped legacy app remains refused. The legacy action cannot accept the v2 image or reuse an issued receipt. No legacy flag is persisted to the deployment environment. Ordinary updates do not repeat this backup, offline Caddy conversion or maintenance window. A single-app drained restart has an interruption covering drain, migration/grants, startup and verification; seconds are a target, not zero downtime or a measured guarantee.

CI uses disposable in-memory backup/Docker fixtures for the bridge's proof crosslinks, refusal ordering, clean/unknown stops and one-shot state, plus the existing supported-contract/native Caddy jobs. Synthetic fixtures are not real host checkpoints or real handoff receipts. Exact-image runtime/recovery observations and the actual window's receipts must be retained separately; no live operation is implied by CI green.
