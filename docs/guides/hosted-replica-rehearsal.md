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

    python3 scripts/hosted-replica/prepare_inputs.py inventory.json control-files prepared [known.json]

Each placeholder gets a fresh random value in the form the application requires.
No production secret is needed, and none may be copied. Data that production
encrypted with its own keys stays unreadable on the replica.

Add to `prepared/inputs.json` what only an operator can decide: the database
dump to restore, settings the replica must not share with production such as
mail, and a stand-in for an image or a command that cannot be reproduced. The
header of `build_replica.py` lists the keys.

## 3. Build and compare

    python3 scripts/hosted-replica/build_replica.py build inventory.json prepared/inputs.json state.json > build-receipt.json
    python3 -I scripts/hosted-deploy/live_inventory.py > replica-inventory.json
    python3 scripts/hosted-replica/compare_inventory.py inventory.json replica-inventory.json allowed.json > compare-receipt.json

The build replays the networks, the volumes with their folder layout, the
deployment files and every container, in the order they were created on the
live host, and brings each container to its recorded state. Its receipt lists
every substitution it made.

The comparison treats identifiers, times and addresses by kind and requires
everything else to be equal. A difference that must remain needs an entry in
the allowance file with a reason. An unexplained difference, or an allowance
that matches nothing, fails the comparison.

`build_replica.py destroy state.json` removes what the build created.

## 4. Record the commands a rehearsal issues

    export PYTHONPATH=scripts/hosted-replica/recorder
    export DOLLHOUSE_REPLICA_COMMAND_LOG=/root/commands.jsonl
    # run the rehearsal with the real tooling
    python3 scripts/hosted-replica/command_forms.py coverage /root/commands.jsonl

`command-forms.json` lists every docker, nsenter and curl command form that
`scripts/hosted-deploy/*.py` builds. The recorder writes each child process the
tooling really starts. The coverage report fails until every form was issued
at least once and no recorded command is outside the list.

## What a replica does not reproduce

The CDN in front of the public hostname, public DNS, certificates from a public
authority, registry pulls of private images and delivery of mail. Name each one
in the rehearsal receipt.
