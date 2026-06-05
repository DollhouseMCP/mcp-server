import type { ConsoleAdminRole } from '../../database/schema/index.js';
import {
  assertUuid,
  cloneDate,
  ConsoleStoreValidationError,
} from './ConsoleStoreValidation.js';

export type { ConsoleAdminRole };

export interface ConsolePrincipalSummary {
  readonly userId: string;
  readonly primarySub: string | null;
  readonly username: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly authMethods: readonly string[];
  readonly roles: readonly ConsoleAdminRole[];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly adminFactorEnrolled: boolean;
  readonly accountCorrelationId: string;
  readonly authzVersion: number;
}

export interface ConsoleRoleAssignment {
  readonly id: string;
  readonly userId: string;
  readonly role: ConsoleAdminRole;
  readonly grantedAt: Date;
  readonly grantedByUserId: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByUserId: string | null;
}

export interface PrincipalStateChange {
  readonly userId: string;
  readonly authzVersion: number;
  readonly disabledAt: Date | null;
  readonly changedAt: Date;
}

export interface PrincipalDirectoryQuery {
  readonly sub?: string;
  readonly limit?: number;
}

export interface RoleGrantInput {
  readonly userId: string;
  readonly role: ConsoleAdminRole;
  readonly grantedByUserId: string | null;
  readonly grantedAt: Date;
}

export interface RoleRevokeInput {
  readonly userId: string;
  readonly role: ConsoleAdminRole;
  readonly revokedByUserId: string;
  readonly revokedAt: Date;
}

export interface PrincipalDisableInput {
  readonly userId: string;
  readonly disabledAt: Date;
}

export interface PrincipalEnableInput {
  readonly userId: string;
  readonly enabledAt: Date;
}

export interface PrincipalAuthzVersionBumpInput {
  readonly userId: string;
  readonly bumpedAt: Date;
}

export interface PrincipalProfileUpdateInput {
  readonly userId: string;
  readonly displayName: string | null;
  readonly updatedAt: Date;
}

export interface PrincipalDeletionInput {
  readonly userId: string;
  readonly deletedAt: Date;
}

/** One provider login (auth account). Several may resolve to one user. */
export interface LinkedIdentity {
  readonly sub: string;
  readonly provider: string;
  readonly externalSub: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  readonly linkedUserId: string | null;
  readonly createdAt: Date;
  readonly lastAuthAt: Date | null;
}

export interface IdentityLinkInput {
  readonly userId: string;
  readonly sub: string;
  readonly linkedAt: Date;
}

export interface IdentityUnlinkInput {
  readonly userId: string;
  readonly sub: string;
  readonly unlinkedAt: Date;
}

export interface IdentityMutationResult {
  readonly sub: string;
  readonly linkedUserId: string | null;
}

/**
 * Outcome of a deletion attempt.
 *
 * `deleted` — the `users` row was hard-removed (no audit/authorship history
 * referenced it).
 * `anonymized` — a RESTRICT reference (the tamper-evident audit chain, a role
 * grant this user authored, …) blocked the hard delete, so the row was scrubbed
 * of all identifying data and kept as a PII-free audit anchor (`authzVersion`
 * is the bumped value). The account is unusable either way.
 */
export interface PrincipalDeletionOutcome {
  readonly userId: string;
  readonly outcome: 'deleted' | 'anonymized';
  readonly authzVersion: number | null;
}

export interface IConsoleAccountAdminStore {
  listPrincipals(query?: PrincipalDirectoryQuery): Promise<ConsolePrincipalSummary[]>;
  findPrincipal(userId: string): Promise<ConsolePrincipalSummary | null>;
  findPrincipalByAccountCorrelationId(accountCorrelationId: string): Promise<ConsolePrincipalSummary | null>;
  listActiveRoles(userId: string): Promise<ConsoleAdminRole[]>;
  grantRole(input: RoleGrantInput): Promise<ConsoleRoleAssignment>;
  revokeRole(input: RoleRevokeInput): Promise<ConsoleRoleAssignment | null>;
  countEnabledAccountsAdmins(): Promise<number>;
  disablePrincipal(input: PrincipalDisableInput): Promise<PrincipalStateChange | null>;
  enablePrincipal(input: PrincipalEnableInput): Promise<PrincipalStateChange | null>;
  bumpPrincipalAuthzVersion(input: PrincipalAuthzVersionBumpInput): Promise<PrincipalStateChange | null>;
  updatePrincipalProfile(input: PrincipalProfileUpdateInput): Promise<ConsolePrincipalSummary | null>;
  /**
   * Remove an account: detach its logins, factors and roles, then attempt a
   * true row delete, falling back to anonymize-tombstone when audit/authorship
   * RESTRICT references block it. Returns null when the user does not exist.
   */
  deletePrincipal(input: PrincipalDeletionInput): Promise<PrincipalDeletionOutcome | null>;
  /** Provider logins (auth accounts) currently linked to this user. */
  listLinkedIdentities(userId: string): Promise<LinkedIdentity[]>;
  /** A single login by its `sub`, with its current link state. Null if unknown. */
  findIdentityBySub(sub: string): Promise<LinkedIdentity | null>;
  /** Attach an unlinked login to this user. Returns null when the login is gone. */
  linkIdentity(input: IdentityLinkInput): Promise<IdentityMutationResult | null>;
  /** Detach a login from this user. Returns null when the login is gone. */
  unlinkIdentity(input: IdentityUnlinkInput): Promise<IdentityMutationResult | null>;
}

export const CONSOLE_ADMIN_ROLES = [
  'admin',
  'account_admin',
  'operator',
  'auditor',
  'security_admin',
] as const satisfies readonly ConsoleAdminRole[];

export function assertAdminRole(value: string, name: string): asserts value is ConsoleAdminRole {
  if (!CONSOLE_ADMIN_ROLES.some(role => role === value)) {
    throw new ConsoleStoreValidationError(`${name} contains unknown administrative role '${value}'`);
  }
}

export function validatePrincipalDirectoryQuery(query: PrincipalDirectoryQuery = {}): void {
  if (query.sub?.trim() === '') {
    throw new ConsoleStoreValidationError('sub filter must be non-empty when provided');
  }
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200)) {
    throw new ConsoleStoreValidationError('principal directory limit must be between 1 and 200');
  }
}

export function validateRoleGrantInput(input: RoleGrantInput): void {
  assertUuid(input.userId, 'userId');
  assertAdminRole(input.role, 'role');
  if (input.grantedByUserId !== null) assertUuid(input.grantedByUserId, 'grantedByUserId');
}

export function validateRoleRevokeInput(input: RoleRevokeInput): void {
  assertUuid(input.userId, 'userId');
  assertAdminRole(input.role, 'role');
  assertUuid(input.revokedByUserId, 'revokedByUserId');
}

export function validatePrincipalDisableInput(input: PrincipalDisableInput): void {
  assertUuid(input.userId, 'userId');
}

export function validatePrincipalEnableInput(input: PrincipalEnableInput): void {
  assertUuid(input.userId, 'userId');
}

export function validatePrincipalAuthzVersionBumpInput(input: PrincipalAuthzVersionBumpInput): void {
  assertUuid(input.userId, 'userId');
}

export function validatePrincipalDeletionInput(input: PrincipalDeletionInput): void {
  assertUuid(input.userId, 'userId');
}

export function validateIdentitySub(sub: string, name = 'sub'): void {
  // `${provider}_${externalSub}` — bounded; auth_accounts.sub is varchar(320).
  if (sub.trim() === '' || sub.length > 320) {
    throw new ConsoleStoreValidationError(`${name} must be non-empty and at most 320 characters`);
  }
}

export function validateIdentityLinkInput(input: IdentityLinkInput): void {
  assertUuid(input.userId, 'userId');
  validateIdentitySub(input.sub);
}

export function validateIdentityUnlinkInput(input: IdentityUnlinkInput): void {
  assertUuid(input.userId, 'userId');
  validateIdentitySub(input.sub);
}

export function validatePrincipalProfileUpdateInput(input: PrincipalProfileUpdateInput): void {
  assertUuid(input.userId, 'userId');
  if (input.displayName !== null) {
    validateConsoleDisplayName(input.displayName, 'displayName');
  }
}

export function validateConsoleDisplayName(value: string, name: string): void {
  if (value.length > 255 || Buffer.byteLength(value, 'utf8') > 255) {
    throw new ConsoleStoreValidationError(`${name} must be 255 characters or fewer`);
  }
  if (hasUnsupportedControlCharacter(value)) {
    throw new ConsoleStoreValidationError(`${name} contains unsupported control characters`);
  }
  if (/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u.test(value)) {
    throw new ConsoleStoreValidationError(`${name} contains unsupported directional or zero-width characters`);
  }
  if (/[<>]/u.test(value)) {
    throw new ConsoleStoreValidationError(`${name} contains unsupported markup characters`);
  }
}

function hasUnsupportedControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code <= 0x08 || (code >= 0x0A && code <= 0x1F) || (code >= 0x7F && code <= 0x9F))) return true;
  }
  return false;
}

export function cloneRoleAssignment(assignment: ConsoleRoleAssignment): ConsoleRoleAssignment {
  return {
    ...assignment,
    grantedAt: new Date(assignment.grantedAt),
    revokedAt: cloneDate(assignment.revokedAt),
  };
}

export function clonePrincipalSummary(summary: ConsolePrincipalSummary): ConsolePrincipalSummary {
  return {
    ...summary,
    authMethods: [...summary.authMethods],
    roles: [...summary.roles],
    disabledAt: cloneDate(summary.disabledAt),
    createdAt: new Date(summary.createdAt),
    lastLoginAt: cloneDate(summary.lastLoginAt),
  };
}
