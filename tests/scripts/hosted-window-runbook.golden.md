# Legacy upgrade window

Pinned source: commit `1111111111111111111111111111111111111111`, tree `2222222222222222222222222222222222222222`.
Upgrade: 2.1.0-beta.2 to 2.1.0-beta.3 on `site.example.invalid`.

## Environment of every step

Nothing else is set. Only HOME is inherited.

    DOCKER_CONFIG=/srv/window/registry-auth
    DOLLHOUSE_HOSTED_CADDY_CONFIG_VOLUME=site_caddy_config_v2
    DOLLHOUSE_HOSTED_CADDY_DATA_VOLUME=site_caddy_data_v2
    DOLLHOUSE_HOSTED_CADDY_IMAGE=registry.example/caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    DOLLHOUSE_HOSTED_DEPLOY_DIR=/opt/dollhousemcp
    DOLLHOUSE_HOSTED_GIT_REF=1111111111111111111111111111111111111111
    DOLLHOUSE_HOSTED_HOSTNAME=site.example.invalid
    DOLLHOUSE_HOSTED_IMAGE_MODE=registry
    DOLLHOUSE_HOSTED_INSTANCE_NAME=site
    DOLLHOUSE_HOSTED_MIGRATION_IMAGE=registry.example/app@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    DOLLHOUSE_HOSTED_RUNTIME_IMAGE=registry.example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    DOLLHOUSE_HOSTED_SOURCE_DIR=/srv/window/source
    DOLLHOUSE_PUBLIC_BASE_URL=https://site.example.invalid
    LANG=C.UTF-8
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    PYTHONDONTWRITEBYTECODE=1

`legacy-offline-update` alone also gets `DOLLHOUSE_HOSTED_LEGACY_CHECKPOINT`: the accepted checkpoint folder.

## Phase 0: source check and read-only preflight

- `source`: the pinned source is the planned commit and tree and holds no other file. Checked again before every step that changes the host.
- `preflight`: every read-only control of reconciliation. Read-only.

      python3 /srv/window/source/scripts/hosted-deploy/legacy_reconcile_preflight.py preflight-legacy-reconciliation < /srv/window/reconciliation-input.json


## Phase 1: legacy reconciliation

- `prepare-legacy-reconciliation`: write the reconciliation request. Read-only.

      python3 /srv/window/source/scripts/hosted-deploy/legacy_reconcile_action.py prepare-legacy-reconciliation < /srv/window/reconciliation-input.json

- `reconcile-legacy`: reconcile the retained failed transition. Changes the host.

      python3 /srv/window/source/scripts/hosted-deploy/legacy_reconcile_action.py reconcile-legacy < '<journal>/reconcile-request.json'


## Phase 2: offline Caddy preparation

- `prepare-caddy-offline`: stop the serving proxy and clone its volumes; ingress closes. Changes the host.

      bash /srv/window/source/scripts/hosted-deploy.sh prepare-caddy-offline < /dev/null


## Phase 3: fresh checkpoint (hand-over)

- The driver stops here with exit status 4. Ingress is closed.
- The operator makes the fresh checkpoint: capture, off-host copy, read-back, restore proof.
- `run` again with `--checkpoint DIR`. The tooling must accept the folder before phase 4 starts.
- To give the window up here: `recover` with `abandon-caddy-offline`.

## Phase 4: update

- `legacy-offline-update`: new proxy, clean legacy stop, migrations, grants, start, release. Changes the host.

      bash /srv/window/source/scripts/hosted-deploy.sh legacy-offline-update < /dev/null


## Phase 5: verification and read-back

- `verify`: the deployment verifies itself. Read-only.

      bash /srv/window/source/scripts/hosted-deploy.sh verify < /dev/null

- `read-back`: what serves now, against the plan and the checkpoint. Read-only.

      python3 /srv/window/source/scripts/hosted-window/read_back.py '<journal>/plan.json' '<checkpoint folder>' < /dev/null

## If a step fails

The driver stops. It runs nothing else and recovers nothing by itself.
`status` reads the journal and the tooling's records and names the one action that fits:

| Where it stopped | Action |
|---|---|
| Before phase 2 | none: nothing that serves was stopped |
| After phase 2, and no update is pending | `abandon-caddy-offline` |
| In phase 4, before the forward write | `recover-legacy`, then reconciliation |
| In phase 4, after the forward write | none yet: the checkpoint restore runbook |
| In phase 4, before a recovery baseline was armed, proxy still stopped | `return-unarmed-update`, then `abandon-caddy-offline` |
| The same, but the proxy is running or its state is unknown | none: an unrehearsed order, review first |

`recover PLAN JOURNAL ACTION` runs that action only when ACTION is the one `status` names.
A second attempt needs a new journal, a plan with new Caddy volume names, and `--first 2`.
