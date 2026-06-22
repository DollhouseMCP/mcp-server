import type { LinkedIdentity } from '../../stores/IConsoleAccountAdminStore.js';

/**
 * A provider login (auth account) as exposed on the account-admin surface.
 * Allowlist of non-credential fields only — password hashes and raw upstream
 * profile never live on `LinkedIdentity`, so they cannot leak here.
 */
export interface AccountIdentityDto {
  readonly sub: string;
  readonly provider: string;
  readonly external_sub: string;
  readonly email: string | null;
  readonly email_verified: boolean;
  readonly display_name: string | null;
  readonly linked_user_id: string | null;
  readonly created_at: string;
  readonly last_auth_at: string | null;
}

export interface AccountIdentityListDto {
  readonly user_id: string;
  readonly identities: readonly AccountIdentityDto[];
}

export interface AccountIdentityMutationDto {
  readonly user_id: string;
  readonly sub: string;
  /** True after a link, false after an unlink. */
  readonly linked: boolean;
}

export function serializeAccountIdentity(identity: LinkedIdentity): AccountIdentityDto {
  return {
    sub: identity.sub,
    provider: identity.provider,
    external_sub: identity.externalSub,
    email: identity.email,
    email_verified: identity.emailVerified,
    display_name: identity.displayName,
    linked_user_id: identity.linkedUserId,
    created_at: identity.createdAt.toISOString(),
    last_auth_at: identity.lastAuthAt ? identity.lastAuthAt.toISOString() : null,
  };
}

export function serializeAccountIdentityList(
  userId: string,
  identities: readonly LinkedIdentity[],
): AccountIdentityListDto {
  return {
    user_id: userId,
    identities: identities.map(serializeAccountIdentity),
  };
}

export function serializeAccountIdentityMutation(
  userId: string,
  sub: string,
  linked: boolean,
): AccountIdentityMutationDto {
  return { user_id: userId, sub, linked };
}
