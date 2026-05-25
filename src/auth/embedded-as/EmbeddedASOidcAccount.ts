import type { IAuthMethod } from './IAuthMethod.js';
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
        async claims() {
          return {
            sub: identity.sub,
            name: identity.displayName,
            email: identity.email,
            email_verified: identity.emailVerified,
          };
        },
      };
    }
    return undefined;
  }
}
