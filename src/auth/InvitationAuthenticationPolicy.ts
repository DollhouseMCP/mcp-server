import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { getErrorCode, type DrizzleTx } from '../database/db-utils.js';

type IdentityValue = string | SQLWrapper | null;
interface PolicyIdentity { readonly provider: IdentityValue; readonly sub: IdentityValue; readonly externalSub: IdentityValue }

/** Invitation rows are retained for the lifetime of their canonical user.
 * Correlated user expressions must keep explicit SQL qualification: Drizzle
 * unqualifies column objects within single-table SELECT projections. */
export function invitationIdentityAllowedSql(userId: SQLWrapper, identity: PolicyIdentity): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM account_invitations invitation_policy WHERE invitation_policy.user_id = ${userId})
    OR (${identity.provider}::text = 'github' AND ${identity.externalSub}::text ~ '^[1-9][0-9]*$'
      AND ${identity.sub}::text = 'github_' || ${identity.externalSub}::text))`;
}

/** A pre-linked subject wins; the legacy username fallback never matches email. */
export function canonicalSubjectUserSql(sub: string): SQL {
  return sql`COALESCE((SELECT user_id FROM auth_accounts WHERE sub = ${sub}),
    (SELECT id FROM users WHERE username = ${sub}))`;
}

/** Called inside the authoritative credential-write transaction; errors propagate. */
export async function assertInvitationIdentityWriteAllowed(tx: DrizzleTx, identity: {
  readonly provider: string; readonly sub: string; readonly externalSub: string;
}): Promise<void> {
  // Issuance holds users EXCLUSIVE before creating the cohort marker. Never
  // wait here: a caller may already own principal/allowlist locks.
  try { await tx.execute(sql`LOCK TABLE users IN ROW SHARE MODE NOWAIT`); }
  catch (error) {
    if (getErrorCode(error) !== '55P03') throw error;
    throw Object.assign(new Error('Authentication method is temporarily unavailable'), { code: '55P03' });
  }
  const [row] = await tx.execute(sql`SELECT ${invitationIdentityAllowedSql(canonicalSubjectUserSql(identity.sub), identity)} AS allowed`);
  if (row.allowed !== true) throw new Error('Authentication method is not available for this account');
}
