# Offline single-block DangerZone recovery

This operator tool implements the offline workaround in #2431 and #3000. It removes one explicitly selected block from an existing version 1 `blocked-agents.json`; it does not clear activation state, reset all agents, prove an orphan's liveness, stop processes, or implement online recovery. Online recovery remains open under #2431.

## Obtain operational authorization first

Publishing this tool does **not** authorize stopping a live service or modifying its files. Obtain separate authorization for the exact namespace, writer stop/drain, recovery and restart. Inventory every process, replica, worker, root enforcer, HTTP-session enforcer and mounted writer that can touch that namespace. Stop and drain them under the deployment runbook, preserve evidence of their termination and outstanding writes, and establish exclusive control of the selected volume for the entire inspection/prompt/backup/replacement interval. Another operator or service must not write during that interval. The final comparison and rename are not a filesystem compare-and-swap.

Registry absence, expired or closing presence, a termination ACK, an empty local lock registry, a CLI flag, or the evidence file below are not proof of this exclusion. An ACK can precede or survive incomplete disposal; enforcers and registries can be process-local. If exclusion is uncertain, keep the target unchanged. This tool does not supply a new lock or shutdown protocol.

Select the actual configured `securityDir`, not a guessed user path. The stdio root default is `~/.dollhouse/security`; HTTP enforcers use the configured user path resolver's security directory. Different resolver configurations can select different directories. The only file replaced is `<securityDir>/blocked-agents.json`. Neither `activation.json` nor any other security file is an input to a reset.

## Protected operator evidence and credentials

Create a privately owned mode 0600 UTF8 JSON evidence file, using the canonical namespace path. Its bounded contents record the actual reviewed observations; values below are examples, not an instruction to assert shutdown without proof:

```json
{
  "namespace": "/canonical/selected/security-directory",
  "writers": [
    { "identity": "reviewed writer identifier", "stopDrainEvidence": "reference to actual stop and completed-write-drain observations" }
  ],
  "exclusiveControlEvidence": "reference to exclusive mounted-volume control for this recovery interval"
}
```

The file is limited to 64 KiB, with one to 100 inventory entries. Protect references containing operational details. The executor checks structure, ownership, mode, exact namespace and unchanged bytes/identity; it does not independently verify the observations.

Use the existing configured `DOLLHOUSE_DANGER_ZONE_ADMIN_TOKEN` from the selected service's approved credential configuration. Do not mint a replacement token or choose a new value to authorize recovery. Existing host/SSH access and execution as the target file's actual OS owner are also prerequisites. Root authority can provision approved access, but cannot run replacement for a target owned by another UID: the staged 0600 file must remain readable by the same service owner after restart. The CLI refuses cross-owner targets before confirmation or replacement. The CLI asks for the token without echo; never place it in command arguments, shell history, evidence or audit data. An absent/empty configured token refuses.

## Run locally on the excluded namespace

Use the repository's already installed `tsx`; do not install software as part of recovery:

```sh
./node_modules/.bin/tsx scripts/dangerzone-offline-recovery.ts \
  --security-dir /canonical/selected/security-directory \
  --agent exact-agent-name \
  --quiescence-evidence /protected/operator-evidence.json
```

Run only from an interactive POSIX operator terminal on a filesystem supporting the requested local directory sync/rename operations. Windows recovery is not supported by this CLI. There is no `--yes`, piped credential, HTTP/MCP endpoint, session-absence bypass, or automatic retry. Review the displayed exact agent, namespace, whole-file digest, target-block digest and evidence digest. Enter the displayed one-use confirmation code yourself. One incorrect attempt or five-minute expiry invalidates the challenge. The terminal is a confirmation channel; it does not itself establish human identity or writer exclusion. Renewed attempts require new inspection and confirmation.

## Evidence and outcomes

Each attempt creates a unique mode 0700 `offline-recovery-<invocation>` directory inside the selected namespace. `audit.jsonl` is mode 0600 and records redacted invocation/outcome/operator/proposal digests. The exact original bytes are backed up exclusively as `original.json` mode 0600 before replacement. Backup and audit files are **evidence**, not the target to modify. A fully written/synced unique `.blocked-agents-recovery-<invocation>.tmp` is staged in the same directory. The executor revalidates target, evidence, backup, stage and directory identities after the prompt and again immediately before rename. It refuses symlinks, alias paths, multi-linked files, untrusted writable directories/files, corrupt UTF8, unsupported or ambiguous JSON, absent targets and changed snapshots. Unknown bystander metadata is preserved semantically; the replacement uses normal JSON formatting. The backup preserves original bytes exactly.

Status is reported without raw error details or credentials:

- `completed`: exact replacement was observed, requested file/directory syncs and completion audit succeeded.
- `refused`: an explicit prerequisite or authority refusal prevented replacement.
- `failed`: a pre-replacement I/O/parsing/audit failure prevented dispatch; preserve evidence.
- `replacement-unknown`: rename was attempted, but completion or replacement verification is uncertain. Do not infer rollback or retry.
- `committed-audit-incomplete`: the exact replacement was observed, but subsequent sync/audit/close completion failed. Do not infer rollback or report full completion.

Before rename, the executor does not write the target. A rename exception can follow actual replacement. Failed or ambiguous attempts keep their artifacts; no automatic restore, cleanup or retry occurs. After any failure, keep writers stopped, inspect the target and preserved backup/audit under the same exclusion authority, and obtain a separate decision before restoration or another attempt. A failed audit cannot guarantee delivery of its failure record. File/directory syncs are local durability boundaries, not a crash-proof or remote logging guarantee.

After completed recovery, verify the selected block is absent, all bystanders and activation state are unchanged, and the exact backup/audit exists. Restart only under the separately approved deployment/operational plan. Preserve the old receipts and record the actual operation; tests and tool publication are not evidence that a live recovery happened.
