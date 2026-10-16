# OAuth helper generation ownership

The detached `oauth-helper.mjs` requires a nonempty
`DOLLHOUSE_OAUTH_HELPER_FLOW_ID` and matching prepared
`oauth-helper-state.json` in its selected auth directory. An environment variable
alone does not prepare a generation. Unscoped standalone invocation now exits
before installing cleanup handlers, writing shared files or polling GitHub.
This intentionally removes the legacy unscoped helper behavior.

Use the existing server `setup_github_auth` controller path. It generates a UUID,
prepares the matching flow under the OAuth state coordinator lock, then spawns
the helper with the same auth directory and flow identity. Standalone/operator
integrations must participate in that existing coordinated preparation and
handoff/import lifecycle; simply launching the script against a shared directory
is unsupported. No additional UUID syntax restriction is imposed by this
ownership guard. The encrypted handoff retains its existing validation rules.

After the existing startup/PRE_READY work, PID publication reacquires the same
state-generation lock. Exact current flow and state PID authorize an atomic,
mode0600 whole PID replacement, including a previous generation's stale or
partial PID file. The PID file is advisory; it cannot authorize publication.
Superseded or unknown state and lock/publication uncertainty refuse polling.

Terminal cleanup is attempted once, including failed lock admission. Under the
same lock it snapshots both current state and PID contents, requires exact flow,
state PID and canonical own PID text (or an absent PID), then removes PID before
failed state. A mismatching PID or unknown state is retained. PID removal failure
retains state; state removal failure leaves a truthful partial cleanup. Successful
result/state/encrypted handoff remain for parent import, even if cleanup fails.
Claim failure has a separate flow-checked, absent-state-PID cleanup and cannot
remove another helper's PID through an exit fallback. Exit hooks do not retry a
failed or already committed cleanup.

Operation and lock admission/release outcomes are recorded separately, including
falsy errors. A committed mutation followed by release failure is not successful
publication and does not start polling or roll back another generation. Existing
best-effort terminal result and exit semantics remain; successful authentication
is not rewritten as failure solely because PID cleanup failed.

Normal success/failure now uses at most four fresh existing lock admission
budgets: claim, PID publication, terminal result and cleanup. Each retains its
existing five-second admission budget. This increases potential lock work; it is
not a hard twenty-second return bound or a promise to fit a fifteen-second test.
Signal cleanup may synchronously consume one such budget. Test deadlines remain
binding.

These are logical ownership rules for participating distinct generations, not
kernel PID-start identity or protection against malicious filesystem writers.
Duplicate actors using the same flow and adjacent parent import cleanup are not
claimed solved. This change does not establish any historical CI timeout cause,
credential leak, timing cure or release risk acceptance. Changing the helper is a
native image input change and requires new qualification binding.
