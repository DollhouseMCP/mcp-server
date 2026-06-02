import type { IAuthMethod } from './IAuthMethod.js';
import { ADMIN_STEP_UP_CLAIMS_MODEL, type AdminStepUpClaims } from './InteractionRouter.js';
import type { IAuthStorageLayer } from './storage/IAuthStorageLayer.js';

export class EmbeddedASOidcAccount {
  constructor(
    private readonly methods: readonly IAuthMethod[],
    private readonly storage: IAuthStorageLayer,
  ) {}

  async extraTokenClaims(_ctx: unknown, token: unknown): Promise<Record<string, unknown> | undefined> {
    const accountId = (token as { accountId?: string }).accountId;
    if (!accountId) return undefined;
    const account = await this.storage.getAccount(accountId);
    if (!account) return undefined;
    if (account.sub !== accountId) return undefined;
    const extras: Record<string, unknown> = {};
    if (account.lastAuthAt) {
      extras.auth_time = Math.floor(account.lastAuthAt / 1000);
    }
    const grantId = typeof (token as { grantId?: unknown }).grantId === 'string'
      ? (token as { grantId: string }).grantId
      : null;
    if (grantId) {
      // extraTokenClaims runs once PER TOKEN (access_token AND id_token) of a
      // single issuance, so the admin step-up claims must be injected into all
      // of them. Read (not consume) here: genericConsume returns true only on
      // the first call, which would leave the id_token (issued second) without
      // acr/amr and the BFF would reject the elevation. The claims record is
      // bounded by ADMIN_STEP_UP_TTL_SECONDS, so a non-consuming read is safe.
      const adminClaims = await this.storage.genericGet(ADMIN_STEP_UP_CLAIMS_MODEL, grantId);
      if (isAdminStepUpClaims(adminClaims, accountId)) {
        extras.acr = adminClaims.acr;
        extras.amr = adminClaims.amr;
        extras.auth_time = adminClaims.authTime;
      }
    }
    if (account.roles && account.roles.length > 0) {
      extras.roles = account.roles;
    }
    return Object.keys(extras).length > 0 ? extras : undefined;
  }

  async findAccount(_ctx: unknown, sub: string): Promise<{
    accountId: string;
    claims: () => Promise<{
      sub: string;
      name: string | undefined;
      email: string | undefined;
      email_verified: boolean | undefined;
    }>;
  } | undefined> {
    for (const method of this.methods) {
      const identity = await method.findAccount(sub);
      if (!identity) continue;
      return {
        accountId: identity.sub,
        claims() {
          // oidc-provider's Account.claims must return a Promise; there is
          // nothing to await, so return a resolved promise (avoids an async
          // method with no await).
          return Promise.resolve({
            sub: identity.sub,
            name: identity.displayName,
            email: identity.email,
            email_verified: identity.emailVerified,
          });
        },
      };
    }
    return undefined;
  }
}

function isAdminStepUpClaims(raw: unknown, accountId: string): raw is AdminStepUpClaims {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return value.accountId === accountId
    && value.acr === 'urn:dollhouse:acr:admin-stepup'
    && Array.isArray(value.amr)
    && value.amr.every((entry) => typeof entry === 'string')
    && typeof value.authTime === 'number';
}
