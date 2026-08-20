import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  accountAllowlistEntries,
  approvalAuditEvents,
  authAllowlist,
  authIdentityEvents,
  authKv,
  consoleLoginTransactions,
  consoleSessions,
  elements,
  integrationProviderDescriptors,
  portfolioSyncJobs,
  runtimeSessionPresence,
  securityInvalidationEvents,
  sessionActivationEvents,
  sessionActivityEvents,
  sessions,
  userIntegrations,
  userOauthTokens,
  userSettings,
} from './schema/index.js';
import type { DrizzleTx } from './db-utils.js';
import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';
import type { AuthAllowlistKind } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import { normalizeAllowlistValue } from '../web-console/stores/IConsoleAccountAllowlistStore.js';
import {
  lockAuthAllowlistIdentitiesWithTx,
  lockAuthPrincipalsWithTx,
} from './authPrincipalLock.js';

/**
 * The complete set of user-owned tables that `ON DELETE CASCADE` off `users.id`, expressed
 * as the top-level deletes that also sweep their own cascade children. A hard `DELETE FROM
 * users` removes all of this through the DB cascade; when the `users` row is retained
 * (anonymize-tombstone) the cascade never fires, so this function replays it explicitly.
 *
 * This list must stay in lockstep with the schema — the drift-guard test in
 * `userDataPurge.drift.test.ts` fails if any table that cascades off `users.id` is neither
 * purged here nor removed transitively (see {@link USER_SCOPED_CASCADE_VIA_PARENT}).
 */
export async function purgeUserScopedData(tx: DrizzleTx, userId: string): Promise<void> {
  // portfolio_sync_jobs RESTRICT-references user_integrations, so it must precede it.
  await tx.delete(sessionActivityEvents).where(eq(sessionActivityEvents.userId, userId));
  await tx.delete(portfolioSyncJobs).where(eq(portfolioSyncJobs.userId, userId));
  await tx.delete(userIntegrations).where(eq(userIntegrations.userId, userId));
  await tx.delete(userOauthTokens).where(eq(userOauthTokens.userId, userId));
  await tx.delete(integrationProviderDescriptors).where(eq(integrationProviderDescriptors.ownerUserId, userId));
  await tx.delete(securityInvalidationEvents).where(eq(securityInvalidationEvents.userId, userId));
  await tx.delete(runtimeSessionPresence).where(eq(runtimeSessionPresence.userId, userId));
  await tx.delete(sessionActivationEvents).where(eq(sessionActivationEvents.userId, userId));
  // approval_audit_events is the user's OWN gatekeeper approval decisions (cascade-off-users), not
  // the retained tamper-evident admin_audit chain — so it is erased with the account.
  await tx.delete(approvalAuditEvents).where(eq(approvalAuditEvents.userId, userId));
  await tx.delete(consoleLoginTransactions).where(eq(consoleLoginTransactions.userId, userId));
  await tx.delete(consoleSessions).where(eq(consoleSessions.userId, userId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await tx.delete(userSettings).where(eq(userSettings.userId, userId));
  // elements last: cascades element_tags, element_relationships, memory_entries,
  // agent_states, ensemble_members, and element_provenance via elements.id.
  await tx.delete(elements).where(eq(elements.userId, userId));
}

/** Physical table names purged directly by {@link purgeUserScopedData}. */
export const USER_SCOPED_CASCADE_PURGE_TABLES: readonly string[] = [
  'session_activity_events',
  'portfolio_sync_jobs',
  'user_integrations',
  'user_oauth_tokens',
  'integration_provider_descriptors',
  'security_invalidation_events',
  'runtime_session_presence',
  'session_activation_events',
  'approval_audit_events',
  'console_login_transactions',
  'console_sessions',
  'sessions',
  'user_settings',
  'elements',
];

/**
 * Tables that also cascade off `users.id` but are removed transitively when a table in
 * {@link USER_SCOPED_CASCADE_PURGE_TABLES} above them is deleted (children of `elements`,
 * `runtime_session_presence`, etc.), so they need no explicit delete.
 */
export const USER_SCOPED_CASCADE_VIA_PARENT: readonly string[] = [
  'element_tags',
  'element_relationships',
  'memory_entries',
  'agent_states',
  'ensemble_members',
  'element_provenance',
  'session_activation_records',
  'security_invalidation_acks',
  'account_factor_backup_codes',
];

/**
 * Cascade-off-`users` tables purged in the pre-savepoint detach of `deleteConsolePrincipalWithTx`
 * (on both the hard-delete and anonymize paths, so the login stops working immediately) rather
 * than in {@link purgeUserScopedData}.
 */
export const USER_SCOPED_CASCADE_PURGED_ON_DETACH: readonly string[] = [
  'account_factors',
  'user_admin_roles',
];

/** One federated login of the account being deleted. */
export interface DeletionIdentityAccount {
  readonly sub: string;
  readonly provider: string;
  readonly externalSub: string;
  readonly email: string | null;
  readonly rawProfile: unknown;
}

/** The identity values needed to purge the non-FK identity/credential tables. */
export interface DeletionIdentity {
  readonly subs: readonly string[];
  readonly emails: readonly string[];
  readonly githubIds: readonly string[];
  readonly githubLogins: readonly string[];
  readonly accountAllowlistIdentities: readonly DeletionAccountAllowlistIdentity[];
}

interface DeletionAccountAllowlistIdentity {
  readonly kind: AuthAllowlistKind;
  readonly normalizedValue: string;
}

function githubLogin(account: DeletionIdentityAccount): string | null {
  if (account.provider !== 'github' || !account.rawProfile || typeof account.rawProfile !== 'object') {
    return null;
  }
  const rawProfile = account.rawProfile as {
    readonly login?: unknown;
    readonly user?: { readonly login?: unknown };
  };
  // Current GitHub profiles persist the explicitly projected upstream user
  // under rawProfile.user. Retain the legacy top-level fallback for accounts
  // written before that projection was introduced.
  const login = rawProfile.user?.login ?? rawProfile.login;
  if (typeof login !== 'string') return null;
  return login;
}

function addDeletionAllowlistValues(
  values: Set<string>,
  kind: AuthAllowlistKind,
  value: string,
): void {
  const normalized = normalizeAuthAllowlistValue(kind, value);
  if (!normalized) return;
  values.add(normalized);
  // Before NFC canonicalization, durable allowlists stored lowercased input verbatim.
  // Retain that spelling so account deletion also removes legacy NFD/whitespace rows.
  values.add(value.toLowerCase());
}

function addAccountDeletionAllowlistValue(
  values: Map<string, DeletionAccountAllowlistIdentity>,
  kind: AuthAllowlistKind,
  value: string,
): void {
  const normalizedValue = normalizeAllowlistValue(kind, value);
  if (!normalizedValue || normalizedValue.length > 320) return;
  values.set(`${kind}:${normalizedValue}`, { kind, normalizedValue });
}

/** Collect the identity match values from the account's own row + its federated logins. */
export function collectDeletionIdentity(
  userEmail: string | null,
  accounts: readonly DeletionIdentityAccount[],
): DeletionIdentity {
  const emails = new Set<string>();
  const accountAllowlistIdentities = new Map<string, DeletionAccountAllowlistIdentity>();
  if (userEmail) {
    addDeletionAllowlistValues(emails, 'email', userEmail);
    addAccountDeletionAllowlistValue(accountAllowlistIdentities, 'email', userEmail);
  }
  const subs = new Set<string>();
  const githubIds = new Set<string>();
  const githubLogins = new Set<string>();
  for (const account of accounts) {
    subs.add(account.sub);
    if (account.email) {
      addDeletionAllowlistValues(emails, 'email', account.email);
      addAccountDeletionAllowlistValue(accountAllowlistIdentities, 'email', account.email);
    }
    if (account.provider === 'github' && account.externalSub) {
      addDeletionAllowlistValues(githubIds, 'github_id', account.externalSub);
      addAccountDeletionAllowlistValue(accountAllowlistIdentities, 'github_id', account.externalSub);
    }
    const login = githubLogin(account);
    if (login) {
      addDeletionAllowlistValues(githubLogins, 'github_username', login);
      addAccountDeletionAllowlistValue(accountAllowlistIdentities, 'github_username', login);
    }
  }
  return {
    subs: [...subs],
    emails: [...emails],
    githubIds: [...githubIds],
    githubLogins: [...githubLogins],
    accountAllowlistIdentities: [...accountAllowlistIdentities.values()],
  };
}

/**
 * Purge the account's personal data from tables that have NO foreign key to `users` and are
 * therefore reached by neither the hard-delete cascade nor {@link purgeUserScopedData}. Called
 * on BOTH deletion paths. `auth_kv` holds the OIDC grants/tokens (email/profile in the payload,
 * keyed by the subject as `accountId`); `auth_identity_events` is the account's own auth-event
 * log; `auth_allowlist` is the legacy pre-approval entry (a direct identifier + re-onboarding
 * vector). Matching active `account_allowlist_entries` are revoked, not deleted, so the current
 * sign-in authority cannot recreate the account while its administrative history remains intact.
 * `security_audit_events` is intentionally NOT purged here — it is the operator security-audit
 * sink and is retained (see docs).
 */
export async function purgeNonCascadeUserIdentity(
  tx: DrizzleTx,
  identity: DeletionIdentity,
  revokedByUserId: string,
  revokedAt: Date,
): Promise<void> {
  await lockAuthPrincipalsWithTx(tx, identity.subs);
  const tombstones = identity.accountAllowlistIdentities;
  await lockAuthAllowlistIdentitiesWithTx(tx, tombstones);
  for (const sub of identity.subs) {
    // The bootstrap claim is an authorization grant keyed outside the user
    // tables. Clear it atomically with principal deletion so the deleted
    // bootstrap identity cannot pass the allowlist gate and recreate itself.
    await tx.delete(authKv).where(and(
      eq(authKv.model, 'AuthBootstrap'),
      eq(authKv.id, 'state'),
      sql`${authKv.payload}->>'adminSub' = ${sub}`,
    ));
  }
  for (const sub of identity.subs) {
    // OIDC storage: a Grant carries the subject as payload.accountId, while tokens/sessions/codes
    // are linked to it via payload.grantId (this mirrors the adapter's own revokeByGrantId). Purge
    // both, so no token or session survives even if it does not itself carry accountId. Pre-auth
    // Interaction rows have no account linkage and self-expire. Looped: an account has one or two
    // subjects, each with a handful of grants.
    const grants = await tx.select({ id: authKv.id }).from(authKv)
      .where(and(eq(authKv.model, 'Grant'), sql`${authKv.payload}->>'accountId' = ${sub}`));
    for (const grant of grants) {
      await tx.delete(authKv).where(sql`${authKv.payload}->>'grantId' = ${grant.id}`);
    }
    await tx.delete(authKv).where(sql`${authKv.payload}->>'accountId' = ${sub}`);
  }
  if (identity.subs.length > 0) {
    await tx.delete(authIdentityEvents).where(inArray(authIdentityEvents.sub, [...identity.subs]));
  }
  const allowlistMatches = [
    identity.emails.length > 0
      ? and(eq(authAllowlist.kind, 'email'), inArray(authAllowlist.value, [...identity.emails]))
      : undefined,
    identity.githubIds.length > 0
      ? and(eq(authAllowlist.kind, 'github_id'), inArray(authAllowlist.value, [...identity.githubIds]))
      : undefined,
    identity.githubLogins.length > 0
      ? and(eq(authAllowlist.kind, 'github_username'), inArray(authAllowlist.value, [...identity.githubLogins]))
      : undefined,
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== undefined);
  if (allowlistMatches.length > 0) {
    await tx.delete(authAllowlist).where(or(...allowlistMatches));
  }

  const accountAllowlistMatches = tombstones.map(entry => and(
    eq(accountAllowlistEntries.kind, entry.kind),
    eq(accountAllowlistEntries.normalizedValue, entry.normalizedValue),
  ));
  if (accountAllowlistMatches.length > 0) {
    await tx.update(accountAllowlistEntries).set({
      revokedByUserId,
      revokedAt,
      authorityOrder: sql`nextval('account_allowlist_authority_order_seq')`,
    }).where(and(
      isNull(accountAllowlistEntries.revokedAt),
      or(...accountAllowlistMatches),
    ));

    // Always append a fresh revoked row. Historical revoked rows are
    // intentionally non-unique. The shared identity lock above makes this
    // tombstone and a concurrent explicit re-add commit in authority order.
    if (tombstones.length > 0) {
      await tx.insert(accountAllowlistEntries).values(tombstones.map(entry => ({
        kind: entry.kind,
        normalizedValue: entry.normalizedValue,
        displayValue: entry.normalizedValue,
        note: 'Deny tombstone created by account deletion',
        createdByUserId: revokedByUserId,
        createdAt: revokedAt,
        revokedByUserId,
        revokedAt,
      })));
    }
  }
}
