import { randomUUID } from 'node:crypto';

import {
  cloneUserIntegrationRecord,
  GITHUB_USER_INTEGRATION_PROVIDER,
  type IUserIntegrationStore,
  type UserIntegrationConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRefreshInput,
  type UserIntegrationRefreshResult,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';

export class InMemoryUserIntegrationStore implements IUserIntegrationStore {
  private readonly records = new Map<string, UserIntegrationRecord>();
  private readonly activeProviderIndex = new Map<string, string>();
  private readonly refreshLocks = new Map<string, Promise<void>>();

  constructor(records: readonly UserIntegrationRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  async listByUser(userId: string): Promise<readonly UserIntegrationRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.records.values()]
      .filter(record => record.userId === userId && record.revokedAt === null)
      .map(cloneUserIntegrationRecord);
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const recordId = this.activeProviderIndex.get(activeProviderKey(userId, provider));
    const record = recordId ? this.records.get(recordId) : null;
    return record ? cloneUserIntegrationRecord(record) : null;
  }

  async connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord> {
    await Promise.resolve();
    this.clearActive(input.userId, input.provider, input.connectedAt);
    const record: UserIntegrationRecord = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      externalAccountLabel: input.externalAccountLabel,
      externalInstallationId: input.externalInstallationId,
      authorizedPermissions: input.authorizedPermissions,
      accessTokenCiphertext: input.accessTokenCiphertext,
      refreshTokenCiphertext: input.refreshTokenCiphertext,
      credentialKeyVersion: input.credentialKeyVersion ?? null,
      status: 'connected',
      errorReason: null,
      connectedAt: input.connectedAt,
      lastSyncAt: null,
      revokedAt: null,
    };
    this.set(record);
    return cloneUserIntegrationRecord(record);
  }

  async refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    assertUuid(input.userId, 'userId');
    const key = activeProviderKey(input.userId, input.provider);
    const previous = this.refreshLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => { /* ignore prior holder rejection */ }).then(() => current);
    this.refreshLocks.set(key, tail);
    await previous.catch(() => { /* ignore prior holder rejection */ });
    try {
      return await this.refreshLocked(input);
    } finally {
      release();
      if (this.refreshLocks.get(key) === tail) this.refreshLocks.delete(key);
    }
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord> {
    await Promise.resolve();
    this.clearActive(input.userId, input.provider, input.occurredAt);
    const record: UserIntegrationRecord = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      externalAccountLabel: null,
      externalInstallationId: null,
      authorizedPermissions: defaultAuthorizedPermissions(input.provider),
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      credentialKeyVersion: null,
      status: 'error',
      errorReason: input.errorReason,
      connectedAt: null,
      lastSyncAt: null,
      revokedAt: null,
    };
    this.set(record);
    return cloneUserIntegrationRecord(record);
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    const active = await this.findByProvider(input.userId, input.provider);
    if (!active) return null;
    const disconnected: UserIntegrationRecord = {
      ...active,
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      status: 'revoked',
      errorReason: null,
      revokedAt: input.revokedAt,
    };
    this.records.set(disconnected.id, cloneUserIntegrationRecord(disconnected));
    this.activeProviderIndex.delete(activeProviderKey(input.userId, input.provider));
    return cloneUserIntegrationRecord(disconnected);
  }

  set(record: UserIntegrationRecord): void {
    validateUserIntegrationRecord(record);
    const cloned = cloneUserIntegrationRecord(record);
    this.records.set(record.id, cloned);
    if (cloned.revokedAt === null) {
      this.activeProviderIndex.set(activeProviderKey(cloned.userId, cloned.provider), cloned.id);
    }
  }

  private clearActive(userId: string, provider: UserIntegrationProvider, revokedAt: Date): void {
    const key = activeProviderKey(userId, provider);
    const activeId = this.activeProviderIndex.get(key);
    if (!activeId) return;
    const active = this.records.get(activeId);
    if (active) {
      this.records.set(active.id, cloneUserIntegrationRecord({
        ...active,
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        revokedAt,
      }));
    }
    this.activeProviderIndex.delete(key);
  }

  private async refreshLocked(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    const activeId = this.activeProviderIndex.get(activeProviderKey(input.userId, input.provider));
    const active = activeId ? this.records.get(activeId) : null;
    if (active?.status !== 'connected' || active.revokedAt !== null || !active.accessTokenCiphertext) {
      return { kind: 'missing', record: null };
    }
    if (!active.accessTokenCiphertext.equals(input.staleAccessTokenCiphertext)) {
      return { kind: 'reused', record: cloneUserIntegrationRecord(active) };
    }
    const decision = await input.refresh(cloneUserIntegrationRecord(active));
    const updated: UserIntegrationRecord = decision.kind === 'refreshed'
      ? {
          ...active,
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          credentialKeyVersion: decision.credentialKeyVersion ?? active.credentialKeyVersion,
          status: 'connected',
          errorReason: null,
        }
      : {
          ...active,
          status: 'error',
          errorReason: decision.errorReason,
        };
    this.set(updated);
    return {
      kind: decision.kind,
      record: cloneUserIntegrationRecord(updated),
    };
  }
}

function defaultAuthorizedPermissions(provider: UserIntegrationProvider): Readonly<Record<string, unknown>> {
  if (provider === GITHUB_USER_INTEGRATION_PROVIDER) {
    return {
      repository_selection: 'unknown',
      permissions: { contents: 'none' },
    };
  }
  return { scopes: [] };
}

function activeProviderKey(userId: string, provider: UserIntegrationProvider): string {
  return `${userId}:${provider}`;
}
