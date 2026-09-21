import type { DrizzleTx } from '../../database/db-utils.js';
import type { OnboardingSessionRecord } from './OnboardingRecords.js';

/**
 * Mandatory live restricted-session authority for activation. The caller owns
 * the transaction and acquires any broader auth-resource preflight first.
 * Hashes must be derived server-side from the two HttpOnly cookies. Implementors
 * snapshot them before awaiting and hold users -> claim -> owner -> session
 * locks through the caller's commit, rejecting stale/revoked/expired context.
 */
export interface OnboardingSessionAuthority {
  lockSessionWithTx(tx: DrizzleTx, ownerHash: Buffer, sessionHash: Buffer): Promise<OnboardingSessionRecord | null>;
}
