import { randomUUID } from 'node:crypto';

import {
  ConsoleStoreConflictError,
  assertUuid,
} from './ConsoleStoreValidation.js';
import type {
  ConsoleAdminRole,
  ConsolePrincipalSummary,
  ConsoleRoleAssignment,
  IConsoleAccountAdminStore,
  PrincipalAuthzVersionBumpInput,
  PrincipalDirectoryQuery,
  PrincipalDisableInput,
  PrincipalEnableInput,
  PrincipalProfileUpdateInput,
  PrincipalStateChange,
  RoleGrantInput,
  RoleRevokeInput,
} from './IConsoleAccountAdminStore.js';
import {
  clonePrincipalSummary,
  cloneRoleAssignment,
  validatePrincipalDirectoryQuery,
  validatePrincipalDisableInput,
  validatePrincipalEnableInput,
  validatePrincipalAuthzVersionBumpInput,
  validatePrincipalProfileUpdateInput,
  validateRoleGrantInput,
  validateRoleRevokeInput,
} from './IConsoleAccountAdminStore.js';

export class InMemoryConsoleAccountAdminStore implements IConsoleAccountAdminStore {
  private readonly principals = new Map<string, ConsolePrincipalSummary>();
  private readonly roles = new Map<string, ConsoleRoleAssignment>();

  constructor(initialPrincipals: readonly ConsolePrincipalSummary[] = []) {
    for (const principal of initialPrincipals) {
      this.addInitialPrincipal(principal);
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

  async listPrincipals(query: PrincipalDirectoryQuery = {}): Promise<ConsolePrincipalSummary[]> {
    await Promise.resolve();
    validatePrincipalDirectoryQuery(query);
    const filtered = [...this.principals.values()]
      .filter(principal => !query.sub || principal.primarySub === query.sub)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return filtered.slice(0, query.limit ?? 100).map(principal => this.withCurrentRoles(principal));
  }

  async findPrincipal(userId: string): Promise<ConsolePrincipalSummary | null> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    const principal = this.principals.get(userId);
    return principal ? this.withCurrentRoles(principal) : null;
  }

  async findPrincipalByAccountCorrelationId(accountCorrelationId: string): Promise<ConsolePrincipalSummary | null> {
    await Promise.resolve();
    assertUuid(accountCorrelationId, 'accountCorrelationId');
    const principal = [...this.principals.values()]
      .find(candidate => candidate.accountCorrelationId === accountCorrelationId);
    return principal ? this.withCurrentRoles(principal) : null;
  }

  async listActiveRoles(userId: string): Promise<ConsoleAdminRole[]> {
    await Promise.resolve();
    assertUuid(userId, 'userId');
    return this.activeRolesFor(userId);
  }

  async grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment> {
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
      grantedAt: new Date(input.grantedAt.getTime()),
      grantedByUserId: input.grantedByUserId,
      revokedAt: null,
      revokedByUserId: null,
    };
    this.roles.set(assignment.id, cloneRoleAssignment(assignment));
    this.bumpAuthzVersion(input.userId);
    return cloneRoleAssignment(assignment);
  }

  async revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null> {
    await Promise.resolve();
    validateRoleRevokeInput(input);
    if (this.wouldOrphanAccountsAdmin(input.userId, input.role)) return null;
    const active = [...this.roles.values()].find(
      assignment => assignment.userId === input.userId && assignment.role === input.role && !assignment.revokedAt,
    );
    if (!active) return null;
    const revoked = {
      ...active,
      revokedAt: new Date(input.revokedAt.getTime()),
      revokedByUserId: input.revokedByUserId,
    };
    this.roles.set(active.id, cloneRoleAssignment(revoked));
    this.bumpAuthzVersion(input.userId);
    return cloneRoleAssignment(revoked);
  }

  async countEnabledAccountsAdmins(): Promise<number> {
    await Promise.resolve();
    let count = 0;
    for (const principal of this.principals.values()) {
      if (!principal.disabledAt && this.hasAccountsAdminRole(principal.userId)) count += 1;
    }
    return count;
  }

  async disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null> {
    await Promise.resolve();
    validatePrincipalDisableInput(input);
    const principal = this.principals.get(input.userId);
    if (!principal || principal.disabledAt) return null;
    if (this.hasAccountsAdminRole(input.userId) && await this.countEnabledAccountsAdmins() <= 1) return null;
    const updated = {
      ...principal,
      disabledAt: new Date(input.disabledAt.getTime()),
      authzVersion: principal.authzVersion + 1,
    };
    this.principals.set(input.userId, clonePrincipalSummary(updated));
    return stateChangeFromPrincipal(updated, input.disabledAt);
  }

  async enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null> {
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
  }

  async bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null> {
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
  }

  async updatePrincipalProfile(input: PrincipalProfileUpdateInput): Promise<ConsolePrincipalSummary | null> {
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
      .sort();
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

function stateChangeFromPrincipal(
  principal: ConsolePrincipalSummary,
  changedAt: Date,
): PrincipalStateChange {
  return {
    userId: principal.userId,
    authzVersion: principal.authzVersion,
    disabledAt: principal.disabledAt ? new Date(principal.disabledAt.getTime()) : null,
    changedAt: new Date(changedAt.getTime()),
  };
}
