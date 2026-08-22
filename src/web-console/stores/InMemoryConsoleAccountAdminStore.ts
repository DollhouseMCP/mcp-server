import { randomUUID } from 'node:crypto';

import { InMemoryTransactionGate } from '../../utils/InMemoryTransactionGate.js';
import {
  ConsoleStoreConflictError,
  assertUuid,
} from './ConsoleStoreValidation.js';
import {
  CannotUnlinkLastIdentityError,
  WouldOrphanAccountsAdminError,
} from './IConsoleAccountAdminStore.js';
import type {
  ConsoleAdminRole,
  ConsolePrincipalSummary,
  ConsoleRoleAssignment,
  IConsoleAccountAdminStore,
  IdentityLinkFinalizationResult,
  IdentityLinkInput,
  IdentityLinkPreparationResult,
  IdentityMutationResult,
  IdentityUnlinkInput,
  LinkedIdentity,
  PrincipalAuthzVersionBumpInput,
  PrincipalDeletionInput,
  PrincipalDeletionOutcome,
  PrincipalDirectoryCursor,
  PrincipalDirectoryPage,
  PrincipalDirectoryQuery,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalProfileUpdateInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
  UnlinkedIdentityCursor,
  UnlinkedIdentityPage,
  UnlinkedIdentityQuery,
} from './IConsoleAccountAdminStore.js';
import {
  clonePrincipalSummary,
  cloneRoleAssignment,
  validateIdentityLinkInput,
  validateIdentitySub,
  validateIdentityUnlinkInput,
  validatePrincipalDirectoryQuery,
  validateUnlinkedIdentityQuery,
  validatePrincipalDisableInput,
  validatePrincipalEnableInput,
  validatePrincipalAuthzVersionBumpInput,
  validatePrincipalDeletionInput,
  validatePrincipalProfileUpdateInput,
  validateRoleGrantInput,
  validateRoleRevokeInput,
} from './IConsoleAccountAdminStore.js';

export class InMemoryConsoleAccountAdminStore implements IConsoleAccountAdminStore {
  private readonly principals = new Map<string, ConsolePrincipalSummary>();
  private readonly roles = new Map<string, ConsoleRoleAssignment>();
  private readonly identities = new Map<string, LinkedIdentity>();
  private readonly identityRevocationFences = new Map<string, 'identity_unlinked' | 'account_deleted'>();
  private transactionGate: InMemoryTransactionGate | null = null;

  constructor(
    initialPrincipals: readonly ConsolePrincipalSummary[] = [],
    initialIdentities: readonly LinkedIdentity[] = [],
  ) {
    for (const principal of initialPrincipals) {
      this.addInitialPrincipal(principal);
    }
    for (const identity of initialIdentities) {
      this.identities.set(identity.sub, cloneLinkedIdentity(identity));
    }
  }

  attachTransactionGate(gate: InMemoryTransactionGate): InMemoryTransactionGate {
    this.transactionGate ??= gate;
    return this.transactionGate;
  }

  createTransactionSnapshot(): unknown {
    return {
      principals: [...this.principals.entries()].map(([id, value]) => [id, clonePrincipalSummary(value)] as const),
      roles: [...this.roles.entries()].map(([id, value]) => [id, cloneRoleAssignment(value)] as const),
      identities: [...this.identities.entries()].map(([id, value]) => [id, cloneLinkedIdentity(value)] as const),
      identityRevocationFences: [...this.identityRevocationFences.entries()],
    };
  }

  restoreTransactionSnapshot(snapshot: unknown): void {
    const state = snapshot as {
      principals: readonly (readonly [string, ConsolePrincipalSummary])[];
      roles: readonly (readonly [string, ConsoleRoleAssignment])[];
      identities: readonly (readonly [string, LinkedIdentity])[];
      identityRevocationFences: readonly (readonly [string, 'identity_unlinked' | 'account_deleted'])[];
    };
    this.principals.clear();
    this.roles.clear();
    this.identities.clear();
    this.identityRevocationFences.clear();
    for (const [id, value] of state.principals) this.principals.set(id, clonePrincipalSummary(value));
    for (const [id, value] of state.roles) this.roles.set(id, cloneRoleAssignment(value));
    for (const [id, value] of state.identities) this.identities.set(id, cloneLinkedIdentity(value));
    for (const [sub, reason] of state.identityRevocationFences) {
      this.identityRevocationFences.set(sub, reason);
    }
  }

  private addInitialPrincipal(summary: ConsolePrincipalSummary): void {
    assertUuid(summary.userId, 'userId');
    assertUuid(summary.accountCorrelationId, 'accountCorrelationId');
    this.principals.set(summary.userId, clonePrincipalSummary(summary));
    for (const role of summary.roles) {
      const id = randomUUID();
      this.roles.set(id, {
        id,
        userId: summary.userId,
        role,
        grantedAt: summary.createdAt,
        grantedByUserId: null,
        revokedAt: null,
        revokedByUserId: null,
      });
    }
  }

  async listPrincipals(query: PrincipalDirectoryQuery = {}): Promise<PrincipalDirectoryPage> {
    return this.runRead(async () => {
      await Promise.resolve();
      validatePrincipalDirectoryQuery(query);
      const limit = query.limit ?? 100;
      const search = query.search?.toLowerCase();
      const filtered = [...this.principals.values()]
        .map(principal => this.withCurrentRoles(principal))
        .filter(p => !query.sub || p.primarySub === query.sub)
        .filter(p => query.enabled === undefined || (p.disabledAt === null) === query.enabled)
        .filter(p => !query.role || p.roles.includes(query.role))
        .filter(p => !search || matchesPrincipalSearch(p, search))
        .filter(p => !query.after || isAfterPrincipalKey(p, query.after))
        .sort(comparePrincipalKey);
      const items = filtered.slice(0, limit);
      const last = items.at(-1);
      const nextCursor: PrincipalDirectoryCursor | null = filtered.length > limit && last
        ? { createdAt: last.createdAt, userId: last.userId }
        : null;
      return { items, nextCursor };
    });
  }

  async listUnlinkedIdentities(query: UnlinkedIdentityQuery = {}): Promise<UnlinkedIdentityPage> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateUnlinkedIdentityQuery(query);
      const limit = query.limit ?? 100;
      const filtered = [...this.identities.values()]
        .filter(identity => identity.linkedUserId === null)
        .filter(identity => !query.after || isAfterIdentityKey(identity, query.after))
        .sort(compareIdentityKey);
      const items = filtered.slice(0, limit).map(cloneLinkedIdentity);
      const last = items.at(-1);
      const nextCursor: UnlinkedIdentityCursor | null = filtered.length > limit && last
        ? { createdAt: last.createdAt, sub: last.sub }
        : null;
      return { items, nextCursor };
    });
  }

  async findPrincipal(userId: string): Promise<ConsolePrincipalSummary | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      const principal = this.principals.get(userId);
      return principal ? this.withCurrentRoles(principal) : null;
    });
  }

  async findPrincipalByAccountCorrelationId(accountCorrelationId: string): Promise<ConsolePrincipalSummary | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(accountCorrelationId, 'accountCorrelationId');
      const principal = [...this.principals.values()]
        .find(candidate => candidate.accountCorrelationId === accountCorrelationId);
      return principal ? this.withCurrentRoles(principal) : null;
    });
  }

  async listActiveRoles(userId: string): Promise<ConsoleAdminRole[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return this.activeRolesFor(userId);
    });
  }

  async grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateRoleGrantInput(input);
      this.requirePrincipal(input.userId);
      if (this.activeRolesFor(input.userId).includes(input.role)) {
        throw new ConsoleStoreConflictError('administrative role is already active for principal');
      }
      const assignment: ConsoleRoleAssignment = {
        id: randomUUID(),
        userId: input.userId,
        role: input.role,
        grantedAt: new Date(input.grantedAt),
        grantedByUserId: input.grantedByUserId,
        revokedAt: null,
        revokedByUserId: null,
      };
      this.roles.set(assignment.id, cloneRoleAssignment(assignment));
      this.bumpAuthzVersion(input.userId);
      return cloneRoleAssignment(assignment);
    });
  }

  async revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateRoleRevokeInput(input);
      if (this.wouldOrphanAccountsAdmin(input.userId, input.role)) return null;
      const active = [...this.roles.values()].find(
        assignment => assignment.userId === input.userId && assignment.role === input.role && !assignment.revokedAt,
      );
      if (!active) return null;
      const revoked = {
        ...active,
        revokedAt: new Date(input.revokedAt),
        revokedByUserId: input.revokedByUserId,
      };
      this.roles.set(active.id, cloneRoleAssignment(revoked));
      this.bumpAuthzVersion(input.userId);
      return cloneRoleAssignment(revoked);
    });
  }

  async countEnabledAccountsAdmins(): Promise<number> {
    return this.runRead(async () => {
      await Promise.resolve();
      return this.countEnabledAccountsAdminsSync();
    });
  }

  async disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validatePrincipalDisableInput(input);
      const principal = this.principals.get(input.userId);
      if (!principal || principal.disabledAt) return null;
      if (this.hasAccountsAdminRole(input.userId) && await this.countEnabledAccountsAdmins() <= 1) return null;
      const updated = {
        ...principal,
        disabledAt: new Date(input.disabledAt),
        authzVersion: principal.authzVersion + 1,
      };
      this.principals.set(input.userId, clonePrincipalSummary(updated));
      return stateChangeFromPrincipal(updated, input.disabledAt);
    });
  }

  async enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validatePrincipalEnableInput(input);
      const principal = this.principals.get(input.userId);
      if (!principal?.disabledAt) return null;
      const updated = {
        ...principal,
        disabledAt: null,
        authzVersion: principal.authzVersion + 1,
      };
      this.principals.set(input.userId, clonePrincipalSummary(updated));
      return stateChangeFromPrincipal(updated, input.enabledAt);
    });
  }

  async bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validatePrincipalAuthzVersionBumpInput(input);
      const principal = this.principals.get(input.userId);
      if (!principal) return null;
      const updated = {
        ...principal,
        authzVersion: principal.authzVersion + 1,
      };
      this.principals.set(input.userId, clonePrincipalSummary(updated));
      return stateChangeFromPrincipal(updated, input.bumpedAt);
    });
  }

  async updatePrincipalProfile(input: PrincipalProfileUpdateInput): Promise<ConsolePrincipalSummary | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validatePrincipalProfileUpdateInput(input);
      const principal = this.principals.get(input.userId);
      if (!principal) return null;
      const updated = {
        ...principal,
        displayName: input.displayName,
      };
      this.principals.set(input.userId, clonePrincipalSummary(updated));
      return this.withCurrentRoles(updated);
    });
  }

  async deletePrincipal(input: PrincipalDeletionInput): Promise<PrincipalDeletionOutcome | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validatePrincipalDeletionInput(input);
      const principal = this.principals.get(input.userId);
      if (!principal) return null;
      if (this.hasAccountsAdminRole(input.userId) && this.countEnabledAccountsAdminsSync() <= 1) {
        throw new WouldOrphanAccountsAdminError();
      }
      // The in-memory backend models no FK graph, so a delete always fully
      // removes the principal and its role assignments. The drop-vs-tombstone
      // distinction is a Postgres-FK behavior, exercised by the integration tests.
      this.principals.delete(input.userId);
      for (const [id, assignment] of this.roles) {
        if (assignment.userId === input.userId) this.roles.delete(id);
      }
      for (const [sub, identity] of this.identities) {
        if (identity.linkedUserId !== input.userId) continue;
        this.identities.set(sub, { ...identity, linkedUserId: null });
        this.identityRevocationFences.set(sub, 'account_deleted');
      }
      return {
        userId: input.userId,
        outcome: 'deleted' as const,
        authzVersion: null,
      };
    });
  }

  async listLinkedIdentities(userId: string): Promise<LinkedIdentity[]> {
    return this.runRead(async () => {
      await Promise.resolve();
      assertUuid(userId, 'userId');
      return [...this.identities.values()]
        .filter(identity => identity.linkedUserId === userId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map(cloneLinkedIdentity);
    });
  }

  async findIdentityBySub(sub: string): Promise<LinkedIdentity | null> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateIdentitySub(sub);
      const identity = this.identities.get(sub);
      return identity ? cloneLinkedIdentity(identity) : null;
    });
  }

  async isIdentityRevocationFenced(sub: string): Promise<boolean> {
    return this.runRead(async () => {
      await Promise.resolve();
      validateIdentitySub(sub);
      return this.identityRevocationFences.has(sub);
    });
  }

  async linkIdentity(input: IdentityLinkInput): Promise<IdentityLinkPreparationResult> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateIdentityLinkInput(input);
      const identity = this.identities.get(input.sub);
      if (!identity) return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
      const fenceReason = this.identityRevocationFences.get(input.sub) ?? null;
      if (fenceReason === 'account_deleted') {
        return { outcome: 'subject_deleted', sub: identity.sub, linkedUserId: identity.linkedUserId };
      }
      if (identity.linkedUserId !== null) {
        if (identity.linkedUserId !== input.userId) {
          return { outcome: 'linked_elsewhere', sub: identity.sub, linkedUserId: identity.linkedUserId };
        }
        return {
          outcome: fenceReason === 'identity_unlinked' ? 'provisional' : 'already_linked',
          sub: identity.sub,
          linkedUserId: identity.linkedUserId,
        };
      }
      const updated = { ...identity, linkedUserId: input.userId };
      this.identities.set(input.sub, updated);
      if (fenceReason === null) this.identityRevocationFences.set(input.sub, 'identity_unlinked');
      this.bumpAuthzVersion(input.userId);
      return { outcome: 'provisional', sub: updated.sub, linkedUserId: updated.linkedUserId };
    });
  }

  async finalizeIdentityLink(input: IdentityLinkInput): Promise<IdentityLinkFinalizationResult> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateIdentityLinkInput(input);
      const identity = this.identities.get(input.sub);
      if (!identity || identity.linkedUserId !== input.userId) {
        return { outcome: 'not_found', sub: input.sub, linkedUserId: null };
      }
      const fenceReason = this.identityRevocationFences.get(input.sub) ?? null;
      if (fenceReason === 'account_deleted') {
        return { outcome: 'subject_deleted', sub: identity.sub, linkedUserId: identity.linkedUserId };
      }
      if (fenceReason === null) {
        return { outcome: 'already_finalized', sub: identity.sub, linkedUserId: identity.linkedUserId };
      }
      this.identityRevocationFences.delete(input.sub);
      this.bumpAuthzVersion(input.userId);
      return { outcome: 'finalized', sub: identity.sub, linkedUserId: identity.linkedUserId };
    });
  }

  async unlinkIdentity(input: IdentityUnlinkInput): Promise<IdentityMutationResult | null> {
    return this.runMutation(async () => {
      await Promise.resolve();
      validateIdentityUnlinkInput(input);
      const identity = this.identities.get(input.sub);
      if (!identity || identity.linkedUserId !== input.userId) return null;
      const linkedCount = [...this.identities.values()]
        .filter(candidate => candidate.linkedUserId === input.userId).length;
      if (linkedCount <= 1) throw new CannotUnlinkLastIdentityError();
      const updated = { ...identity, linkedUserId: null };
      this.identities.set(input.sub, updated);
      this.identityRevocationFences.set(input.sub, 'identity_unlinked');
      this.bumpAuthzVersion(input.userId);
      return { sub: updated.sub, linkedUserId: null };
    });
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runMutation(operation) ?? operation();
  }

  private runRead<T>(operation: () => Promise<T>): Promise<T> {
    return this.transactionGate?.runRead(operation) ?? operation();
  }

  private withCurrentRoles(principal: ConsolePrincipalSummary): ConsolePrincipalSummary {
    return clonePrincipalSummary({
      ...principal,
      roles: this.activeRolesFor(principal.userId),
    });
  }

  private activeRolesFor(userId: string): ConsoleAdminRole[] {
    return [...this.roles.values()]
      .filter(assignment => assignment.userId === userId && !assignment.revokedAt)
      .map(assignment => assignment.role)
      .sort((a, b) => a.localeCompare(b));
  }

  private hasAccountsAdminRole(userId: string): boolean {
    const roles = this.activeRolesFor(userId);
    return roles.includes('admin') || roles.includes('account_admin');
  }

  private wouldOrphanAccountsAdmin(userId: string, role: ConsoleAdminRole): boolean {
    if (role !== 'admin' && role !== 'account_admin') return false;
    const principal = this.principals.get(userId);
    return !!principal && !principal.disabledAt && this.hasOnlyAccountsAdminRole(userId, role)
      && this.countEnabledAccountsAdminsSync() <= 1;
  }

  private hasOnlyAccountsAdminRole(userId: string, role: ConsoleAdminRole): boolean {
    const roles = this.activeRolesFor(userId);
    if (!roles.includes(role)) return false;
    return !roles.some(candidate => candidate !== role && (candidate === 'admin' || candidate === 'account_admin'));
  }

  private countEnabledAccountsAdminsSync(): number {
    let count = 0;
    for (const principal of this.principals.values()) {
      if (!principal.disabledAt && this.hasAccountsAdminRole(principal.userId)) count += 1;
    }
    return count;
  }

  private requirePrincipal(userId: string): void {
    if (!this.principals.has(userId)) {
      throw new ConsoleStoreConflictError('principal does not exist');
    }
  }

  private bumpAuthzVersion(userId: string): void {
    const principal = this.principals.get(userId);
    if (!principal) return;
    this.principals.set(userId, clonePrincipalSummary({
      ...principal,
      authzVersion: principal.authzVersion + 1,
    }));
  }
}

function cloneLinkedIdentity(identity: LinkedIdentity): LinkedIdentity {
  return {
    ...identity,
    createdAt: new Date(identity.createdAt),
    lastAuthAt: identity.lastAuthAt ? new Date(identity.lastAuthAt) : null,
  };
}

/** In-memory mirror of the Postgres `(created_at, id)` keyset ordering + `> cursor` predicate. */
function comparePrincipalKey(a: ConsolePrincipalSummary, b: ConsolePrincipalSummary): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? a.userId.localeCompare(b.userId) : byTime;
}

function isAfterPrincipalKey(p: ConsolePrincipalSummary, after: PrincipalDirectoryCursor): boolean {
  const byTime = p.createdAt.getTime() - after.createdAt.getTime();
  return byTime === 0 ? p.userId.localeCompare(after.userId) > 0 : byTime > 0;
}

function matchesPrincipalSearch(p: ConsolePrincipalSummary, lowerPrefix: string): boolean {
  return [p.username, p.email ?? '', p.displayName ?? '']
    .some(field => field.toLowerCase().startsWith(lowerPrefix));
}

function compareIdentityKey(a: LinkedIdentity, b: LinkedIdentity): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime === 0 ? a.sub.localeCompare(b.sub) : byTime;
}

function isAfterIdentityKey(identity: LinkedIdentity, after: UnlinkedIdentityCursor): boolean {
  const byTime = identity.createdAt.getTime() - after.createdAt.getTime();
  return byTime === 0 ? identity.sub.localeCompare(after.sub) > 0 : byTime > 0;
}

function stateChangeFromPrincipal(
  principal: ConsolePrincipalSummary,
  changedAt: Date,
): PrincipalStateChange {
  return {
    userId: principal.userId,
    authzVersion: principal.authzVersion,
    disabledAt: principal.disabledAt ? new Date(principal.disabledAt) : null,
    changedAt: new Date(changedAt),
  };
}
