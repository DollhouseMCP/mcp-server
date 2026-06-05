import type { IAuthStorageLayer } from '../../../auth/embedded-as/storage/IAuthStorageLayer.js';
import { assertUuid, ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';

export interface ConsoleOAuthSubjectResolver {
  listLinkedSubjects(userId: string): Promise<readonly string[]>;
}

export interface ConsoleOAuthGrantRevocationInput {
  readonly userId: string;
  readonly revokedAt: Date;
}

export interface ConsoleOAuthSubjectRevocationSummary {
  readonly sub: string;
  readonly grantsDiscovered: number;
  readonly grantsRevoked: number;
}

export interface ConsoleOAuthGrantRevocationSummary {
  readonly userId: string;
  readonly revokedAt: Date;
  readonly linkedSubjectsProcessed: number;
  readonly oauthGrantFamiliesDiscovered: number;
  readonly oauthGrantFamiliesRevoked: number;
  readonly subjects: readonly ConsoleOAuthSubjectRevocationSummary[];
}

export interface IOAuthGrantRevocationService {
  /**
   * Revokes AS OAuth grant families for every linked subject of a canonical
   * principal. This is only the OAuth credential piece of account security
   * mutations: disable/revoke-all callers must also block new grants before
   * calling this service, revoke browser console sessions/elevations, emit
   * security invalidation, and terminate active runtime transports through
   * the runtime-control boundary.
   *
   * Failure contract: throws on the first storage failure. Any grant families
   * revoked before that failure remain revoked in AS storage, but no partial
   * summary is returned. Callers that need per-grant failure capture must wrap
   * this service and audit their own partial outcome.
   *
   * `revokedAt` is provenance only; it is not a scheduling primitive.
   */
  revokePrincipalGrants(input: ConsoleOAuthGrantRevocationInput): Promise<ConsoleOAuthGrantRevocationSummary>;
}

export interface OAuthRevocationCapableAuthStorage extends IAuthStorageLayer {
  genericRevokeByGrantId(grantId: string): Promise<void>;
}

export class ConsoleOAuthGrantRevocationDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleOAuthGrantRevocationDependencyError';
  }
}

export function validateOAuthGrantRevocationInput(input: ConsoleOAuthGrantRevocationInput): void {
  assertUuid(input.userId, 'userId');
  if (Number.isNaN(input.revokedAt.getTime())) {
    throw new ConsoleStoreValidationError('revokedAt must be a valid date');
  }
}

export function requireOAuthRevocationCapableStorage(
  authStorage: IAuthStorageLayer,
): OAuthRevocationCapableAuthStorage {
  if (!authStorage.genericRevokeByGrantId) {
    throw new ConsoleOAuthGrantRevocationDependencyError(
      'OAuth grant revocation requires auth storage to support grant-family revocation',
    );
  }
  return authStorage as OAuthRevocationCapableAuthStorage;
}
