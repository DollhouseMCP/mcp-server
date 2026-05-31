import {
  InviteTokenStore,
  loadOrGenerateInviteSecretViaStore,
} from '../../../auth/embedded-as/inviteTokens.js';
import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { authAccounts, users } from '../../../database/schema/index.js';
import type { ISigningKeyStore } from '../../../storage/signingKeys/ISigningKeyStore.js';
import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { grantConsoleAdminRoleWithTx } from '../../stores/PostgresConsoleAccountAdminStore.js';
import type {
  ConsoleAccountInviteIssueInput,
  ConsoleAccountInviteIssueResult,
  IConsoleAccountInviteIssuer,
} from './AccountAdminInviteService.js';

const LOCAL_PROVIDER = 'local';
const LOCAL_AUTH_METHOD_SUB_PREFIX = 'local_';
const LOCAL_INVITE_PATH = '/auth/local/invite';

export interface PostgresConsoleAccountInviteIssuerOptions {
  readonly db: DatabaseInstance;
  readonly signingKeyStore: ISigningKeyStore;
  readonly publicBaseUrl: string;
}

export class PostgresConsoleAccountInviteIssuer implements IConsoleAccountInviteIssuer {
  constructor(private readonly options: PostgresConsoleAccountInviteIssuerOptions) {}

  async issueInvite(input: ConsoleAccountInviteIssueInput): Promise<ConsoleAccountInviteIssueResult> {
    const username = normalizeLocalUsername(input.username);
    const primarySub = `${LOCAL_AUTH_METHOD_SUB_PREFIX}${username}`;
    const tokenStore = await this.createInviteTokenStore();
    const token = tokenStore.issue({
      sub: primarySub,
      email: input.email,
      purpose: 'invite',
      ttlMs: input.ttlMinutes * 60 * 1000,
    });
    const verified = tokenStore.verify(token);
    if (!verified.ok) throw new Error('issued invite token could not be verified');
    const expiresAt = new Date(verified.payload.exp);

    const userId = await this.createPrincipalAndAuthAccount({
      username,
      email: input.email,
      primarySub,
      actorUserId: input.actorUserId,
      roles: input.roles,
      issuedAt: input.issuedAt,
    });

    return {
      inviteUrl: buildInviteUrl(this.options.publicBaseUrl, token),
      expiresAt,
      userId,
      primarySub,
    };
  }

  private async createInviteTokenStore(): Promise<InviteTokenStore> {
    return new InviteTokenStore(
      await loadOrGenerateInviteSecretViaStore(this.options.signingKeyStore),
    );
  }

  private async createPrincipalAndAuthAccount(input: {
    readonly username: string;
    readonly email: string;
    readonly primarySub: string;
    readonly actorUserId: string;
    readonly roles: readonly ConsoleAdminRole[];
    readonly issuedAt: Date;
  }): Promise<string> {
    return withSystemContext(this.options.db, async tx => {
      const insertedUsers = await tx.insert(users).values({
        username: input.username,
        email: input.email,
        displayName: input.email,
        createdAt: input.issuedAt,
        updatedAt: input.issuedAt,
      }).returning({ id: users.id });
      const userId = insertedUsers.at(0)?.id;
      if (!userId) throw new Error('failed to create invited principal');

      await tx.insert(authAccounts).values({
        provider: LOCAL_PROVIDER,
        externalSub: input.username,
        sub: input.primarySub,
        userId,
        email: input.email,
        emailVerified: false,
        displayName: input.email,
        rawProfile: null,
        passwordHash: null,
        lastAuthAt: null,
        roles: [],
        createdAt: input.issuedAt,
        updatedAt: input.issuedAt,
      });

      for (const role of input.roles) {
        await grantConsoleAdminRoleWithTx(tx, {
          userId,
          role,
          grantedByUserId: input.actorUserId,
          grantedAt: input.issuedAt,
        });
      }

      return userId;
    });
  }
}

function buildInviteUrl(publicBaseUrl: string, token: string): string {
  const url = new URL(LOCAL_INVITE_PATH, publicBaseUrl);
  url.searchParams.set('invite', token);
  return url.toString();
}

function normalizeLocalUsername(username: string): string {
  return username.toLowerCase();
}
