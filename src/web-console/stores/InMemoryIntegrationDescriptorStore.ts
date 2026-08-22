import { randomUUID } from 'node:crypto';

import {
  cloneIntegrationDescriptorRecord,
  compareDescriptorPageOrder,
  decodeDescriptorPageCursor,
  encodeDescriptorPageCursor,
  isAfterDescriptorPageCursor,
  resolveDescriptorPageLimit,
  type IIntegrationDescriptorStore,
  type CuratedIntegrationDeploymentState,
  type CuratedIntegrationSeedDirective,
  type CuratedIntegrationSeedResult,
  type IntegrationDescriptorCreateInput,
  type IntegrationDescriptorCredentialFence,
  type IntegrationDescriptorPage,
  type IntegrationDescriptorPageRequest,
  type IntegrationDescriptorRecord,
  type IntegrationDescriptorUpsertOptions,
  integrationDescriptorMutationKey,
  isRetainedSeedCredentialRefresh,
  isCleanupRevocationEndpointRepair,
  CuratedIntegrationSeedConflictError,
  IntegrationDescriptorMutationBusyError,
  IntegrationDescriptorRevisionConflictError,
  validateIntegrationDescriptorInput,
  validateIntegrationDescriptorRecord,
} from './IIntegrationDescriptorStore.js';
import type { UserIntegrationProvider } from './IUserIntegrationStore.js';
import { assertUuid, ConsoleStoreConflictError } from './ConsoleStoreValidation.js';
import { AsyncKeyedLock } from '../../utils/AsyncKeyedLock.js';
import { integrationDescriptorRoutingFingerprint } from '../modules/integrations/IntegrationDescriptorRoutingFingerprint.js';
import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';

export class InMemoryIntegrationDescriptorStore implements IIntegrationDescriptorStore {
  private readonly records = new Map<string, IntegrationDescriptorRecord>();
  private readonly curatedState = new Map<UserIntegrationProvider, CuratedIntegrationDeploymentState>();
  private readonly mutationLock = new AsyncKeyedLock();
  private transactionGate: InMemoryTransactionGate | null = null;
  private credentialMutationFence: IntegrationDescriptorCredentialFence | null = null;

  constructor(records: readonly IntegrationDescriptorRecord[] = []) {
    for (const record of records) {
      this.set(record);
      if (record.ownership === 'curated' && record.curatedSeedRevision) {
        this.curatedState.set(record.provider, {
          provider: record.provider,
          seedRevision: record.curatedSeedRevision,
          enabled: true,
          updatedAt: new Date(record.updatedAt),
        });
      }
    }
  }

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  configureCredentialMutationFence(fence: IntegrationDescriptorCredentialFence): void {
    this.credentialMutationFence = {
      ...fence,
      fencePendingCallbacks: fence.fencePendingCallbacks
        ?? this.credentialMutationFence?.fencePendingCallbacks,
    };
  }

  async listVisible(userId: string): Promise<readonly IntegrationDescriptorRecord[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return this.visibleSorted(userId).map(cloneIntegrationDescriptorRecord);
  }

  async listVisiblePage(
    userId: string,
    page: IntegrationDescriptorPageRequest = {},
  ): Promise<IntegrationDescriptorPage> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const limit = resolveDescriptorPageLimit(page.limit);
    const cursor = page.cursor ? decodeDescriptorPageCursor(page.cursor) : null;
    const visible = this.visibleSorted(userId)
      .filter(record => !cursor || isAfterDescriptorPageCursor(record, cursor));
    const items = visible.slice(0, limit).map(cloneIntegrationDescriptorRecord);
    const lastItem = items.at(-1);
    return {
      items,
      nextCursor: visible.length > limit && lastItem ? encodeDescriptorPageCursor(lastItem) : null,
    };
  }

  private visibleSorted(userId: string): IntegrationDescriptorRecord[] {
    return [...this.records.values()]
      .filter(record => (record.ownership === 'curated' && this.isCuratedEnabled(record.provider))
        || record.ownerUserId === userId)
      .sort(compareDescriptorPageOrder);
  }

  async findVisibleByProvider(
    userId: string,
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const candidates = [...this.records.values()].filter(record =>
      record.provider === provider && (
        (record.ownership === 'curated' && this.isCuratedEnabled(record.provider))
        || record.ownerUserId === userId
      ));
    // Curated strictly wins over a same-id BYO descriptor so a user cannot
    // shadow a curated provider's credential/routing by authoring their own.
    // `.at(0)` (not `[0]`) keeps the type honest that the array may be empty.
    const visible = candidates.find(record => record.ownership === 'curated') ?? candidates.at(0);
    return visible ? cloneIntegrationDescriptorRecord(visible) : null;
  }

  async findCuratedByProvider(
    provider: UserIntegrationProvider,
  ): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    const record = [...this.records.values()].find(candidate =>
      candidate.provider === provider &&
      candidate.ownership === 'curated' &&
      candidate.ownerUserId === null);
    return record ? cloneIntegrationDescriptorRecord(record) : null;
  }

  async findById(id: string, userId: string): Promise<IntegrationDescriptorRecord | null> {
    await Promise.resolve();
    assertUuid(id, 'id');
    assertUuid(userId, 'userId');
    const record = this.records.get(id);
    return record?.ownership === 'byo' && record.ownerUserId === userId
      ? cloneIntegrationDescriptorRecord(record)
      : null;
  }

  async delete(id: string, ownerUserId: string): Promise<boolean> {
    await Promise.resolve();
    assertUuid(id, 'id');
    assertUuid(ownerUserId, 'ownerUserId');
    const initial = this.records.get(id);
    if (initial?.ownership !== 'byo' || initial.ownerUserId !== ownerUserId) return false;
    return this.runMutation(() =>
      this.mutationLock.runExclusive(integrationDescriptorMutationKey(initial), async () => {
        const record = this.records.get(id);
        if (record?.ownership !== 'byo' || record.ownerUserId !== ownerUserId) return false;
        await this.prepareDescriptorRemoval(record.id);
        this.records.delete(id);
        return true;
      }));
  }

  async deleteCurated(provider: UserIntegrationProvider): Promise<boolean> {
    await Promise.resolve();
    return this.runMutation(() =>
      this.mutationLock.runExclusive(curatedMutationKey(provider), async () => {
        const current = this.findCuratedRecord(provider);
        if (!current) return false;
        await this.prepareDescriptorRemoval(current.id);
        this.records.delete(current.id);
        return true;
      }));
  }

  async reconcileCuratedSeed(
    directive: CuratedIntegrationSeedDirective,
  ): Promise<CuratedIntegrationSeedResult> {
    validateCuratedSeedDirective(directive);
    return this.runMutation(() => this.mutationLock.runExclusive(curatedMutationKey(directive.provider), async () => {
      const currentState = this.curatedState.get(directive.provider) ?? null;
      const transition = curatedSeedTransition(currentState, directive);
      const existing = this.findCuratedRecord(directive.provider);
      if (transition === 'retain') {
        return {
          applied: false,
          enabled: currentState?.enabled ?? true,
          seedRevision: currentState?.seedRevision ?? existing?.curatedSeedRevision ?? null,
          descriptor: currentState?.enabled === false || !existing
            ? null
            : cloneIntegrationDescriptorRecord(existing),
        };
      }
      if (!directive.enabled) {
        if (existing) await this.fenceDescriptorCallbacks(existing.id);
        this.curatedState.set(directive.provider, {
          provider: directive.provider,
          seedRevision: directive.seedRevision,
          enabled: false,
          updatedAt: new Date(directive.updatedAt),
        });
        return {
          applied: transition === 'apply',
          enabled: false,
          seedRevision: directive.seedRevision,
          descriptor: null,
        };
      }
      const descriptor = await this.upsertLocked(
        directive.descriptor,
        directive.upsertOptions ?? {},
      );
      if (directive.seedRevision !== null) {
        this.curatedState.set(directive.provider, {
          provider: directive.provider,
          seedRevision: directive.seedRevision,
          enabled: true,
          updatedAt: new Date(directive.updatedAt),
        });
      }
      return {
        applied: transition === 'apply',
        enabled: true,
        seedRevision: directive.seedRevision,
        descriptor,
      };
    }));
  }

  async upsert(
    input: IntegrationDescriptorCreateInput,
    options: IntegrationDescriptorUpsertOptions = {},
  ): Promise<IntegrationDescriptorRecord> {
    await Promise.resolve();
    validateIntegrationDescriptorInput(input);
    return this.runMutation(() => this.mutationLock.runExclusive(
      integrationDescriptorMutationKey(input),
      () => this.upsertLocked(input, options),
    ));
  }

  async runIfCurrent<T>(
    descriptorId: string,
    descriptorFingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T | null> {
    assertUuid(descriptorId, 'descriptorId');
    const initial = this.records.get(descriptorId);
    if (!initial) return null;
    const lockKey = integrationDescriptorMutationKey(initial);
    return this.runMutation(() => this.mutationLock.runExclusive(lockKey, async () => {
      const descriptor = this.records.get(descriptorId);
      if (!descriptor || integrationDescriptorRoutingFingerprint(descriptor) !== descriptorFingerprint) {
        return null;
      }
      if (descriptor.ownership === 'curated' && !this.isCuratedEnabled(descriptor.provider)) return null;
      return operation();
    }));
  }

  private async upsertLocked(
    input: IntegrationDescriptorCreateInput,
    options: IntegrationDescriptorUpsertOptions,
  ): Promise<IntegrationDescriptorRecord> {
    const existing = [...this.records.values()].find(record =>
      record.provider === input.provider &&
      record.ownership === input.ownership &&
      record.ownerUserId === input.ownerUserId);
    if (options.expectedUpdatedAt
        && (!existing || existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime())) {
      throw new IntegrationDescriptorRevisionConflictError();
    }
    const nextUpdatedAt = existing
      ? new Date(Math.max(input.updatedAt.getTime(), existing.updatedAt.getTime() + 1))
      : new Date(input.updatedAt);
    if (existing && preservesNewerCuratedSeed(existing, input)) {
      if (!options.refreshDeploymentCredentialsAtRetainedSeedRevision) {
        return cloneIntegrationDescriptorRecord(existing);
      }
      if (!isRetainedSeedCredentialRefresh(existing, input)) {
        throw new ConsoleStoreConflictError(
          'retained seed revision may refresh deployment OAuth credentials only',
        );
      }
    }
    const record: IntegrationDescriptorRecord = {
      id: existing?.id ?? randomUUID(),
      provider: input.provider,
      ownership: input.ownership,
      ownerUserId: input.ownerUserId,
      displayName: input.displayName,
      category: input.category,
      authStrategy: input.authStrategy,
      apiHosts: [...input.apiHosts],
      oauth: input.oauth ?? null,
      staticApiKey: input.staticApiKey ?? null,
      clientSecretCiphertext: input.clientSecretCiphertext ?? null,
      clientSecretRevision: input.clientSecretRevision ?? null,
      credentialKeyVersion: input.credentialKeyVersion ?? null,
      curatedSeedRevision: input.curatedSeedRevision ?? null,
      operationPromotion: input.operationPromotion ?? {},
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: nextUpdatedAt,
    };
    if (existing
        && integrationDescriptorRoutingFingerprint(existing)
          !== integrationDescriptorRoutingFingerprint(record)) {
      await this.fenceDescriptorCallbacks(existing.id);
      if (isCleanupRevocationEndpointRepair(existing, record)) {
        if (await this.credentialMutationFence?.hasExecutableCredentialMaterial(existing.id)) {
          throw new IntegrationDescriptorMutationBusyError();
        }
      } else {
        await this.prepareDescriptorRemoval(existing.id);
      }
    }
    this.set(record);
    return cloneIntegrationDescriptorRecord(record);
  }

  set(record: IntegrationDescriptorRecord): void {
    validateIntegrationDescriptorRecord(record);
    this.records.set(record.id, cloneIntegrationDescriptorRecord(record));
  }

  private findCuratedRecord(provider: UserIntegrationProvider): IntegrationDescriptorRecord | null {
    return [...this.records.values()].find(candidate =>
      candidate.provider === provider
      && candidate.ownership === 'curated'
      && candidate.ownerUserId === null) ?? null;
  }

  private isCuratedEnabled(provider: UserIntegrationProvider): boolean {
    return this.curatedState.get(provider)?.enabled !== false;
  }

  private async prepareDescriptorRemoval(integrationDescriptorId: string): Promise<void> {
    await this.fenceDescriptorCallbacks(integrationDescriptorId);
    if (!this.credentialMutationFence) return;
    if (await this.credentialMutationFence.hasCredentialMaterial(integrationDescriptorId)) {
      throw new IntegrationDescriptorMutationBusyError();
    }
    await this.credentialMutationFence.revokeCredentiallessBindings(integrationDescriptorId, new Date());
  }

  private async fenceDescriptorCallbacks(integrationDescriptorId: string): Promise<void> {
    const fence = this.credentialMutationFence?.fencePendingCallbacks;
    if (fence && !await fence(integrationDescriptorId)) {
      throw new IntegrationDescriptorMutationBusyError();
    }
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate ? this.transactionGate.runMutation(operation) : operation();
  }
}

function curatedMutationKey(provider: UserIntegrationProvider): string {
  return integrationDescriptorMutationKey({
    provider,
    ownership: 'curated',
    ownerUserId: null,
  });
}

function validateCuratedSeedDirective(directive: CuratedIntegrationSeedDirective): void {
  if (!Number.isSafeInteger(directive.seedRevision ?? 0)
      || (directive.seedRevision ?? 0) < (directive.enabled ? 0 : 1)
      || (directive.seedRevision ?? 0) > 2_147_483_647) {
    throw new CuratedIntegrationSeedConflictError('curated seed revision is invalid');
  }
  if (!directive.enabled) return;
  validateIntegrationDescriptorInput(directive.descriptor);
  const descriptorRevision = directive.descriptor.curatedSeedRevision ?? null;
  if (directive.descriptor.ownership !== 'curated'
      || directive.descriptor.ownerUserId !== null
      || directive.descriptor.provider !== directive.provider
      || (directive.seedRevision !== null
        && descriptorRevision !== null
        && descriptorRevision < directive.seedRevision)) {
    throw new CuratedIntegrationSeedConflictError('curated seed directive does not match its descriptor');
  }
}

function curatedSeedTransition(
  current: CuratedIntegrationDeploymentState | null,
  directive: CuratedIntegrationSeedDirective,
): 'apply' | 'same' | 'retain' {
  if (!current) return 'apply';
  const revision = directive.seedRevision;
  if (revision === null || revision < current.seedRevision) return 'retain';
  if (revision === current.seedRevision) {
    if (directive.enabled !== current.enabled) {
      throw new CuratedIntegrationSeedConflictError(
        'curated seed cannot change enabled state without a newer revision',
      );
    }
    return 'same';
  }
  return 'apply';
}

function preservesNewerCuratedSeed(
  existing: IntegrationDescriptorRecord,
  input: IntegrationDescriptorCreateInput,
): boolean {
  const currentRevision = existing.curatedSeedRevision ?? null;
  if (existing.ownership !== 'curated' || currentRevision === null) return false;
  const proposedRevision = input.curatedSeedRevision ?? null;
  return proposedRevision === null || proposedRevision <= currentRevision;
}
