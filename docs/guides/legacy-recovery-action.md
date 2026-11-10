# Pre-migration legacy recovery

`legacy_recovery_action.py` is an explicit operator action for the qualified
AMD64 beta.2 application and receipt-bound original legacy Caddy profile. It
does not retry the forward update, finish a handoff, restore a database, render
configuration, switch source, clear markers, or remove a container or volume.

Before a new window, the normal legacy update must have successfully armed the
private recovery baseline. The original source, proxy receipt, checkpoint,
restore proof, full app/Postgres profiles, and current schema/globals/62-entry
ledger must still match it. A forward-write intent, uncertain database boundary,
missing known stop acknowledgement, changed helper, or unsupported profile is
an absolute refusal. A qualified fresh checkpoint restore is required if the
database boundary is uncertain. This action does not infer safety from health.

The protected request is the same eight-field JSON request used by
`legacy_recovery_boundary.py`: `deploy_dir`, `instance`, `data_volume`,
`config_volume`, `token`, `checkpoint_dir`, `app_id`, and `postgres_id`. It must
equal the armed request byte-for-value. Do not derive identities from a stale
Compose file or replay an old handoff request. Run the pinned helper on the
local Linux host; it validates the system and acquires the deployment lock.

```bash
python3 /pinned/source/scripts/hosted-deploy/legacy_recovery_action.py \
  recover-legacy < /protected/current-window-recovery-request.json
```

The finite recovery sequence is:

1. Recheck source/control/checkpoint/DB/container/volume/image identities and
   serving-network/ingress ownership. Retain a separate private journal.
2. Stop the exact failed replacement proxy with non-forcing SIGTERM and retain
   both its command acknowledgement and clean-stop proof. This establishes a
   separate **offline recovery fence**, even when a prior private Caddy call was
   refused or UNKNOWN. The forward control record is not promoted or changed.
3. Require either the completed clean handoff or the separate durable Docker
   stop acknowledgement plus fresh clean-state/checkpoint/database proof. If a
   private Caddy check failed after the acknowledged stop, the full handoff
   stays incomplete and cannot authorize SQL. Issue one original-app start, recording the
   intent first and known acknowledgement/boot separately. Observe configured
   Docker health for at most 120 seconds, then require direct 200/200/401 and
   beta.2 package identity. A never-stopped app keeps its original boot.
4. Recheck every exposure precondition. Retain the stopped failed proxy under
   its operation name, create the original receipt-bound proxy once using its
   original volumes and protected Caddyfile, and start it once. Verify full
   profile/boot, actual serving configuration, public 200/200/401, app version,
   DB boundary and unchanged forward controls. Write `RECOVERED.json` separately.

If readiness completed but an exposure precondition refused, an explicit
continuation can perform **only** exposure:

```bash
python3 /pinned/source/scripts/hosted-deploy/legacy_recovery_action.py \
  expose-legacy < /protected/current-window-recovery-request.json
```

It requires the original known app-start/ready receipts and exact boot. It
cannot start the app again. A prior exposure intent refuses a second exposure.
Lost stop/start acknowledgements never become success from later inspect or
GET responses. If exposure fails after starting its owned proxy, recovery
attempts one independently ownership-verified non-forcing stop; an unknown or
failed compensation requires independent fencing and reconciliation.

Receipts are private under `.legacy-recovery/window-<token>/recover-<operation>`.
Keep them and every original. `RECOVERED` means legacy service recovered and
forward aborted; it does not authorize another deployment. Qualified control
reconciliation is a separate prerequisite before the next window.

The Python fixtures use inert Docker records and private disposable files,
including forced Caddy failure and recovery, unknown acknowledgements,
exposure-only continuation, canonical mounts, isolated canary, duplicate DNS,
and failed public/config acceptance. They do not establish native Docker,
historical-image, off-host backup or live deployment qualification.
