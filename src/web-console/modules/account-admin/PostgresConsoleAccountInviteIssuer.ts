import {
  InviteTokenStore,
  loadOrGenerateInviteSecretViaStore,
} from '../../../auth/embedded-as/inviteTokens.js';
import { normalizeAuthAllowlistValue } from '../../../auth/embedded-as/allowlistIdentity.js';
import { lockAuthMutationResourcesWithTx } from '../../../database/authMutationPreflight.js';
import { getErrorCode } from '../../../database/db-utils.js';
import { withSystemContext } from '../../../database/admin.js';
import type { DatabaseInstance } from '../../../database/connection.js';
import { authAccounts, users } from '../../../database/schema/index.js';
import type { ISigningKeyStore } from '../../../storage/signingKeys/ISigningKeyStore.js';
import { normalizeLocalUsername } from '../../ui/account-username.js';
import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { grantConsoleAdminRoleWithTx } from '../../stores/PostgresConsoleAccountAdminStore.js';
import { ConsoleStoreConflictError, isUniqueViolation } from '../../stores/ConsoleStoreValidation.js';
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
    return this.createPrincipalAndAuthAccount({
      username,
      displayName: input.displayName,
      email: input.email,
      primarySub,
      actorUserId: input.actorUserId,
      roles: input.roles,
      issuedAt: input.issuedAt,
      ttlMinutes: input.ttlMinutes,
    }, tokenStore);
  }

  private async createInviteTokenStore(): Promise<InviteTokenStore> {
    return new InviteTokenStore(
      await loadOrGenerateInviteSecretViaStore(this.options.signingKeyStore),
    );
  }

  private async createPrincipalAndAuthAccount(input: {
    readonly username: string;
    readonly displayName: string;
    readonly email: string;
    readonly primarySub: string;
    readonly actorUserId: string;
    readonly roles: readonly ConsoleAdminRole[];
    readonly issuedAt: Date;
    readonly ttlMinutes: number;
  }, tokenStore: InviteTokenStore): Promise<ConsoleAccountInviteIssueResult> {
    try {
      return await withSystemContext(this.options.db, async tx => {
      // Match durable issuance's users-first conflict protocol. Downstream
      // resources use NOWAIT so an auth/role writer awaiting a users FK cannot
      // form a blocking cycle with this transaction.
      await lockAuthMutationResourcesWithTx(tx);
      const emailNormalized = normalizeAuthAllowlistValue('email', input.email);
      const accounts = await tx.select({ username: users.username, email: users.email }).from(users);
      if (accounts.some(account =>
        normalizeAuthAllowlistValue('github_username', account.username).normalize('NFC') === input.username ||
        (account.email !== null && normalizeAuthAllowlistValue('email', account.email) === emailNormalized))) {
        throw new ConsoleStoreConflictError('An account with this username or email already exists.');
      }
      const insertedUsers = await tx.insert(users).values({
        username: input.username,
        email: input.email,
        displayName: input.displayName,
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
        displayName: input.displayName,
        rawProfile: null,
        passwordHash: null,
        lastAuthAt: null,
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

      // Mint only after lock waits and writes, immediately before commit. The
      // requested lifetime must not elapse while issuance waits for users.
      const token = tokenStore.issue({ sub: input.primarySub, email: input.email,
        purpose: 'invite', ttlMs: input.ttlMinutes * 60 * 1000 });
      const verified = tokenStore.verify(token);
      if (!verified.ok) throw new Error('issued invite token could not be verified');
      return { userId, primarySub: input.primarySub, expiresAt: new Date(verified.payload.exp),
        inviteUrl: buildInviteUrl(this.options.publicBaseUrl, token) };
      });
    } catch (error) {
      if (getErrorCode(error) === '55P03') {
        throw new ConsoleStoreConflictError('Account creation conflicted with another operation. Please retry.');
      }
      // Duplicate username/sub -> a client conflict, not a server outage.
      if (isUniqueViolation(error)) {
        throw new ConsoleStoreConflictError('An account with this username or email already exists.');
      }
      throw error;
    }
  }
}

function buildInviteUrl(publicBaseUrl: string, token: string): string {
  const url = new URL(LOCAL_INVITE_PATH, publicBaseUrl);
  url.searchParams.set('invite', token);
  return url.toString();
}
