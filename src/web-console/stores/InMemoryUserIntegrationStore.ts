import { randomUUID } from 'node:crypto';

import {
  cloneUserIntegrationRecord,
  GITHUB_USER_INTEGRATION_PROVIDER,
  IntegrationCredentialCleanupPendingError,
  IntegrationCredentialReplacementRequiresCleanupError,
  type DescriptorCallbackConnectInput,
  type DescriptorCredentialConnectInput,
  type IUserIntegrationStore,
  type UserIntegrationCleanupAbandonInput,
  type UserIntegrationCleanupClaimInput,
  type UserIntegrationCleanupCompleteInput,
  type UserIntegrationCleanupFailInput,
  type UserIntegrationCleanupParkInput,
  type UserIntegrationCleanupReleaseInput,
  type UserIntegrationConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRefreshInput,
  type UserIntegrationRefreshResult,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { assertUuid, ConsoleStoreValidationError } from './ConsoleStoreValidation.js';
import type { InMemoryIntegrationMutationCoordinator } from './InMemoryIntegrationMutationCoordinator.js';
import type { ILoginTransactionStore } from './ILoginTransactionStore.js';

export type InMemoryDescriptorFingerprintResolver = (descriptorId: string) => string | null;
export interface InMemoryUserIntegrationStoreOptions {
  readonly mutationCoordinator?: InMemoryIntegrationMutationCoordinator;
  readonly loginTransactionStore?: ILoginTransactionStore;
  readonly now?: () => Date;
}

export class InMemoryUserIntegrationStore implements IUserIntegrationStore {
  private readonly records = new Map<string, UserIntegrationRecord>();
  private readonly activeProviderIndex = new Map<string, string>();
  private readonly providerMutationLocks = new Map<string, Promise<void>>();

  constructor(
    records: readonly UserIntegrationRecord[] = [],
    private readonly resolveDescriptorFingerprint: InMemoryDescriptorFingerprintResolver = () => null,
    private readonly options: InMemoryUserIntegrationStoreOptions = {},
  ) {
    for (const record of records) {
      this.set(record);
    }
  }

  async listByUser(
    userId: string,
    providers: readonly UserIntegrationProvider[],
  ): Promise<readonly UserIntegrationRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const visibleProviders = new Set(providers);
    return [...this.records.values()]
      .filter(record =>
        record.userId === userId &&
        (record.revokedAt === null || record.status === 'cleanup_pending'
          || record.status === 'cleanup_failed') &&
        visibleProviders.has(record.provider))
      .map(cloneUserIntegrationRecord);
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const recordId = this.activeProviderIndex.get(activeProviderKey(userId, provider));
    const record = recordId ? this.records.get(recordId) : null;
    return record ? cloneUserIntegrationRecord(record) : null;
  }

  async findCredentialCleanupPending(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const record = [...this.records.values()].find(candidate =>
      candidate.userId === userId
      && candidate.provider === provider
      && candidate.status === 'cleanup_pending');
    return record ? cloneUserIntegrationRecord(record) : null;
  }

  async findCredentialCleanupFailed(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<UserIntegrationRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const record = [...this.records.values()]
      .filter(candidate => candidate.userId === userId
        && candidate.provider === provider
        && candidate.status === 'cleanup_failed')
      .sort((left, right) => (right.revokedAt?.getTime() ?? 0) - (left.revokedAt?.getTime() ?? 0))[0];
    return record ? cloneUserIntegrationRecord(record) : null;
  }

  async connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord> {
    assertUuid(input.userId, 'userId');
    return this.withProviderMutationLock(
      input.userId,
      input.provider,
      () => this.connectLocked(input),
    );
  }

  async connectDescriptorCredential(
    input: DescriptorCredentialConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    const operation = () => this.connectDescriptorBound(input);
    return this.options.mutationCoordinator
      ? this.options.mutationCoordinator.runExclusive(operation)
      : operation();
  }

  async connectDescriptorCallback(
    input: DescriptorCallbackConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    if (input.transactionIdHash.length === 0) {
      throw new ConsoleStoreValidationError('transactionIdHash must not be empty');
    }
    const operation = () => this.connectDescriptorBound(input, async () => {
      const transaction = await this.options.loginTransactionStore?.findByIdHash(input.transactionIdHash);
      const now = this.options.now?.() ?? new Date();
      return transaction?.flowKind === 'integration_link'
        && transaction.consumedAt !== null
        && transaction.expiresAt > now
        && transaction.userId === input.connection.userId
        && transaction.integrationDescriptorId === input.descriptorId
        && transaction.integrationDescriptorFingerprint === input.descriptorFingerprint;
    });
    return this.options.mutationCoordinator
      ? this.options.mutationCoordinator.runExclusive(operation)
      : operation();
  }

  async parkCredentialCleanup(input: UserIntegrationCleanupParkInput): Promise<UserIntegrationRecord> {
    assertUuid(input.userId, 'userId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      if (this.findCleanupRecord(input.userId, input.provider)) {
        throw new IntegrationCredentialCleanupPendingError();
      }
      const pending: UserIntegrationRecord = {
        id: randomUUID(),
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId ?? null,
        cleanupDescriptorFingerprint: input.descriptorFingerprint,
        externalAccountLabel: input.externalAccountLabel,
        externalInstallationId: input.externalInstallationId,
        authorizedPermissions: input.authorizedPermissions,
        accessTokenCiphertext: input.accessTokenCiphertext,
        refreshTokenCiphertext: input.refreshTokenCiphertext,
        credentialKeyVersion: input.credentialKeyVersion ?? null,
        status: 'cleanup_pending',
        errorReason: 'revocation_failed',
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: input.requestedAt,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        connectedAt: input.connectedAt,
        lastSyncAt: null,
        revokedAt: input.requestedAt,
      };
      validateUserIntegrationRecord(pending);
      this.records.set(pending.id, cloneUserIntegrationRecord(pending));
      return cloneUserIntegrationRecord(pending);
    });
  }

  async refresh(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    assertUuid(input.userId, 'userId');
    return this.withProviderMutationLock(
      input.userId,
      input.provider,
      () => this.refreshLocked(input),
    );
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    if (input.expectedActiveRecordId !== null) {
      assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    }
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const activeId = this.activeProviderIndex.get(activeProviderKey(input.userId, input.provider)) ?? null;
      if (activeId !== input.expectedActiveRecordId) {
        const active = activeId ? this.records.get(activeId) : null;
        return active ? cloneUserIntegrationRecord(active) : null;
      }
      if (input.errorReason === 'revocation_failed' && activeId) {
        const existingPending = this.findCleanupRecord(input.userId, input.provider);
        if (existingPending) return cloneUserIntegrationRecord(existingPending);
        const active = this.records.get(activeId);
        if (!active) return null;
        const pending = this.toCleanupPending(active, input.occurredAt);
        this.records.set(pending.id, cloneUserIntegrationRecord(pending));
        this.activeProviderIndex.delete(activeProviderKey(input.userId, input.provider));
        return cloneUserIntegrationRecord(pending);
      }
      const record: UserIntegrationRecord = {
        id: randomUUID(),
        userId: input.userId,
        provider: input.provider,
        integrationDescriptorId: input.integrationDescriptorId ?? null,
        cleanupDescriptorFingerprint: null,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: defaultAuthorizedPermissions(input.provider),
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        status: 'error',
        errorReason: input.errorReason,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: null,
      };
      validateUserIntegrationRecord(record);
      this.clearActive(input.userId, input.provider, input.occurredAt);
      this.set(record);
      return cloneUserIntegrationRecord(record);
    });
  }

  async beginCredentialCleanup(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const key = activeProviderKey(input.userId, input.provider);
      const existingPending = this.findCleanupRecord(input.userId, input.provider);
      if (existingPending) return cloneUserIntegrationRecord(existingPending);
      const activeId = this.activeProviderIndex.get(key);
      if (activeId !== input.expectedActiveRecordId) {
        const pending = this.findCleanupRecord(input.userId, input.provider);
        return pending ? cloneUserIntegrationRecord(pending) : null;
      }
      const active = this.records.get(activeId);
      if (!active) return null;
      const pending = this.toCleanupPending(active, input.revokedAt);
      this.records.set(pending.id, cloneUserIntegrationRecord(pending));
      this.activeProviderIndex.delete(key);
      return cloneUserIntegrationRecord(pending);
    });
  }

  async claimCredentialCleanup(input: UserIntegrationCleanupClaimInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.cleanupRecordId, 'cleanupRecordId');
    assertUuid(input.leaseId, 'leaseId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const pending = this.records.get(input.cleanupRecordId);
      if (pending?.userId !== input.userId || pending.provider !== input.provider
          || pending.status !== 'cleanup_pending'
          || (pending.cleanupNextAttemptAt?.getTime() ?? Number.POSITIVE_INFINITY) > input.attemptedAt.getTime()
          || (pending.cleanupLeaseExpiresAt !== null
            && pending.cleanupLeaseExpiresAt.getTime() > input.attemptedAt.getTime())) {
        return null;
      }
      const claimed: UserIntegrationRecord = {
        ...pending,
        cleanupAttemptCount: Math.min(pending.cleanupAttemptCount + 1, 2_147_483_647),
        cleanupLeaseId: input.leaseId,
        cleanupLeaseExpiresAt: input.leaseExpiresAt,
      };
      validateUserIntegrationRecord(claimed);
      this.records.set(claimed.id, cloneUserIntegrationRecord(claimed));
      return cloneUserIntegrationRecord(claimed);
    });
  }

  async releaseCredentialCleanup(input: UserIntegrationCleanupReleaseInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.cleanupRecordId, 'cleanupRecordId');
    assertUuid(input.leaseId, 'leaseId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const pending = this.records.get(input.cleanupRecordId);
      if (pending?.userId !== input.userId || pending.provider !== input.provider
          || pending.status !== 'cleanup_pending' || pending.cleanupLeaseId !== input.leaseId) {
        return null;
      }
      const released: UserIntegrationRecord = {
        ...pending,
        cleanupNextAttemptAt: input.retryAt,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
      };
      validateUserIntegrationRecord(released);
      this.records.set(released.id, cloneUserIntegrationRecord(released));
      return cloneUserIntegrationRecord(released);
    });
  }

  async failCredentialCleanup(input: UserIntegrationCleanupFailInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.cleanupRecordId, 'cleanupRecordId');
    assertUuid(input.leaseId, 'leaseId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const pending = this.records.get(input.cleanupRecordId);
      if (pending?.userId !== input.userId || pending.provider !== input.provider
          || pending.status !== 'cleanup_pending' || pending.cleanupLeaseId !== input.leaseId) {
        return null;
      }
      const failed: UserIntegrationRecord = {
        ...pending,
        status: 'cleanup_failed',
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
      };
      validateUserIntegrationRecord(failed);
      this.records.set(failed.id, cloneUserIntegrationRecord(failed));
      return cloneUserIntegrationRecord(failed);
    });
  }

  async abandonCredentialCleanupForUser(
    input: UserIntegrationCleanupAbandonInput,
  ): Promise<readonly UserIntegrationRecord[]> {
    await Promise.resolve();
    assertUuid(input.userId, 'userId');
    const abandoned: UserIntegrationRecord[] = [];
    for (const [recordId, record] of this.records) {
      if (record.userId !== input.userId ||
          (record.status !== 'cleanup_pending' && !isBlockingLegacyOrphan(record))) continue;
      const failed: UserIntegrationRecord = {
        ...record,
        status: 'cleanup_failed',
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt: record.revokedAt ?? this.options.now?.() ?? new Date(),
      };
      validateUserIntegrationRecord(failed);
      this.records.set(recordId, cloneUserIntegrationRecord(failed));
      if (record.revokedAt === null) {
        this.activeProviderIndex.delete(activeProviderKey(record.userId, record.provider));
      }
      abandoned.push(cloneUserIntegrationRecord(failed));
    }
    return abandoned;
  }

  async completeCredentialCleanup(input: UserIntegrationCleanupCompleteInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.cleanupRecordId, 'cleanupRecordId');
    assertUuid(input.leaseId, 'leaseId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const pending = this.records.get(input.cleanupRecordId);
      if (pending?.userId !== input.userId || pending.provider !== input.provider
          || pending.status !== 'cleanup_pending' || pending.cleanupLeaseId !== input.leaseId) {
        return null;
      }
      const completed: UserIntegrationRecord = {
        ...pending,
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt: input.completedAt,
      };
      validateUserIntegrationRecord(completed);
      this.records.set(completed.id, cloneUserIntegrationRecord(completed));
      return cloneUserIntegrationRecord(completed);
    });
  }

  async hasAnyCredentialMaterial(userId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.records.values()].some(record =>
      record.userId === userId
      && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
  }

  async hasBlockingCredentialMaterial(userId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return [...this.records.values()].some(record =>
      record.userId === userId
      && record.status !== 'cleanup_failed'
      && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
  }

  async hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    return [...this.records.values()].some(record =>
      record.integrationDescriptorId === integrationDescriptorId
      && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
  }

  async hasBlockingCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    return [...this.records.values()].some(record =>
      record.integrationDescriptorId === integrationDescriptorId
      && record.status !== 'cleanup_failed'
      && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    assertUuid(input.userId, 'userId');
    assertUuid(input.expectedActiveRecordId, 'expectedActiveRecordId');
    return this.withProviderMutationLock(input.userId, input.provider, () => {
      const key = activeProviderKey(input.userId, input.provider);
      const activeId = this.activeProviderIndex.get(key);
      if (activeId !== input.expectedActiveRecordId) return null;
      const active = activeId ? this.records.get(activeId) : null;
      if (!active) return null;
      const disconnected: UserIntegrationRecord = {
        ...active,
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        status: 'revoked',
        errorReason: null,
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt: input.revokedAt,
      };
      validateUserIntegrationRecord(disconnected);
      this.records.set(disconnected.id, cloneUserIntegrationRecord(disconnected));
      this.activeProviderIndex.delete(key);
      return cloneUserIntegrationRecord(disconnected);
    });
  }

  private set(record: UserIntegrationRecord): void {
    validateUserIntegrationRecord(record);
    const cloned = cloneUserIntegrationRecord(record);
    this.records.set(record.id, cloned);
    if (cloned.revokedAt === null) {
      this.activeProviderIndex.set(activeProviderKey(cloned.userId, cloned.provider), cloned.id);
    }
  }

  private async connectDescriptorBound(
    input: DescriptorCredentialConnectInput | DescriptorCallbackConnectInput,
    validateBeforeWrite: () => Promise<boolean> = () => Promise.resolve(true),
  ): Promise<UserIntegrationRecord | null> {
    assertUuid(input.descriptorId, 'descriptorId');
    assertUuid(input.connection.userId, 'userId');
    if (!/^[a-f0-9]{64}$/.test(input.descriptorFingerprint)) {
      throw new ConsoleStoreValidationError('descriptorFingerprint must be a lowercase SHA-256 hex digest');
    }
    return this.withProviderMutationLock(
      input.connection.userId,
      input.connection.provider,
      async () => {
        if (!await validateBeforeWrite()
            || input.connection.integrationDescriptorId !== input.descriptorId ||
            this.resolveDescriptorFingerprint(input.descriptorId) !== input.descriptorFingerprint) {
          return null;
        }
        return this.connectLocked(input.connection);
      },
    );
  }

  private connectLocked(input: UserIntegrationConnectInput): UserIntegrationRecord {
    if (this.findCleanupRecord(input.userId, input.provider)) {
      throw new IntegrationCredentialCleanupPendingError();
    }
    const activeKey = activeProviderKey(input.userId, input.provider);
    const activeId = this.activeProviderIndex.get(activeKey);
    if (activeId) {
      const active = this.records.get(activeId);
      if (active?.accessTokenCiphertext || active?.refreshTokenCiphertext) {
        throw new IntegrationCredentialReplacementRequiresCleanupError();
      }
      // A credential-free connected/error row has no remote grant to revoke.
      // Retire it explicitly so the active-provider uniqueness invariant remains
      // intact without weakening cleanup requirements for real credentials.
      this.clearActive(input.userId, input.provider, input.connectedAt);
    }
    const record: UserIntegrationRecord = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId ?? null,
      externalAccountLabel: input.externalAccountLabel,
      externalInstallationId: input.externalInstallationId,
      authorizedPermissions: input.authorizedPermissions,
      accessTokenCiphertext: input.accessTokenCiphertext,
      refreshTokenCiphertext: input.refreshTokenCiphertext,
      credentialKeyVersion: input.credentialKeyVersion ?? null,
      status: 'connected',
      errorReason: null,
      cleanupAttemptCount: 0,
      cleanupNextAttemptAt: null,
      cleanupLeaseId: null,
      cleanupLeaseExpiresAt: null,
      connectedAt: input.connectedAt,
      lastSyncAt: null,
      revokedAt: null,
    };
    validateUserIntegrationRecord(record);
    this.set(record);
    return cloneUserIntegrationRecord(record);
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
        cleanupAttemptCount: 0,
        cleanupNextAttemptAt: null,
        cleanupLeaseId: null,
        cleanupLeaseExpiresAt: null,
        revokedAt,
      }));
    }
    this.activeProviderIndex.delete(key);
  }

  /**
   * Retire credential-free rows bound to a descriptor during a routing change.
   * The descriptor store invokes this while holding the shared mutation
   * coordinator, after it has refused any row containing revocable material.
   */
  async retireCredentialFreeBindingsByDescriptor(
    integrationDescriptorId: string,
    revokedAt: Date,
  ): Promise<number> {
    await Promise.resolve();
    assertUuid(integrationDescriptorId, 'integrationDescriptorId');
    let retired = 0;
    for (const record of this.records.values()) {
      if (record.integrationDescriptorId !== integrationDescriptorId || record.revokedAt !== null) continue;
      if (record.accessTokenCiphertext || record.refreshTokenCiphertext) {
        throw new IntegrationCredentialReplacementRequiresCleanupError();
      }
      const retiredRecord: UserIntegrationRecord = {
        ...record,
        status: 'revoked',
        errorReason: null,
        revokedAt,
      };
      validateUserIntegrationRecord(retiredRecord);
      this.records.set(record.id, cloneUserIntegrationRecord(retiredRecord));
      this.activeProviderIndex.delete(activeProviderKey(record.userId, record.provider));
      retired++;
    }
    return retired;
  }

  private findCleanupRecord(
    userId: string,
    provider: UserIntegrationProvider,
  ): UserIntegrationRecord | null {
    return [...this.records.values()].find(record =>
      record.userId === userId
      && record.provider === provider
      && record.status === 'cleanup_pending') ?? null;
  }

  private toCleanupPending(record: UserIntegrationRecord, requestedAt: Date): UserIntegrationRecord {
    const pending: UserIntegrationRecord = {
      ...record,
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      cleanupAttemptCount: 0,
      cleanupNextAttemptAt: requestedAt,
      cleanupLeaseId: null,
      cleanupLeaseExpiresAt: null,
      revokedAt: requestedAt,
    };
    validateUserIntegrationRecord(pending);
    return pending;
  }

  private async refreshLocked(input: UserIntegrationRefreshInput): Promise<UserIntegrationRefreshResult> {
    const activeId = this.activeProviderIndex.get(activeProviderKey(input.userId, input.provider));
    const active = activeId ? this.records.get(activeId) : null;
    if (active?.status !== 'connected' || active.revokedAt !== null || !active.accessTokenCiphertext
        || (active.integrationDescriptorId ?? null) !== input.integrationDescriptorId) {
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
          authorizedPermissions: decision.authorizedPermissions ?? active.authorizedPermissions,
          credentialKeyVersion: decision.credentialKeyVersion ?? active.credentialKeyVersion,
          status: 'connected',
          errorReason: null,
          lastSyncAt: input.refreshedAt,
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

  private async withProviderMutationLock<T>(
    userId: string,
    provider: UserIntegrationProvider,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const key = activeProviderKey(userId, provider);
    const previous = this.providerMutationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => { /* ignore prior holder rejection */ }).then(() => current);
    this.providerMutationLocks.set(key, tail);
    await previous.catch(() => { /* ignore prior holder rejection */ });
    try {
      return await operation();
    } finally {
      release();
      // Only the newest queued tail removes the key; later waiters replace it first.
      if (this.providerMutationLocks.get(key) === tail) this.providerMutationLocks.delete(key);
    }
  }
}

function isBlockingLegacyOrphan(record: UserIntegrationRecord): boolean {
  return record.provider !== GITHUB_USER_INTEGRATION_PROVIDER
    && record.integrationDescriptorId === null
    && record.status === 'error'
    && record.errorReason === 'revocation_failed'
    && record.revokedAt === null
    && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null);
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
