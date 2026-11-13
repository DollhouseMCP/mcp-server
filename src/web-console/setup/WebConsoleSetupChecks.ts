/*
 * Setup check catalog.
 *
 * One definition per check a hosted console deployment is measured against:
 * what a pass proves, how the system knows, and what to do when it has not
 * passed. The status view and the docs both read these definitions, so the
 * meaning of a check is written down in exactly one place.
 *
 * Nothing here gates anything. A check is information for the operator; the
 * hard start-up gate is assertWebConsoleProductionActivation.
 *
 * A definition says how its check is verified by the probe or record reader
 * that reports on it. The catalog does not run anything itself: a check that
 * nothing reports on yet is listed as pending, whatever its definition says.
 */

export const WEB_CONSOLE_SETUP_CHECK_IDS = [
  'production_database_migrations',
  'security_invalidation_multi_replica',
  'allowlist_authority_parity',
  'embedded_as_login_step_up',
  'account_invite_redemption',
  'oauth_grant_revocation',
  'github_integration_connect_callback',
  'portfolio_sync_live_repository',
  'signing_key_auth_policy_multi_replica',
  'approval_execution_projection',
  'audit_telemetry_projection',
] as const;

export type WebConsoleSetupCheckId = typeof WEB_CONSOLE_SETUP_CHECK_IDS[number];

/**
 * How the system knows the state of a check.
 * - `server-probe`: the server tests it itself, read-only, whenever asked.
 * - `server-canary`: the server tests it with records it makes for its own
 *   reserved canary user and then removes. It runs only when an admin asks or
 *   on a schedule, and stays pending until it has run.
 * - `usage-record`: read from the records real use leaves behind. It stays
 *   pending until someone has actually done the thing.
 * - `not-verified`: the server cannot verify it yet.
 */
export type WebConsoleSetupCheckVerification = 'server-probe' | 'server-canary' | 'usage-record' | 'not-verified';

export interface WebConsoleSetupCheckDefinition {
  readonly id: WebConsoleSetupCheckId;
  readonly title: string;
  /** What a pass proves, in plain language. */
  readonly proves: string;
  readonly verification: WebConsoleSetupCheckVerification;
  /** How the system knows. */
  readonly verifiedBy: string;
  /** What to do when it has not passed. */
  readonly remediation: string;
}

export const WEB_CONSOLE_SETUP_CHECKS: Readonly<Record<WebConsoleSetupCheckId, WebConsoleSetupCheckDefinition>> = {
  production_database_migrations: {
    id: 'production_database_migrations',
    title: 'Database schema is fully migrated',
    proves: 'Every migration in this release has been applied to the database, and the record of what was applied matches this release.',
    verification: 'server-probe',
    verifiedBy: 'The server checks that no migration in this release is newer than the applied-migration ledger, which is the rule the migration job itself uses, and takes the replica out of service if one is. It also compares the ledger with this release entry for entry by content hash, and reports a difference without stopping the server. Later migrations from a newer release are allowed.',
    remediation: 'If migrations are missing, run the database migration job for this release, then reload the status view. If the ledger does not match, a migration file changed after it was applied: compare the schema with this release before relying on it.',
  },
  security_invalidation_multi_replica: {
    id: 'security_invalidation_multi_replica',
    title: 'Security changes reach every replica',
    proves: 'Revoking a session, disabling an account or changing a role takes effect on every running copy of the server.',
    verification: 'server-probe',
    verifiedBy: 'Each replica holds a lease and works through the shared invalidation queue. The server reports whether this replica holds its lease and has nothing waiting.',
    remediation: 'Check that every replica is running, reaches the same database and has a distinct replica ID.',
  },
  allowlist_authority_parity: {
    id: 'allowlist_authority_parity',
    title: 'Sign-in allowlist sources agree',
    proves: 'Every entry in the earlier sign-in allowlist is present in the allowlist the console manages, so nobody loses access by accident.',
    verification: 'server-probe',
    verifiedBy: 'The server compares the two allowlists with the rule it enforces at start-up, where a gap stops it from starting.',
    remediation: 'Run `dollhouse-allowlist reconcile` to list them, then `--carry` to add them to the allowlist sign-in uses or `--discard` to drop them.',
  },
  embedded_as_login_step_up: {
    id: 'embedded_as_login_step_up',
    title: 'Admin sign-in and step-up work',
    proves: 'An administrator can sign in to the console, enrol an authenticator app and elevate to admin with a one-time code.',
    verification: 'usage-record',
    verifiedBy: 'Shown once an administrator has completed a step-up, from the sign-in audit trail.',
    remediation: 'Sign in as the administrator, set up an authenticator app under Security, then elevate.',
  },
  account_invite_redemption: {
    id: 'account_invite_redemption',
    title: 'An invite can be redeemed',
    proves: 'An invitation sent from the console can be turned into a working account by the person invited.',
    verification: 'usage-record',
    verifiedBy: 'Shown once an invited person has accepted an invitation, from the invitation records.',
    remediation: 'Invite someone from Accounts and have them accept.',
  },
  oauth_grant_revocation: {
    id: 'oauth_grant_revocation',
    title: 'Revoking a client grant cuts its access',
    proves: 'An administrator has revoked an account\'s credentials, which removes its MCP client grants and refuses their tokens.',
    verification: 'usage-record',
    verifiedBy: 'Shown once an administrator has revoked an account\'s credentials, from the admin audit trail.',
    remediation: 'Nothing to fix. This stays pending until credentials are revoked for the first time.',
  },
  github_integration_connect_callback: {
    id: 'github_integration_connect_callback',
    title: 'GitHub can be connected to an account',
    proves: 'The GitHub connection flow completes and the connection is stored for the account.',
    verification: 'usage-record',
    verifiedBy: 'Shown once an account has a connected GitHub integration, from the integration records.',
    remediation: 'Connect GitHub under Integrations. If that fails, check the GitHub app client ID, secret and callback URL.',
  },
  portfolio_sync_live_repository: {
    id: 'portfolio_sync_live_repository',
    title: 'Portfolio sync works against a real repository',
    proves: 'A portfolio sync against a real GitHub repository finished successfully.',
    verification: 'usage-record',
    verifiedBy: 'Shown once a portfolio sync job has succeeded, from the sync job records.',
    remediation: 'Connect GitHub, then run a sync from Portfolio.',
  },
  signing_key_auth_policy_multi_replica: {
    id: 'signing_key_auth_policy_multi_replica',
    title: 'Every replica uses the same signing key and auth policy',
    proves: 'Tokens issued by one copy of the server are accepted by all the others, and all apply the same sign-in policy.',
    verification: 'not-verified',
    verifiedBy: 'The server does not compare replicas yet. Each replica refuses token requests while its own signing key is out of date, so the fault only shows when a sign-in reaches that replica.',
    remediation: 'After rotating the signing key, restart every replica so each reloads the current key.',
  },
  approval_execution_projection: {
    id: 'approval_execution_projection',
    title: 'Approvals and executions display correctly',
    proves: 'A pending approval and an agent execution, made the way a live session makes them, can be read through the console, which shows only the fields it is allowed to.',
    verification: 'server-canary',
    verifiedBy: 'The server opens a session for its reserved canary user, makes one approval request and one execution with the classes a live session uses, reads both back through the console\'s own handlers and privacy filters, and removes them. No other user\'s data is read. It runs when an admin asks in Operations, or on a schedule that is off unless configured. It does not go over the network, so it says nothing about the HTTP layer or about a real client connecting.',
    remediation: 'Run the check from Operations. If it fails, the result names what the console did not show; check the server log and confirm the database is fully migrated. If it says the canary user is not inert, that account has been changed and must be disabled again, with no role and no sign-in identity.',
  },
  audit_telemetry_projection: {
    id: 'audit_telemetry_projection',
    title: 'Audit events and telemetry display correctly',
    proves: 'Admin audit events are intact and readable, and session telemetry can be read.',
    verification: 'server-probe',
    verifiedBy: 'The server runs the audit and telemetry queries read-only and verifies the tamper-evident chain over the first admin audit events, as the audit page does.',
    remediation: 'Check the server log for the failing query or chain break. A chain break needs investigation before the audit trail is trusted.',
  },
};

/** Definitions in the canonical check order. */
export function listWebConsoleSetupChecks(): readonly WebConsoleSetupCheckDefinition[] {
  return WEB_CONSOLE_SETUP_CHECK_IDS.map(id => WEB_CONSOLE_SETUP_CHECKS[id]);
}

export function isWebConsoleSetupCheckId(value: unknown): value is WebConsoleSetupCheckId {
  return typeof value === 'string' && (WEB_CONSOLE_SETUP_CHECK_IDS as readonly string[]).includes(value);
}
