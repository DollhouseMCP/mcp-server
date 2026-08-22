import { randomUUID } from 'node:crypto';
import {
  areAuthorizedPermissionsEqual,
  cloneUserIntegrationRecord,
  type DescriptorCallbackConnectInput,
  type DescriptorCredentialConnectInput,
  GITHUB_USER_INTEGRATION_PROVIDER,
  hasIntegrationCredentials,
  IntegrationAlreadyConnectedError,
  IntegrationCredentialCleanupPendingError,
  type IUserIntegrationStore,
  type IntegrationDescriptorCallbackFence,
  type IntegrationAuthorizationFreshnessFence,
  type IntegrationPrincipalLifecycleFence,
  type UserIntegrationConnectInput,
  type UserIntegrationCleanupCompleteInput,
  type UserIntegrationCleanupClaimInput,
  type UserIntegrationCleanupReleaseInput,
  type UserIntegrationCleanupRenewInput,
  type UserIntegrationCleanupConnectInput,
  type UserIntegrationDisconnectInput,
  type UserIntegrationErrorInput,
  type UserIntegrationProvider,
  type UserIntegrationRefreshInput,
  type UserIntegrationRefreshDecision,
  type UserIntegrationRefreshResult,
  type UserIntegrationRecord,
  validateUserIntegrationRecord,
} from './IUserIntegrationStore.js';
import { assertUuid } from './ConsoleStoreValidation.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';

export class InMemoryUserIntegrationStore implements IUserIntegrationStore {
  private readonly records = new Map<string, UserIntegrationRecord>();
  private readonly activeProviderIndex = new Map<string, string>();
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private readonly refreshClaims = new Set<string>();
  private readonly cleanupLeases = new Map<string, { leaseId: string; expiresAt: Date }>();
  private descriptorCallbackFence: IntegrationDescriptorCallbackFence | null = null;
  private authorizationFreshnessFence: IntegrationAuthorizationFreshnessFence | null = null;
  private principalLifecycleFence: IntegrationPrincipalLifecycleFence | null = null;
  private transactionGate: InMemoryTransactionGate | null = null;

  constructor(records: readonly UserIntegrationRecord[] = []) {
    for (const record of records) {
      this.set(record);
    }
  }

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  async listByUser(userId: string): Promise<readonly UserIntegrationRecord[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return [...this.records.values()]
        .filter(record => record.userId === userId && record.revokedAt === null)
        .map(cloneUserIntegrationRecord);
    });
  }

  async findByProvider(userId: string, provider: UserIntegrationProvider): Promise<UserIntegrationRecord | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const recordId = this.activeProviderIndex.get(activeProviderKey(userId, provider));
      const record = recordId ? this.records.get(recordId) : null;
      return record ? cloneUserIntegrationRecord(record) : null;
    });
  }

  async captureCredentialOperationStartedAt(requestedAt: Date): Promise<Date> {
    return new Date(requestedAt);
  }

  async connect(input: UserIntegrationConnectInput): Promise<UserIntegrationRecord> {
    return this.runMutation(async () => {
      await Promise.resolve();
      return this.connectNow(input);
    });
  }

  private connectNow(
    input: UserIntegrationConnectInput,
    allowCredentialReplacement = false,
  ): UserIntegrationRecord {
    if (this.hasPendingNow(input.userId, input.provider)) {
      throw new IntegrationCredentialCleanupPendingError();
    }
    const current = this.currentActive(input.userId, input.provider);
    if (!allowCredentialReplacement
        && (current?.accessTokenCiphertext || current?.refreshTokenCiphertext)) {
      throw new IntegrationAlreadyConnectedError();
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
      credentialGeneration: 0,
      status: 'connected',
      errorReason: null,
      authorizationStartedAt: input.authorizationStartedAt ?? input.connectedAt,
      connectedAt: input.connectedAt,
      lastSyncAt: null,
      revokedAt: null,
    };
    // Validate before changing the active index. Invalid replacement input must
    // not disable the user's currently valid credential.
    validateUserIntegrationRecord(record);
    this.moveActiveToCleanup(input.userId, input.provider, input.connectedAt);
    this.set(record);
    return cloneUserIntegrationRecord(record);
  }

  configureDescriptorCallbackFence(fence: IntegrationDescriptorCallbackFence): void {
    this.descriptorCallbackFence = fence;
  }

  configureAuthorizationFreshnessFence(fence: IntegrationAuthorizationFreshnessFence): void {
    this.authorizationFreshnessFence = fence;
  }

  configurePrincipalLifecycleFence(fence: IntegrationPrincipalLifecycleFence): void {
    this.principalLifecycleFence = fence;
  }

  async connectDescriptorCallback(input: DescriptorCallbackConnectInput): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      const persistIfFresh = async (): Promise<UserIntegrationRecord | null> => {
        if (!this.authorizationFreshnessFence
            || !await this.authorizationFreshnessFence.isCompletionCurrent(input.transactionIdHash)) return null;
        if (this.principalLifecycleFence
            && !await this.principalLifecycleFence.isPrincipalActive(input.connection.userId)) return null;
        if (await this.authorizationFreshnessFence.hasNewerAuthorization(
              input.connection.userId,
              input.descriptorId,
              input.transactionIdHash,
            )) return null;
        const active = this.currentActive(input.connection.userId, input.connection.provider);
        if (this.hasPendingNow(input.connection.userId, input.connection.provider)) return null;
        const latestAuthorization = [...this.records.values()]
          .filter(record => record.userId === input.connection.userId
            && record.provider === input.connection.provider)
          .map(record => record.authorizationStartedAt ?? record.connectedAt)
          .filter((value): value is Date => value !== null && value !== undefined)
          .reduce<Date | null>((latest, value) => !latest || value > latest ? value : latest, null);
        if (latestAuthorization && latestAuthorization >= input.authorizationStartedAt) return null;
        return this.connectNow({
          ...input.connection,
          authorizationStartedAt: input.authorizationStartedAt,
        }, active !== null);
      };
      if (!input.descriptorId || !input.descriptorFingerprint) return persistIfFresh();
      if (!this.descriptorCallbackFence) return null;
      return this.descriptorCallbackFence.runIfCurrent(
        input.descriptorId,
        input.descriptorFingerprint,
        persistIfFresh,
      );
    });
  }

  async connectDescriptorCredential(
    input: DescriptorCredentialConnectInput,
  ): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      if (this.principalLifecycleFence
          && !await this.principalLifecycleFence.isPrincipalActive(input.connection.userId)) return null;
      const latestAuthorization = [...this.records.values()]
        .filter(record => record.userId === input.connection.userId
          && record.provider === input.connection.provider)
        .map(record => record.authorizationStartedAt ?? record.connectedAt)
        .filter((value): value is Date => value !== null && value !== undefined)
        .reduce<Date | null>((latest, value) => !latest || value > latest ? value : latest, null);
      if (latestAuthorization && latestAuthorization >= input.operationStartedAt) return null;
      if (!this.descriptorCallbackFence) return null;
      return this.descriptorCallbackFence.runIfCurrent(
        input.descriptorId,
        input.descriptorFingerprint,
        () => Promise.resolve(this.connectNow(input.connection)),
      );
    });
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
      const claimed = await this.runMutation(() => this.claimRefreshLocked(input));
      if ('result' in claimed) return claimed.result;
      let decision: UserIntegrationRefreshDecision;
      try {
        decision = await input.refresh(cloneUserIntegrationRecord(claimed.record));
      } catch (error) {
        await this.runMutation(async () => { this.refreshClaims.delete(claimed.record.id); });
        throw error;
      }
      try {
        return await this.runMutation(() => this.completeRefreshLocked(input, claimed.record, decision));
      } catch (error) {
        await this.runMutation(async () => { this.refreshClaims.delete(claimed.record.id); });
        throw error;
      }
    } finally {
      release();
      if (this.refreshLocks.get(key) === tail) this.refreshLocks.delete(key);
    }
  }

  async recordError(input: UserIntegrationErrorInput): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      const active = this.currentActive(input.userId, input.provider);
      if (!active || active.id !== input.integrationId
          || active.credentialGeneration !== input.credentialGeneration) return null;
      this.moveActiveToCleanup(input.userId, input.provider, input.occurredAt);
      const record: UserIntegrationRecord = {
      id: randomUUID(),
      userId: input.userId,
      provider: input.provider,
      integrationDescriptorId: input.integrationDescriptorId ?? null,
      externalAccountLabel: null,
      externalInstallationId: null,
      authorizedPermissions: defaultAuthorizedPermissions(input.provider),
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      credentialKeyVersion: null,
      credentialGeneration: 0,
      status: 'error',
      errorReason: input.errorReason,
      authorizationStartedAt: null,
      connectedAt: null,
      lastSyncAt: null,
      revokedAt: null,
      };
      this.set(record);
      return cloneUserIntegrationRecord(record);
    });
  }

  async disconnect(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      const active = this.currentActive(input.userId, input.provider);
      if (!active || active.id !== input.integrationId
          || active.credentialGeneration !== input.credentialGeneration) return null;
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
    });
  }

  async queueCredentialCleanup(input: UserIntegrationCleanupConnectInput): Promise<UserIntegrationRecord> {
    return this.runMutation(async () => {
      await Promise.resolve();
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
      credentialGeneration: 0,
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      authorizationStartedAt: input.authorizationStartedAt ?? input.connectedAt,
      connectedAt: input.connectedAt,
      lastSyncAt: null,
      revokedAt: input.cleanupRequestedAt,
      };
      this.set(record);
      return cloneUserIntegrationRecord(record);
    });
  }

  async markCredentialCleanupPending(input: UserIntegrationDisconnectInput): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      const active = this.currentActive(input.userId, input.provider);
      if (!active || active.id !== input.integrationId
          || active.credentialGeneration !== input.credentialGeneration) return null;
      const pending = cleanupPendingRecord(active, input.revokedAt);
      this.records.set(pending.id, cloneUserIntegrationRecord(pending));
      this.activeProviderIndex.delete(activeProviderKey(input.userId, input.provider));
      return cloneUserIntegrationRecord(pending);
    });
  }

  async beginAuthorizationDisconnect(
    userId: string,
    provider: UserIntegrationProvider,
    requestedAt: Date,
  ): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const active = this.currentActive(userId, provider);
      let disconnected: UserIntegrationRecord | null = null;
      if (active) {
        disconnected = hasIntegrationCredentials(active)
          ? cleanupPendingRecord(active, requestedAt)
          : { ...active, status: 'revoked', errorReason: null, revokedAt: requestedAt };
        this.records.set(disconnected.id, cloneUserIntegrationRecord(disconnected));
        this.activeProviderIndex.delete(activeProviderKey(userId, provider));
      }
      const tombstone: UserIntegrationRecord = {
        id: randomUUID(),
        userId,
        provider,
        integrationDescriptorId: null,
        externalAccountLabel: null,
        externalInstallationId: null,
        authorizedPermissions: defaultAuthorizedPermissions(provider),
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        credentialKeyVersion: null,
        credentialGeneration: 0,
        status: 'revoked',
        errorReason: null,
        authorizationStartedAt: requestedAt,
        connectedAt: null,
        lastSyncAt: null,
        revokedAt: requestedAt,
      };
      this.set(tombstone);
      return disconnected ? cloneUserIntegrationRecord(disconnected) : null;
    });
  }

  async listCredentialCleanup(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<readonly UserIntegrationRecord[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return [...this.records.values()]
        .filter(record => record.userId === userId
          && record.provider === provider
          && record.status === 'cleanup_pending')
        .map(cloneUserIntegrationRecord);
    });
  }

  async claimCredentialCleanup(
    input: UserIntegrationCleanupClaimInput,
  ): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(input.cleanupLeaseId, 'cleanupLeaseId');
      if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) return null;
      const record = this.records.get(input.integrationId);
      const currentLease = this.cleanupLeases.get(input.integrationId);
      if (!record || record.userId !== input.userId || record.provider !== input.provider
          || record.status !== 'cleanup_pending'
          || record.credentialGeneration !== input.credentialGeneration
          || this.refreshClaims.has(record.id)
          || (currentLease && currentLease.expiresAt > new Date())) return null;
      this.cleanupLeases.set(input.integrationId, {
        leaseId: input.cleanupLeaseId,
        expiresAt: new Date(Date.now() + input.leaseDurationMs),
      });
      return cloneUserIntegrationRecord(record);
    });
  }

  async releaseCredentialCleanupClaim(input: UserIntegrationCleanupReleaseInput): Promise<void> {
    return this.runMutation(async () => {
      await Promise.resolve();
      const record = this.records.get(input.integrationId);
      const lease = this.cleanupLeases.get(input.integrationId);
      if (record?.userId === input.userId && record.provider === input.provider
          && lease?.leaseId === input.cleanupLeaseId) {
        this.cleanupLeases.delete(input.integrationId);
      }
    });
  }

  async renewCredentialCleanupClaim(input: UserIntegrationCleanupRenewInput): Promise<boolean> {
    return this.runMutation(async () => {
      await Promise.resolve();
      if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) return false;
      const record = this.records.get(input.integrationId);
      const lease = this.cleanupLeases.get(input.integrationId);
      if (!record || record.userId !== input.userId || record.provider !== input.provider
          || record.status !== 'cleanup_pending'
          || record.credentialGeneration !== input.credentialGeneration
          || lease?.leaseId !== input.cleanupLeaseId) return false;
      this.cleanupLeases.set(input.integrationId, {
        leaseId: input.cleanupLeaseId,
        expiresAt: new Date(Date.now() + input.leaseDurationMs),
      });
      return true;
    });
  }

  async completeCredentialCleanup(
    input: UserIntegrationCleanupCompleteInput,
  ): Promise<UserIntegrationRecord | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      const record = this.records.get(input.integrationId);
      const lease = this.cleanupLeases.get(input.integrationId);
      if (!record || record.userId !== input.userId || record.provider !== input.provider
          || record.status !== 'cleanup_pending'
          || record.credentialGeneration !== input.credentialGeneration
          || lease?.leaseId !== input.cleanupLeaseId) return null;
      const completed: UserIntegrationRecord = {
      ...record,
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      credentialKeyVersion: null,
      status: 'revoked',
      errorReason: null,
      revokedAt: input.completedAt,
      };
      this.records.set(completed.id, cloneUserIntegrationRecord(completed));
      this.cleanupLeases.delete(completed.id);
      return cloneUserIntegrationRecord(completed);
    });
  }

  async hasCredentialCleanupPending(userId: string, provider: UserIntegrationProvider): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return this.hasPendingNow(userId, provider);
    });
  }

  async hasAnyCredentialMaterial(userId: string): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return [...this.records.values()].some(record => record.userId === userId
        && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
    });
  }

  async hasCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(integrationDescriptorId, 'integrationDescriptorId');
      return [...this.records.values()].some(record =>
        record.integrationDescriptorId === integrationDescriptorId
        && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
    });
  }

  async hasExecutableCredentialMaterialByDescriptor(integrationDescriptorId: string): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(integrationDescriptorId, 'integrationDescriptorId');
      return [...this.records.values()].some(record =>
        record.integrationDescriptorId === integrationDescriptorId
        && record.revokedAt === null
        && (record.accessTokenCiphertext !== null || record.refreshTokenCiphertext !== null));
    });
  }

  async revokeAllByDescriptor(integrationDescriptorId: string, revokedAt: Date): Promise<number> {
    return this.runMutation(async () => {
      await Promise.resolve();
      assertUuid(integrationDescriptorId, 'integrationDescriptorId');
      let revoked = 0;
      for (const record of this.records.values()) {
        if (record.integrationDescriptorId !== integrationDescriptorId || record.revokedAt !== null) continue;
        const replacement = record.accessTokenCiphertext || record.refreshTokenCiphertext
          ? cleanupPendingRecord(record, revokedAt)
          : { ...record, status: 'revoked' as const, errorReason: null, revokedAt };
        this.records.set(record.id, cloneUserIntegrationRecord(replacement));
        this.activeProviderIndex.delete(activeProviderKey(record.userId, record.provider));
        revoked++;
      }
      return revoked;
    });
  }

  set(record: UserIntegrationRecord): void {
    const normalized = {
      ...record,
      credentialGeneration: record.credentialGeneration ?? 0,
      authorizationStartedAt: record.authorizationStartedAt
        ?? (record.status === 'connected' ? record.connectedAt : null),
    };
    validateUserIntegrationRecord(normalized);
    const cloned = cloneUserIntegrationRecord(normalized);
    this.records.set(record.id, cloned);
    if (cloned.revokedAt === null) {
      this.activeProviderIndex.set(activeProviderKey(cloned.userId, cloned.provider), cloned.id);
    }
  }

  createTransactionSnapshot(): {
    readonly records: readonly UserIntegrationRecord[];
    readonly activeProviderIndex: readonly (readonly [string, string])[];
    readonly cleanupLeases: readonly (readonly [string, { leaseId: string; expiresAt: Date }])[];
    readonly refreshClaims: readonly string[];
  } {
    return {
      records: [...this.records.values()].map(cloneUserIntegrationRecord),
      activeProviderIndex: [...this.activeProviderIndex.entries()],
      cleanupLeases: [...this.cleanupLeases.entries()].map(([id, lease]) => [id, {
        leaseId: lease.leaseId,
        expiresAt: new Date(lease.expiresAt),
      }] as const),
      refreshClaims: [...this.refreshClaims],
    };
  }

  restoreTransactionSnapshot(snapshot: ReturnType<InMemoryUserIntegrationStore['createTransactionSnapshot']>): void {
    this.records.clear();
    this.activeProviderIndex.clear();
    this.cleanupLeases.clear();
    this.refreshClaims.clear();
    for (const record of snapshot.records) this.records.set(record.id, cloneUserIntegrationRecord(record));
    for (const [key, value] of snapshot.activeProviderIndex) this.activeProviderIndex.set(key, value);
    for (const [id, lease] of snapshot.cleanupLeases) this.cleanupLeases.set(id, {
      leaseId: lease.leaseId,
      expiresAt: new Date(lease.expiresAt),
    });
    for (const id of snapshot.refreshClaims) this.refreshClaims.add(id);
  }

  private moveActiveToCleanup(userId: string, provider: UserIntegrationProvider, revokedAt: Date): void {
    const key = activeProviderKey(userId, provider);
    const activeId = this.activeProviderIndex.get(key);
    if (!activeId) return;
    const active = this.records.get(activeId);
    if (active) {
      const replacement = active.accessTokenCiphertext || active.refreshTokenCiphertext
        ? cleanupPendingRecord(active, revokedAt)
        : { ...active, status: 'revoked' as const, errorReason: null, revokedAt };
      this.records.set(active.id, cloneUserIntegrationRecord(replacement));
    }
    this.activeProviderIndex.delete(key);
  }

  private hasPendingNow(userId: string, provider: UserIntegrationProvider): boolean {
    return [...this.records.values()].some(record => record.userId === userId
      && record.provider === provider
      && record.status === 'cleanup_pending');
  }

  private async claimRefreshLocked(input: UserIntegrationRefreshInput): Promise<
    | { readonly record: UserIntegrationRecord }
    | { readonly result: UserIntegrationRefreshResult }
  > {
    const activeId = this.activeProviderIndex.get(activeProviderKey(input.userId, input.provider));
    const active = activeId ? this.records.get(activeId) : null;
    if (active?.status !== 'connected' || active.revokedAt !== null || !active.accessTokenCiphertext
        || (active.integrationDescriptorId ?? null) !== input.integrationDescriptorId) {
      return { result: { kind: 'missing', record: null } };
    }
    if (!active.accessTokenCiphertext.equals(input.staleAccessTokenCiphertext)) {
      return { result: { kind: 'reused', record: cloneUserIntegrationRecord(active) } };
    }
    if (active.credentialGeneration !== input.staleCredentialGeneration
        || !areAuthorizedPermissionsEqual(active.authorizedPermissions, input.staleAuthorizedPermissions)) {
      return { result: { kind: 'reused', record: cloneUserIntegrationRecord(active) } };
    }
    this.refreshClaims.add(active.id);
    return { record: cloneUserIntegrationRecord(active) };
  }

  private async completeRefreshLocked(
    input: UserIntegrationRefreshInput,
    active: UserIntegrationRecord,
    decision: UserIntegrationRefreshDecision,
  ): Promise<UserIntegrationRefreshResult> {
    const winnerId = this.activeProviderIndex.get(activeProviderKey(input.userId, input.provider));
    const winner = winnerId ? this.records.get(winnerId) : null;
    if (!winner || winner.id !== active.id || winner.revokedAt !== null
        || (winner.integrationDescriptorId ?? null) !== input.integrationDescriptorId) {
      if (decision.kind === 'refreshed') {
        const cleanupRequestedAt = new Date();
        const pending: UserIntegrationRecord = {
          ...active,
          id: randomUUID(),
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          credentialKeyVersion: decision.credentialKeyVersion ?? active.credentialKeyVersion,
          authorizedPermissions: decision.authorizedPermissions ?? active.authorizedPermissions,
          credentialGeneration: 0,
          status: 'cleanup_pending',
          errorReason: 'revocation_failed',
          connectedAt: cleanupRequestedAt,
          revokedAt: cleanupRequestedAt,
        };
        this.set(pending);
        this.refreshClaims.delete(active.id);
        return { kind: 'retryable', record: cloneUserIntegrationRecord(pending) };
      }
      this.refreshClaims.delete(active.id);
      return { kind: 'missing', record: null };
    }
    if (!winner.accessTokenCiphertext?.equals(input.staleAccessTokenCiphertext)
        || !buffersEqual(winner.refreshTokenCiphertext, active.refreshTokenCiphertext)
        || winner.credentialKeyVersion !== active.credentialKeyVersion
        || winner.credentialGeneration !== active.credentialGeneration
        || !areAuthorizedPermissionsEqual(winner.authorizedPermissions, active.authorizedPermissions)) {
      this.refreshClaims.delete(active.id);
      return winner.status === 'connected'
        ? { kind: 'reused', record: cloneUserIntegrationRecord(winner) }
        : { kind: 'missing', record: null };
    }
    if (decision.kind === 'retryable') {
      this.refreshClaims.delete(active.id);
      return { kind: 'retryable', record: cloneUserIntegrationRecord(winner) };
    }
    if (decision.kind === 'failed' && winner.status !== 'connected') {
      this.refreshClaims.delete(active.id);
      return { kind: 'failed', record: cloneUserIntegrationRecord(winner) };
    }
    if (decision.kind === 'refreshed' && winner.status !== 'connected' && winner.status !== 'error') {
      this.refreshClaims.delete(active.id);
      return { kind: 'missing', record: null };
    }
    const updated: UserIntegrationRecord = decision.kind === 'refreshed'
      ? {
          ...winner,
          accessTokenCiphertext: decision.accessTokenCiphertext,
          refreshTokenCiphertext: decision.refreshTokenCiphertext,
          credentialKeyVersion: decision.credentialKeyVersion ?? active.credentialKeyVersion,
          authorizedPermissions: decision.authorizedPermissions ?? active.authorizedPermissions,
          credentialGeneration: winner.credentialGeneration + 1,
          status: 'connected',
          errorReason: null,
        }
      : {
          ...winner,
          status: 'error',
          errorReason: decision.errorReason,
        };
    this.set(updated);
    this.refreshClaims.delete(active.id);
    return {
      kind: decision.kind,
      record: cloneUserIntegrationRecord(updated),
    };
  }

  private currentActive(userId: string, provider: UserIntegrationProvider): UserIntegrationRecord | null {
    const id = this.activeProviderIndex.get(activeProviderKey(userId, provider));
    return id ? this.records.get(id) ?? null : null;
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate ? this.transactionGate.runMutation(operation) : operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate ? this.transactionGate.runRead(operation) : operation();
  }
}

function cleanupPendingRecord(record: UserIntegrationRecord, revokedAt: Date): UserIntegrationRecord {
  return {
    ...record,
    status: 'cleanup_pending',
    errorReason: 'revocation_failed',
    revokedAt,
  };
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

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}
