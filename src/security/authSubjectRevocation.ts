import { createHash } from 'node:crypto';

export type AuthSubjectRevocationReason = 'identity_unlinked' | 'account_deleted';

/** PII-free stable key used by durable identity revocation fences. */
export function hashAuthSubject(sub: string): string {
  return createHash('sha256').update(sub, 'utf8').digest('hex');
}
