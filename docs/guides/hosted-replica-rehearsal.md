# Rehearse a hosted deployment on a replica

A deployment window can reveal one defect and then must abort. A replica lets
the same tooling meet the real host state first: the real Docker and Compose
versions, the real images, the real control files and markers, a restored
database dump and every leftover container. The scripts in
`scripts/hosted-replica/` build that replica and say how close it is.

A replica proves the mechanics. It cannot prove the live host's identities:
container IDs, boot times and the evidence that names them belong to one host.
Those are proven by the read-only preflight on the live host
([legacy control reconciliation](legacy-control-reconciliation.md)). A window
needs both.

**Everything the scripts read or write on the replica is private.** The
inventory, the control file export, the inputs, the receipts and the allowance
file hold host detail. None of them belongs in this repository, an issue or a
CI log.

## The replica host

Use a throwaway host with the live host's architecture, the same Docker Engine
and Compose versions and the containerd image store. Before any container
starts:

- Block outbound connections from containers. The application holds real user
  data and settings that name real mail and identity services.
- Point the public hostname at the replica itself and trust a throwaway
  certificate authority for it.
- Declare the host, by hand, as one that may be destroyed:

      sha256sum /etc/machine-id | cut -d' ' -f1 > /etc/dollhouse-replica-host

`build_replica.py` refuses a host without that declaration, a host the
inventory describes, and an Engine that holds anything it did not create.

## 1. Read the live host, read-only

Both scripts read only. Each is run by the operator who owns the live host.

    ssh HOST python3 -I - < scripts/hosted-deploy/live_inventory.py > inventory.json
    ssh HOST python3 -I - < scripts/hosted-replica/export_control_files.py > control-files.tar

The export replaces every secret with a named placeholder on the live host,
searches its own output for each secret before writing and refuses to write if
one survived. Read `MANIFEST.json` in the archive before passing it on: a name
marked `kept` has its real value in the archive.

Images that exist only on the live host are streamed with `docker image save`
into `docker image load` on the replica. They go to no registry.

## 2. Prepare the inputs, on the replica

In a private working folder that holds `inventory.json`, the unpacked
`control-files/` and, optionally, `known.json`:

    python3 scripts/hosted-replica/prepare_inputs.py

Each placeholder gets a fresh random value in the form the application requires.
No production secret is needed, and none may be copied. Data that production
encrypted with its own keys stays unreadable on the replica. Each service's
environment is what Docker Compose resolves from the completed files.

Settings the replica must not share with production, such as mail, go into
`overrides.json` in the same folder before the script runs:

    {"EXAMPLE_MAIL_HOST": {"value": "", "reason": "the replica must not send mail"}}

They are applied to the completed environment files and to every container. A
deployment starts the new application from those files, so an override that
reached only the containers would be lost in the rehearsal.

Add to `prepared/inputs.json` what only an operator can decide: the database
dump to restore, and a stand-in for an image or a command that cannot be
reproduced. The header of `build_replica.py` lists the keys.

## 3. Build and compare

    cat inventory.json prepared/inputs.json | python3 scripts/hosted-replica/build_replica.py build > build-result.json
    python3 -I scripts/hosted-deploy/live_inventory.py > replica-inventory.json
    cat inventory.json replica-inventory.json allowed.json | python3 scripts/hosted-replica/compare_inventory.py > compare-receipt.json

Each script reads its documents from standard input, one after another.

The build replays the networks, the volumes with their folder layout, the
deployment files and every container, in the order they were created on the
live host, and brings each container to its recorded state. Its receipt lists
every substitution it made.

The comparison treats identifiers, times and addresses by kind and requires
everything else to be equal. A difference that must remain needs an entry in
the allowance file with a reason. An unexplained difference, or an allowance
that matches nothing, fails the comparison.

The build result holds the receipt and, under `state`, what the build created.
The state is printed even when a step fails. Keep the result:
`build_replica.py destroy < build-result.json` removes what the build created,
and a later build that is given the last result as a third document adds to
the same replica.

## 4. Record the commands a rehearsal issues

    export PYTHONPATH=scripts/hosted-replica/recorder
    export DOLLHOUSE_REPLICA_COMMAND_LOG=/root/commands.jsonl
    # run the rehearsal with the real tooling
    python3 scripts/hosted-replica/command_forms.py coverage < /root/commands.jsonl

`command-forms.json` lists every docker, nsenter and curl command form that
`scripts/hosted-deploy/*.py` builds. The recorder writes each child process the
tooling really starts. The coverage report fails until every form was issued
at least once and no recorded command is outside the list.

## 5. Rehearse the legacy upgrade

The upgrade from the legacy application starts with reconciliation
([legacy control reconciliation](legacy-control-reconciliation.md)). It reads
the evidence of one manual recovery on the live host, and nine hashes of that
evidence are pinned in the tooling. The evidence names the live host's
containers, boots and volumes, so a replica needs the same records about
itself.

1. The original configuration files. Reconciliation puts the files of before
   the failed window back, and they exist only inside the evidence archive,
   with their secrets. Where that archive already is, scrub them as the live
   export does. Nothing is written but the result:

       python3 -I scripts/hosted-replica/export_archived_originals.py < filesystem.tar > original-control-files.tar

2. A checkpoint of the replica's database, taken with the procedure a
   deployment window uses.

3. The replica's evidence. In the working folder of step 2, with
   `original-control-files.tar` beside `prepared/`:

       python3 scripts/hosted-replica/write_recovery_evidence.py < input.json > evidence-report.json

   `input.json` is the input of request preparation: `deploy_dir`, `instance`,
   `checkpoint_dir` and `manual_evidence_dir`. The header of the script lists
   every record it rewrites. Each record it writes says that it is a
   rehearsal record. It also writes `accepted-replica.json`, the replica's
   own nine hashes.

4. The reconciliation actions, through the launcher that replaces the nine
   pins for one process and refuses on a host that is not a declared replica:

       python3 scripts/hosted-replica/run_with_replica_pins.py preflight-legacy-reconciliation < input.json > preflight.json
       python3 scripts/hosted-replica/run_with_replica_pins.py prepare-legacy-reconciliation < input.json > request.json
       python3 scripts/hosted-replica/run_with_replica_pins.py reconcile-legacy < request.json

5. The remaining phases need no launcher. They are the commands of a real
   window: `scripts/hosted-deploy.sh prepare-caddy-offline`, a fresh
   checkpoint, `scripts/hosted-deploy.sh legacy-offline-update`, then
   `scripts/hosted-deploy.sh verify` and a read-back of what serves.

Three rules, each learned from a failed rehearsal:

- Run every deployment action with standard input closed (`</dev/null`).
- Set `PYTHONDONTWRITEBYTECODE=1`. The tooling identifies itself by a hash of
  its own folder, and a bytecode cache written there makes the next action
  refuse.
- A rehearsal leaves containers, volumes and folders the build did not create.
  Remove them before the next build; `build_replica.py` refuses a host that
  holds anything it does not know.

A passing rehearsal does not prove the live host's identities or its nine
pinned hashes. Only the read-only preflight on the live host does.

## What a replica does not reproduce

The CDN in front of the public hostname, public DNS, certificates from a public
authority, registry pulls of private images and delivery of mail. Name each one
in the rehearsal receipt.
