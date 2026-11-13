# The legacy upgrade window, from one plan file

`scripts/hosted-window/window_driver.py` runs the upgrade of a legacy hosted
deployment from one private plan file. It replaces handwritten shell: exports
typed into a session, requests written by hand and one script per window. It
runs the same qualified actions that `hosted-deployment-automation.md` and
`legacy-recovery-action.md` describe, in a fixed order, and keeps a journal.

It does not decide anything the actions decide. An action that refuses still
refuses. The driver adds the order, a fixed environment, a record of each step
and the name of the recovery action that fits a failure.

## The plan

One JSON file, private to the operator. Every field is required, and an
unknown field is refused.

```json
{
  "schema": "hosted-window-plan-v1",
  "source": {"dir": "/root/window/source", "commit": "<40 hex>", "tree": "<40 hex>"},
  "deploy_dir": "/opt/dollhousemcp",
  "instance": "site",
  "hostname": "mcp.example.com",
  "public_base_url": "https://mcp.example.com",
  "images": {
    "runtime": "registry.example/app@sha256:<digest>",
    "migration": "registry.example/app@sha256:<digest>",
    "caddy": "registry.example/caddy@sha256:<digest>"
  },
  "caddy_volumes": {"data": "site_caddy_data_v2", "config": "site_caddy_config_v2"},
  "reconciliation_input": "/root/window/reconciliation-input.json",
  "docker_config": "/root/window/registry-auth",
  "versions": {"legacy": "2.1.0-beta.2", "upgraded": "2.1.0-beta.3"}
}
```

`source.dir` is a clean checkout of the qualified commit. Run the driver from
that checkout: it refuses to run from any other copy. `docker_config` may be
`null`.

## Commands

```bash
python3 -B /root/window/source/scripts/hosted-window/window_driver.py plan PLAN
python3 -B /root/window/source/scripts/hosted-window/window_driver.py run PLAN JOURNAL
python3 -B /root/window/source/scripts/hosted-window/window_driver.py run PLAN JOURNAL --checkpoint DIR
python3 -B /root/window/source/scripts/hosted-window/window_driver.py status PLAN JOURNAL
python3 -B /root/window/source/scripts/hosted-window/window_driver.py recover PLAN JOURNAL ACTION
```

`PLAN`, `JOURNAL` and `DIR` are absolute paths as written, without a `.` or
`..` part.

- `plan` prints the runbook: every step with its exact command line, input and
  environment. It is built from the list of steps that `run` executes, so the
  two cannot differ. It changes nothing.
- `run` executes the phases in order and stops at the first failure. `--first`
  and `--last` limit it to a range of phases. A run that ended without a
  failure can go on later with the same plan and journal. The first phase is
  fixed when the journal is opened: a later run cannot reach back before it.
- `status` reads the journal and the tooling's own records and names the one
  recovery action that fits, or says that none does.
- `recover` runs a recovery action only when it is the one `status` names.

## Phases

| Phase | Steps | Service |
|---|---|---|
| 0 | source check; `preflight-legacy-reconciliation` | legacy serves |
| 1 | `prepare-legacy-reconciliation`; `reconcile-legacy` | legacy serves |
| 2 | `prepare-caddy-offline` | **ingress closes** |
| 3 | hand-over: the operator's fresh checkpoint | closed |
| 4 | `legacy-offline-update` | closed, then the upgraded version serves |
| 5 | `verify`; read-back | upgraded version serves |

Phase 3 is not the driver's work. `run` stops after phase 2 with exit status
4. The operator makes the fresh checkpoint with the procedure they own:
capture, off-host copy, read-back and restore proof. `run` again with
`--checkpoint DIR`; the tooling's own checkpoint check must accept the folder
before phase 4 starts.

The read-back (`read_back.py`) checks what serves against the plan and the
checkpoint: the pinned images by digest, the new volumes, the database's
container and boot, the completed transition, the deployed revision, the
public answers and version. It takes the expected migration ledger from the
pinned migration image: the hash of each migration file the image's journal
lists. To read the image it creates one container from it without a network,
never starts it, and removes it.

## What every step gets

- One child process from an argument list. No shell builds a command.
- A fixed environment built from the plan. Only `HOME` is inherited, so a
  variable left in the operator's session cannot reach an action.
- Standard input closed, or the one request file the action reads.
- No bytecode cache. The tooling's identity is a hash of its folder.
- Its own session. A dropped terminal reaches neither the driver nor the
  step. `SIGINT` and `SIGTERM` stop the run between steps, never inside one.
- A journal record before it starts and after it ends, with the command, the
  environment, the exit status and the hashes of its output files.

The pinned source is checked by commit and tree, and must hold no other file,
before the first step and again before every step that changes the host,
each step of a recovery included.

A step that changes the host is never ended by the driver, however long it
takes; the journal notes when it passes its expected time. A read-only step
is ended at its limit.

## When a step fails

The driver stops. It retries nothing and recovers nothing by itself.

| Where it stopped | `status` names |
|---|---|
| Before phase 2 | nothing: no step that stops the service has run |
| After phase 2, no update is pending and the proxy is stopped | `abandon-caddy-offline` |
| In phase 4, before a recovery baseline was armed, proxy still stopped | `return-unarmed-update`, then `abandon-caddy-offline` |
| The same, but the proxy is running or its state is unknown | nothing: an unrehearsed order, review first |
| In phase 4, after arming, before the forward write | `recover-legacy`, then `reconcile-legacy` |
| In phase 4, after the forward write, the upgraded app runs, stopped at acceptance or release | `complete-legacy-update`, then `run` again |
| In phase 4, after the forward write, anywhere else | nothing yet: restore from the checkpoint by its runbook |
| A recovery ended between its two steps | the second step: `abandon-caddy-offline`, or `reconcile-legacy-after-recovery` |
| No update is pending, and the proxy runs or its state is unknown | nothing: check what serves first |
| The update was completed outside the journal | nothing: verify it in a new journal with `--first 5` |

A recovery of two steps can end between them: the first step failed its
source check, a signal asked for a stop, or the second step did not pass.
`status` then names the second step alone. An action that is named again reads
the request file its first run wrote in the journal.

`complete-legacy-update` is not a way back. After the upgraded app has started,
the update has four steps left: the public acceptance probe, the release of
the normal proxy profile, the completion record and the deployed markers. If
it stops at one of them, the upgraded app runs on the migrated database and
the proxy still answers 503. The action proves that only those steps are left
and runs them. A failed acceptance changes nothing, so the action can be named
again. When it passes, the update has passed: `run` with the same journal goes
on with phase 5.

`status` reads the host as well as the journal. A proxy that runs is never
brought back on the journal's word alone, and an update that the host records
as complete is reported as complete, whichever journal or hand completed it.

A journal that ended in a failure or a recovery is closed. A second attempt
needs a new journal, a plan with new Caddy volume names, and `--first 2`:
reconciliation has already run and cannot run twice.

## Exit status

| Status | Meaning |
|---|---|
| 0 | the requested phases passed |
| 3 | refused, or a step failed |
| 4 | waiting at the hand-over |
| 5 | stopped by a signal between steps |

## Rehearsal on a replica

A plan may hold a `replica` section: `pins_dir`, the working folder of
`run_with_replica_pins.py`, and optionally `path_prefix`, a folder searched
for commands first (used to inject a failure). With it, reconciliation runs
through the replica pin launcher. The section is accepted only on a host that
carries the replica declaration (see `hosted-replica-rehearsal.md`). On any
other host the plan is refused, so a live plan can never hold it.
