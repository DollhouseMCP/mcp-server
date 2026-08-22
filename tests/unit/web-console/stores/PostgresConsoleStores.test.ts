import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { UserIntegrationRecord } from '../../../../src/web-console/stores/IUserIntegrationStore.js';
import type { PortfolioSyncJobRecord } from '../../../../src/web-console/stores/IPortfolioSyncJobStore.js';
import type {
  IdempotencyClaim,
  IdempotencyRecord,
  IdempotencyRequestIdentity,
} from '../../../../src/web-console/stores/IIdempotencyStore.js';
import type { ConsoleAdminActorRole, ConsoleAdminAuditEvent } from '../../../../src/web-console/audit/IAdminAuditWriter.js';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { PostgresConsoleSessionStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleSessionStore.js'
);
const { PostgresLoginTransactionStore } = await import(
  '../../../../src/web-console/stores/PostgresLoginTransactionStore.js'
);
const { PostgresUserIntegrationStore, IntegrationRefreshBusyError } = await import(
  '../../../../src/web-console/stores/PostgresUserIntegrationStore.js'
);
const { PostgresIntegrationDescriptorStore } = await import(
  '../../../../src/web-console/stores/PostgresIntegrationDescriptorStore.js'
);
const { integrationDescriptorRoutingFingerprint } = await import(
  '../../../../src/web-console/modules/integrations/IntegrationDescriptorRoutingFingerprint.js'
);
const { PostgresIntegrationOpenApiSpecStore } = await import(
  '../../../../src/web-console/stores/PostgresIntegrationOpenApiSpecStore.js'
);
const { PostgresPortfolioSyncJobStore } = await import(
  '../../../../src/web-console/stores/PostgresPortfolioSyncJobStore.js'
);
const { PostgresIdempotencyStore } = await import(
  '../../../../src/web-console/stores/PostgresIdempotencyStore.js'
);
const { PostgresConsoleFactorStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleFactorStore.js'
);
const { PostgresConsoleAccountAdminStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAccountAdminStore.js'
);
const { PostgresConsoleAccountAllowlistStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAccountAllowlistStore.js'
);
const { PostgresConsoleSecurityInvalidationStore } = await import(
  '../../../../src/web-console/services/invalidation/PostgresConsoleSecurityInvalidationStore.js'
);
const { PostgresRuntimeSessionControlStore, isRuntimePresenceActiveWithTx } = await import(
  '../../../../src/web-console/services/runtime/PostgresRuntimeSessionControlStore.js'
);
const { PostgresOperatorConfigStore } = await import(
  '../../../../src/storage/operatorConfig/PostgresOperatorConfigStore.js'
);
const { PostgresAdminAuditWriter } = await import(
  '../../../../src/web-console/audit/PostgresAdminAuditWriter.js'
);
const { PostgresAccountAdminMutationTransactionRunner } = await import(
  '../../../../src/web-console/modules/account-admin/AccountAdminMutationTransaction.js'
);
const { PostgresSigningKeyStore } = await import(
  '../../../../src/storage/signingKeys/PostgresSigningKeyStore.js'
);
const { SigningKeyLifecycleConflictError } = await import(
  '../../../../src/storage/signingKeys/signingKeyLifecycle.js'
);
const { PostgresConsoleAuthPolicyStore } = await import(
  '../../../../src/web-console/stores/PostgresConsoleAuthPolicyStore.js'
);
const { PostgresConsoleIdentityResolver } = await import(
  '../../../../src/web-console/identity/PostgresConsoleIdentityResolver.js'
);
const { desc } = await import('drizzle-orm');
const { accountFactors } = await import('../../../../src/database/schema/index.js');
const { CONSUMED_TRANSACTION_COMPLETION_LEASE_MS } = await import(
  '../../../../src/web-console/stores/ILoginTransactionStore.js'
);
const {
  ConsoleStoreConflictError,
  ConsoleStoreValidationError,
  IntegrationDescriptorChangedError,
} = await import(
  '../../../../src/web-console/stores/ConsoleStoreValidation.js'
);
const { PortfolioSyncAlreadyPendingError } = await import(
  '../../../../src/web-console/stores/IPortfolioSyncJobStore.js'
);

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const READ_ISSUES_SCOPE = 'read:issues';
const FRESH_ACCESS_TOKEN = 'fresh-access';
const SECOND_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const DESCRIPTOR_ID = '19b9f7d7-0bf5-4cc0-9892-cf00d0f4f74d';
const SPEC_ID = '1f518305-ae82-4fe2-a696-dfdd2d4d4025';
const SPEC_HASH = 'a'.repeat(64);
const PRIMARY_SUB = 'github_user-7';
const AUDIT_KEY_ID = 'audit-key-test';
const BEFORE_NOW = new Date('2026-05-26T11:59:00.000Z');
const NOW = new Date('2026-05-26T12:00:00.000Z');
const FOUR_MINUTES = new Date('2026-05-26T12:04:00.000Z');
const FIVE_MINUTES = new Date('2026-05-26T12:05:00.000Z');
const THIRTY_MINUTES = new Date('2026-05-26T12:30:00.000Z');
const ONE_HOUR = new Date('2026-05-26T13:00:00.000Z');
const ALICE_EMAIL = 'alice@example.test';
const ALICE_DISPLAY_EMAIL = 'Alice@Example.Test';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const ALLOWLIST_ID = 'f0a8d9e6-b1a1-4d94-b600-bef99c8d4ed1';
const INTEGRATION_ID = '35e22a52-dc56-4cd0-9d13-b2802524fbd3';
const RUNTIME_SESSION_ID = 'mcp-session-1';
const RUNTIME_COMMAND_ID = '9f8a54b9-f195-41f0-802d-d0ec2fdfb30f';
const SELF_CAPABILITY = 'console:self';
const MUTATION_DATABASE = {} as DatabaseInstance;

function postgresMutationRunnerStores() {
  const signingKeyStore = Object.create(PostgresSigningKeyStore.prototype) as InstanceType<
    typeof PostgresSigningKeyStore
  >;
  Object.defineProperty(signingKeyStore, 'db', { value: MUTATION_DATABASE });
  const runtimeSessionControlStore = new PostgresRuntimeSessionControlStore(MUTATION_DATABASE);
  const operatorConfigStore = new PostgresOperatorConfigStore({ db: MUTATION_DATABASE });
  return {
    db: MUTATION_DATABASE,
    signingKeyStore,
    authPolicyStore: new PostgresConsoleAuthPolicyStore(MUTATION_DATABASE),
    runtimeSessionControlStore,
    operatorConfigStore,
  };
}

function hash(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function sessionRow(overrides: Partial<ConsoleSessionRecord & {
  elevatedCapabilities: string[];
  elevationExpiresAt: Date | null;
  elevationAcr: string | null;
  elevationAmr: string[] | null;
  elevationAuthTime: Date | null;
}> = {}) {
  return {
    idHash: hash(1),
    userId: USER_ID,
    authSub: PRIMARY_SUB,
    authzVersion: 0,
    csrfTokenHash: hash(2),
    grantedCapabilities: [SELF_CAPABILITY],
    elevatedCapabilities: [],
    elevationExpiresAt: null,
    elevationAcr: null,
    elevationAmr: null,
    elevationAuthTime: null,
    createdAt: NOW,
    lastUsedAt: NOW,
    idleExpiresAt: THIRTY_MINUTES,
    absoluteExpiresAt: ONE_HOUR,
    revokedAt: null,
    lastIp: null,
    userAgent: null,
    ...overrides,
  };
}

function loginTransaction(): ConsoleLoginTransaction {
  return {
    idHash: hash(3),
    flowKind: 'login',
    stateHash: hash(4),
    pkceVerifierEnc: Buffer.from('ciphertext'),
    userId: null,
    consoleSessionIdHash: null,
    requestedCapability: null,
    returnTo: '/api/v1/me',
    createdAt: NOW,
    expiresAt: FIVE_MINUTES,
    consumedAt: null,
  };
}

function userIntegrationRow(overrides: Partial<UserIntegrationRecord> = {}) {
  return {
    id: INTEGRATION_ID,
    userId: USER_ID,
    provider: 'github',
    externalAccountLabel: 'alice',
    externalInstallationId: 'installation-123',
    authorizedPermissions: {
      repository_selection: 'selected',
      permissions: { contents: 'read' },
    },
    accessTokenCiphertext: Buffer.from('encrypted-access-token'),
    refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    credentialKeyVersion: 'integration-key-v1',
    credentialGeneration: 0,
    refreshFence: 0,
    refreshLeaseId: null,
    refreshLeaseExpiresAt: null,
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function integrationDescriptorRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DESCRIPTOR_ID,
    provider: 'gmail',
    ownership: 'byo',
    ownerUserId: USER_ID,
    displayName: 'Gmail',
    category: 'email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: { style: 'form' },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: { operations: ['gmail.users.messages.list'] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function integrationDescriptorInput(overrides: Partial<Parameters<InstanceType<typeof PostgresIntegrationDescriptorStore>['upsert']>[0]> = {}) {
  return {
    provider: 'gmail',
    ownership: 'byo' as const,
    ownerUserId: USER_ID,
    displayName: 'Gmail',
    category: 'email',
    authStrategy: 'oauth2_authorization_code' as const,
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      pkce: 'required' as const,
      refresh: 'rotating' as const,
      tokenExchange: { style: 'form' },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: { operations: ['gmail.users.messages.list'] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function curatedProviderStateRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    provider: 'gmail',
    seedRevision: 2,
    enabled: false,
    updatedAt: NOW,
    ...overrides,
  };
}

function openApiSpecRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SPEC_ID,
    descriptorId: DESCRIPTOR_ID,
    spec: {
      openapi: '3.1.0',
      paths: {},
    },
    sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    specHash: SPEC_HASH,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function openApiSpecInput(overrides: Partial<Parameters<InstanceType<typeof PostgresIntegrationOpenApiSpecStore>['upsert']>[0]> = {}) {
  return {
    descriptorId: DESCRIPTOR_ID,
    spec: {
      openapi: '3.1.0',
      paths: {},
    },
    sourceUrl: 'https://gmail.googleapis.com/openapi.json',
    specHash: SPEC_HASH,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function portfolioSyncJobRow(overrides: Partial<PortfolioSyncJobRecord> = {}) {
  return {
    id: '90dc6b61-d6d8-455a-adb1-a227e7fdbf77',
    userId: USER_ID,
    integrationId: INTEGRATION_ID,
    direction: 'pull',
    conflictPolicy: 'fail',
    status: 'queued',
    claimVersion: 0,
    claimedByWorkerId: null,
    leaseUntil: null,
    attemptCount: 0,
    resultSummary: null,
    operationalErrorCode: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function idempotencyIdentity(): IdempotencyRequestIdentity {
  return {
    consoleSessionIdHash: hash(1),
    idempotencyKey: 'a51d7564-c85e-4e11-b319-dbc156d26f70',
    httpMethod: 'POST',
    canonicalTarget: '/api/v1/me/sessions/revoke',
    requestFingerprint: hash(7),
    createdAt: NOW,
    expiresAt: ONE_HOUR,
  };
}

function idempotencyClaim(): IdempotencyClaim {
  return {
    ...idempotencyIdentity(),
    claimId: 'bbe7c4c5-b59e-4bd0-9f8d-c892577ba944',
  };
}

function idempotencyRecord(): IdempotencyRecord {
  return {
    ...idempotencyClaim(),
    state: 'completed',
    responseStatus: 204,
    responseBodyPresent: false,
    responseBody: null,
  };
}

function returningChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.set = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function insertChain(rows: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.values = jest.fn(() => chain);
  chain.onConflictDoUpdate = jest.fn(() => chain);
  chain.onConflictDoNothing = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

/** Every string value reachable from a value tree (for inspecting drizzle exprs). */
function collectStrings(root: unknown): Set<string> {
  const out = new Set<string>();
  const seen = new WeakSet<object>();
  const iterableOf = (value: object): unknown[] => {
    if (value instanceof Map) return [...value.values()];
    if (value instanceof Set) return [...value];
    return Object.values(value as Record<string, unknown>);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 30 || value == null) return;
    if (typeof value === 'string') { out.add(value); return; }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const nested of iterableOf(value)) visit(nested, depth + 1);
  };
  visit(root, 0);
  return out;
}

function deletingChain(rows: unknown[] = []) {
  const chain: Record<string, jest.Mock> = {};
  chain.where = jest.fn(() => chain);
  chain.returning = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.innerJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.for = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  chain.then = jest.fn((resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject));
  return chain;
}

function selectingForUpdateChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => chain);
  chain.for = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingOrderedChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function selectingJoinedChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn(() => chain);
  chain.leftJoin = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.orderBy = jest.fn(() => chain);
  chain.limit = jest.fn(() => Promise.resolve(rows));
  return chain;
}

function factorRow(overrides: Partial<{
  userId: string;
  factorId: string;
  factorType: 'totp';
  secretCiphertext: Buffer | null;
  enrolledAt: Date;
  disabledAt: Date | null;
  lastUsedAt: Date | null;
}> = {}) {
  return {
    userId: USER_ID,
    factorId: 'cd8f6d0e-7294-42bc-9e01-094890a820a8',
    factorType: 'totp' as const,
    secretCiphertext: Buffer.from('encrypted-totp-seed'),
    enrolledAt: NOW,
    disabledAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

function roleRow(overrides: Partial<{
  id: string;
  userId: string;
  role: 'admin' | 'account_admin' | 'operator' | 'auditor' | 'security_admin';
  grantedAt: Date;
  grantedByUserId: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}> = {}) {
  return {
    id: '117f4897-f16d-4402-b6bb-b95f18ea5e40',
    userId: USER_ID,
    role: 'account_admin' as const,
    grantedAt: NOW,
    grantedByUserId: null,
    revokedAt: null,
    revokedByUserId: null,
    ...overrides,
  };
}

function roleMutationRow(overrides: Partial<ReturnType<typeof roleRow>> = {}) {
  const row = roleRow(overrides);
  return {
    role: {
      id: row.id,
      userId: row.userId,
      role: row.role,
      grantedAt: row.grantedAt,
      grantedByUserId: row.grantedByUserId,
      revokedAt: row.revokedAt,
      revokedByUserId: row.revokedByUserId,
    },
  };
}

function principalProjectionRow(overrides: Partial<{
  user_id: string;
  primary_sub: string | null;
  username: string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean | null;
  auth_methods: string[] | null;
  roles: string[] | null;
  disabled_at: Date | null;
  created_at: Date;
  last_login_at: number | null;
  admin_factor_enrolled: boolean;
  account_correlation_id: string;
  authz_version: number;
}> = {}) {
  return {
    user_id: USER_ID,
    primary_sub: PRIMARY_SUB,
    username: 'alice',
    display_name: 'Alice',
    email: ALICE_EMAIL,
    email_verified: true,
    auth_methods: ['github'],
    roles: ['account_admin'],
    disabled_at: null,
    created_at: NOW,
    last_login_at: FIVE_MINUTES.getTime(),
    admin_factor_enrolled: true,
    account_correlation_id: ACCOUNT_CORRELATION_ID,
    authz_version: 3,
    ...overrides,
  };
}

function mockLivePrincipalLock(overrides: Parameters<typeof principalProjectionRow>[0] = {}) {
  transaction.select = jest.fn(() => selectingChain([{ id: USER_ID }]));
  transaction.execute = jest.fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([principalProjectionRow(overrides)]);
}

function allowlistRow(overrides: Partial<{
  id: string;
  kind: 'email' | 'github_username' | 'github_id';
  normalizedValue: string;
  displayValue: string;
  note: string | null;
  createdByUserId: string;
  createdAt: Date;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  authorityOrder: number;
}> = {}) {
  return {
    id: ALLOWLIST_ID,
    kind: 'email' as const,
    normalizedValue: ALICE_EMAIL,
    displayValue: ALICE_DISPLAY_EMAIL,
    note: 'initial',
    createdByUserId: USER_ID,
    createdAt: FIVE_MINUTES,
    revokedByUserId: null,
    revokedAt: null,
    authorityOrder: 1,
    ...overrides,
  };
}

beforeEach(() => {
  withSystemContextMock.mockClear();
  transaction = {
    execute: jest.fn(() => Promise.resolve([])),
    select: jest.fn(() => selectingChain([])),
  };
});

describe('PostgresConsoleSessionStore', () => {
  it('refuses to recreate a session after the principal lifecycle fence closes', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.create(sessionRow())).rejects.toMatchObject({
      name: 'InactiveUserLifecycleError',
    });
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('uses one conditional update to attach elevation rather than a select/write race', async () => {
    const chain = returningChain([{ idHash: hash(1) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.setElevation(hash(1), {
      capabilities: ['console:admin:audit'],
      expiresAt: THIRTY_MINUTES,
      acr: 'urn:dollhouse:acr:admin',
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).resolves.toBe(true);

    expect(transaction.select).not.toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:audit'],
      elevatedCapabilities: ['console:admin:audit'],
    }));
  });

  it('clears elevation with one active-session conditional update', async () => {
    const chain = returningChain([{ idHash: hash(1) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevation(hash(1), FIVE_MINUTES)).resolves.toBe(true);

    expect(transaction.select).not.toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith({
      grantedCapabilities: [SELF_CAPABILITY],
      elevatedCapabilities: [],
      elevationExpiresAt: null,
      elevationAcr: null,
      elevationAmr: null,
      elevationAuthTime: null,
    });
  });

  it('returns false when clearing elevation updates no active elevated row', async () => {
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevation(hash(1), FIVE_MINUTES)).resolves.toBe(false);
  });

  it('clears all active elevated sessions for a user through a system-context conditional update', async () => {
    const chain = returningChain([{ idHash: hash(1) }, { idHash: hash(2) }]);
    transaction.update = jest.fn(() => chain);
    transaction.select = jest.fn();
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.clearElevationsForUser(USER_ID, FIVE_MINUTES)).resolves.toBe(2);

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).not.toHaveBeenCalled();
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledWith({
      grantedCapabilities: [SELF_CAPABILITY],
      elevatedCapabilities: [],
      elevationExpiresAt: null,
      elevationAcr: null,
      elevationAmr: null,
      elevationAuthTime: null,
    });
    expect(chain.where).toHaveBeenCalledWith(expect.anything());
  });

  it('rejects unvalidated capabilities read from database state', async () => {
    transaction.select = jest.fn(() => selectingChain([sessionRow({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:unknown'],
    })]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    await expect(store.findActiveByIdHash(hash(1), FOUR_MINUTES))
      .rejects.toThrow(ConsoleStoreValidationError);
  });

  it('clones validated database state before returning it to callers', async () => {
    const row = sessionRow({ authzVersion: 7 });
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    const returned = await store.findActiveByIdHash(hash(1), FOUR_MINUTES);
    returned?.idHash.fill(0);
    returned?.csrfTokenHash.fill(0);
    returned?.createdAt.setTime(0);

    expect(row.idHash).toEqual(hash(1));
    expect(row.csrfTokenHash).toEqual(hash(2));
    expect(row.createdAt).toEqual(NOW);
    expect(returned?.authzVersion).toBe(7);
  });

  it('lists active sessions for a user ordered by recent use', async () => {
    const row = sessionRow({
      grantedCapabilities: [SELF_CAPABILITY, 'console:admin:security'],
      elevatedCapabilities: ['console:admin:security'],
      elevationExpiresAt: THIRTY_MINUTES,
      elevationAcr: 'urn:dollhouse:acr:admin',
      elevationAmr: ['otp'],
      elevationAuthTime: FIVE_MINUTES,
    });
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);

    const sessions = await store.listActiveForUser(USER_ID, FOUR_MINUTES, 25);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.elevation?.expiresAt).toEqual(THIRTY_MINUTES);

    const chain = transaction.select.mock.results[0]?.value;
    expect(chain.orderBy).toHaveBeenCalled();
    expect(chain.limit).toHaveBeenCalledWith(25);
  });

  it('uses conditional touch results and counts bulk revocation and cleanup writes', async () => {
    const store = new PostgresConsoleSessionStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.touch(hash(1), {
      lastUsedAt: FOUR_MINUTES,
      idleExpiresAt: THIRTY_MINUTES,
    }, FOUR_MINUTES)).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(1) }, { idHash: hash(2) }]));
    await expect(store.revokeForUser(USER_ID, FIVE_MINUTES)).resolves.toBe(2);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(1) }]));
    await expect(store.revokeForUserSession(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.revokeForUserSession(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([{ idHash: hash(2) }]));
    await expect(store.revokeForUserExcept(USER_ID, hash(1), FIVE_MINUTES)).resolves.toBe(1);

    transaction.delete = jest.fn(() => returningChain([{ idHash: hash(1) }]));
    await expect(store.sweepExpired(ONE_HOUR)).resolves.toBe(1);
  });
});

describe('PostgresLoginTransactionStore', () => {
  it('persists the descriptor binding for configured-provider callbacks', async () => {
    const chain = insertChain();
    const principalLock = selectingChain([{ id: USER_ID }]);
    const descriptorLock = selectingChain([integrationDescriptorRow()]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(principalLock)
      .mockReturnValueOnce(descriptorLock);
    transaction.insert = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);
    const bound: ConsoleLoginTransaction = {
      ...loginTransaction(),
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
      integrationDescriptorId: DESCRIPTOR_ID,
      integrationDescriptorFingerprint: integrationDescriptorRoutingFingerprint(
        integrationDescriptorRow() as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
    };

    await expect(store.create(bound)).resolves.toBeUndefined();
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      integrationDescriptorId: DESCRIPTOR_ID,
      integrationDescriptorFingerprint: bound.integrationDescriptorFingerprint,
    }));
    expect(descriptorLock.for).toHaveBeenCalledWith('key share');
    expect(principalLock.for).toHaveBeenCalledWith('update');
  });

  it('rejects a descriptor-bound flow when routing changes before the row lock is acquired', async () => {
    const chain = insertChain();
    const descriptorLock = selectingChain([
      integrationDescriptorRow({ apiHosts: ['mail.example.test'] }),
    ]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(descriptorLock);
    transaction.insert = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.create({
      ...loginTransaction(),
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
      integrationDescriptorId: DESCRIPTOR_ID,
      integrationDescriptorFingerprint: integrationDescriptorRoutingFingerprint(
        integrationDescriptorRow() as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
    })).rejects.toThrow(IntegrationDescriptorChangedError);
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('rejects an integration authorization start for an inactive principal', async () => {
    const chain = insertChain();
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.create({
      ...loginTransaction(),
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
    })).rejects.toThrow('integration principal is disabled, deleted, or missing');
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('normalizes duplicate transaction inserts to a store conflict', async () => {
    const conflict = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.reject(conflict)),
    }));
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.create(loginTransaction())).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('clones consumed encrypted transaction data returned from PostgreSQL', async () => {
    const row = { ...loginTransaction(), consumedAt: FOUR_MINUTES };
    const chain = returningChain([row]);
    transaction.select = jest.fn(() => selectingChain([loginTransaction()]));
    transaction.update = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    const returned = await store.consume(hash(3), hash(4), FOUR_MINUTES);
    returned?.stateHash.fill(0);
    returned?.pkceVerifierEnc.fill(0);

    expect(row.stateHash).toEqual(hash(4));
    expect(row.pkceVerifierEnc).toEqual(Buffer.from('ciphertext'));
    expect(chain.set).toHaveBeenCalledWith({
      consumedAt: expect.anything(),
      expiresAt: expect.anything(),
    });
    const updateSql = JSON.stringify(chain.set.mock.calls[0]?.[0]);
    expect(updateSql).toContain('statement_timestamp()');
    expect(updateSql).toContain(String(CONSUMED_TRANSACTION_COMPLETION_LEASE_MS));
  });

  it('locks the active principal before consuming an integration callback', async () => {
    const row = {
      ...loginTransaction(),
      flowKind: 'integration_link' as const,
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
      consumedAt: FOUR_MINUTES,
    };
    const principalLock = selectingChain([{ id: USER_ID }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([row]))
      .mockReturnValueOnce(principalLock);
    transaction.update = jest.fn(() => returningChain([row]));
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.consume(hash(3), hash(4), FOUR_MINUTES)).resolves.toMatchObject({
      flowKind: 'integration_link',
      userId: USER_ID,
    });
    expect(principalLock.for).toHaveBeenCalledWith('update');
  });

  it('does not consume an integration callback after its principal is inactive', async () => {
    const candidate = {
      ...loginTransaction(),
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
    } as ConsoleLoginTransaction;
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([candidate]))
      .mockReturnValueOnce(selectingChain([]));
    transaction.update = jest.fn();
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.consume(hash(3), hash(4), FOUR_MINUTES)).resolves.toBeNull();
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('marks a consumed callback complete without losing replay diagnostics', async () => {
    const chain = returningChain([{ idHash: hash(3) }]);
    transaction.update = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.completeConsumed(hash(3))).resolves.toBe(true);
    expect(chain.set).toHaveBeenCalledWith({
      expiresAt: expect.anything(),
    });
  });

  it('deletes consumed or expired transient transaction rows', async () => {
    const chain = returningChain([{ idHash: hash(3) }]);
    transaction.delete = jest.fn(() => chain);
    const store = new PostgresLoginTransactionStore({} as DatabaseInstance);

    await expect(store.sweepExpired(FIVE_MINUTES)).resolves.toBe(1);
    expect(chain.where).toHaveBeenCalledWith(expect.anything());
    expect(inspect(chain.where.mock.calls[0]?.[0], { depth: 12 })).toContain('statement_timestamp()');
  });
});

describe('PostgresUserIntegrationStore', () => {
  it('captures static credential operation order from PostgreSQL time', async () => {
    transaction.execute = jest.fn(() => Promise.resolve([{ operation_started_at: NOW }]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.captureCredentialOperationStartedAt(BEFORE_NOW)).resolves.toEqual(NOW);
    expect(sqlText(0)).toContain('statement_timestamp()');
  });

  it('persists the descriptor binding with configured-provider credentials', async () => {
    const inserted = userIntegrationRow({
      provider: 'linear',
      integrationDescriptorId: DESCRIPTOR_ID,
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
    });
    const insert = insertChain([inserted]);
    transaction.update = jest.fn(() => returningChain([]));
    transaction.insert = jest.fn(() => insert);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connect({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: DESCRIPTOR_ID,
      externalAccountLabel: 'alice',
      externalInstallationId: null,
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('encrypted-access-token'),
      refreshTokenCiphertext: null,
      connectedAt: NOW,
    })).resolves.toMatchObject({ integrationDescriptorId: DESCRIPTOR_ID });
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({
      integrationDescriptorId: DESCRIPTOR_ID,
    }));
  });

  it('atomically verifies a consumed descriptor callback before persisting credentials', async () => {
    const descriptorRow = integrationDescriptorRow();
    const descriptorLock = selectingChain([descriptorRow]);
    const callbackLock = selectingChain([{ idHash: hash(3), createdAt: NOW, consumedAt: NOW }]);
    const lifecycleLock = selectingChain([{ id: USER_ID }]);
    const pendingCleanup = selectingChain([]);
    const activeLock = selectingChain([]);
    const latestAuthorization = selectingChain([]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(lifecycleLock)
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(callbackLock)
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(pendingCleanup)
      .mockReturnValueOnce(activeLock)
      .mockReturnValueOnce(latestAuthorization);
    const revokeExisting = returningChain([]);
    const completeCallback = returningChain([{ idHash: hash(3) }]);
    transaction.update = jest.fn()
      .mockReturnValueOnce(revokeExisting)
      .mockReturnValueOnce(completeCallback);
    transaction.insert = jest.fn(() => insertChain([userIntegrationRow({
      provider: 'gmail',
      integrationDescriptorId: DESCRIPTOR_ID,
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
    })]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        integrationDescriptorRow() as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'alice@example.test',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: NOW,
      },
    })).resolves.toMatchObject({
      provider: 'gmail',
      integrationDescriptorId: DESCRIPTOR_ID,
    });
    expect(descriptorLock.for).toHaveBeenCalledWith('update');
    expect(callbackLock.for).toHaveBeenCalledWith('update');
    expect(lifecycleLock.for).toHaveBeenCalledWith('update');
    expect(completeCallback.set).toHaveBeenCalledWith({ expiresAt: NOW });
    expect(collectStrings(callbackLock.where.mock.calls[0]?.[0])).toContain(' > statement_timestamp()');
    expect(collectStrings(completeCallback.where.mock.calls[0]?.[0])).toContain(' > statement_timestamp()');
    expect(collectStrings(transaction.select.mock.results[4]?.value.where.mock.calls[0]?.[0])).toContain(' <> ');
  });

  it('rejects callback persistence when the principal is no longer active', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn(() => insertChain([userIntegrationRow()]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: null,
      descriptorFingerprint: null,
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'github',
        integrationDescriptorId: null,
        externalAccountLabel: 'alice',
        externalInstallationId: null,
        authorizedPermissions: { repository_selection: 'selected', permissions: { contents: 'read' } },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: NOW,
      },
    })).resolves.toBeNull();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rolls back descriptor callback credentials if the completion lease expires before the final write', async () => {
    const descriptorRow = integrationDescriptorRow();
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(selectingChain([{ idHash: hash(3), createdAt: NOW, consumedAt: NOW }]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]));
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]));
    transaction.insert = jest.fn(() => insertChain([userIntegrationRow({
      provider: 'gmail',
      integrationDescriptorId: DESCRIPTOR_ID,
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
    })]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        descriptorRow as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'alice@example.test',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: NOW,
      },
    })).resolves.toBeNull();
  });

  it('rejects an older callback when a newer authorization already owns the active credential', async () => {
    const newerAuthorization = new Date(NOW.getTime() + 1_000);
    const callbackLock = selectingChain([{ idHash: hash(3), createdAt: NOW, consumedAt: NOW }]);
    const lifecycleLock = selectingChain([{ id: USER_ID }]);
    const pendingCleanup = selectingChain([]);
    const activeLock = selectingChain([{
      authorizationStartedAt: newerAuthorization,
      connectedAt: new Date(NOW.getTime() + 2_000),
    }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(lifecycleLock)
      .mockReturnValueOnce(callbackLock)
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(pendingCleanup)
      .mockReturnValueOnce(activeLock)
      .mockReturnValueOnce(selectingChain([{
        authorizationStartedAt: newerAuthorization,
        connectedAt: new Date(NOW.getTime() + 2_000),
      }]));
    transaction.update = jest.fn();
    transaction.insert = jest.fn();
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: null,
      descriptorFingerprint: null,
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'github',
        integrationDescriptorId: null,
        externalAccountLabel: 'alice',
        externalInstallationId: null,
        authorizedPermissions: {
          repository_selection: 'unknown',
          permissions: { contents: 'read' },
        },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: new Date(NOW.getTime() + 3_000),
      },
    })).resolves.toBeNull();
    expect(lifecycleLock.for).toHaveBeenCalledWith('update');
    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects an older callback while a newer authorization is still pending', async () => {
    const callbackLock = selectingChain([{ idHash: hash(3), createdAt: NOW, consumedAt: NOW }]);
    const lifecycleLock = selectingChain([{ id: USER_ID }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(lifecycleLock)
      .mockReturnValueOnce(callbackLock)
      .mockReturnValueOnce(selectingChain([{ idHash: hash(4) }]));
    transaction.update = jest.fn();
    transaction.insert = jest.fn();
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: null,
      descriptorFingerprint: null,
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'github',
        integrationDescriptorId: null,
        externalAccountLabel: 'alice',
        externalInstallationId: null,
        authorizedPermissions: {
          repository_selection: 'unknown',
          permissions: { contents: 'read' },
        },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: new Date(NOW.getTime() + 2_000),
      },
    })).resolves.toBeNull();
    expect(lifecycleLock.for).toHaveBeenCalledWith('update');
    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects descriptor callback persistence after routing changes', async () => {
    const changedDescriptor = integrationDescriptorRow({ apiHosts: ['mail.example.test'] });
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([changedDescriptor]))
      .mockReturnValueOnce(selectingChain([changedDescriptor]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCallback({
      transactionIdHash: hash(3),
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        integrationDescriptorRow() as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      authorizationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'alice@example.test',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
        accessTokenCiphertext: Buffer.from('encrypted-access-token'),
        refreshTokenCiphertext: null,
        connectedAt: NOW,
      },
    })).resolves.toBeNull();
    expect(transaction.insert).toBeUndefined();
  });

  it('atomically verifies a static credential descriptor before persisting it', async () => {
    const descriptorRow = integrationDescriptorRow({
      authStrategy: 'static_api_key',
      oauth: null,
      staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
      clientSecretCiphertext: null,
      clientSecretRevision: null,
      credentialKeyVersion: null,
    });
    const descriptorLock = selectingChain([descriptorRow]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]));
    transaction.update = jest.fn(() => returningChain([]));
    transaction.insert = jest.fn(() => insertChain([userIntegrationRow({
      provider: 'gmail',
      integrationDescriptorId: DESCRIPTOR_ID,
      authorizedPermissions: { scopes: [] },
      refreshTokenCiphertext: null,
    })]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCredential({
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        descriptorRow as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      operationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'static credential',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: Buffer.from('encrypted-api-key'),
        refreshTokenCiphertext: null,
        connectedAt: NOW,
      },
    })).resolves.toMatchObject({ integrationDescriptorId: DESCRIPTOR_ID });
    expect(descriptorLock.for).toHaveBeenCalledWith('update');
  });

  it('rejects a static credential superseded by a newer disconnect tombstone', async () => {
    const descriptorRow = integrationDescriptorRow({
      authStrategy: 'static_api_key',
      oauth: null,
      staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
      clientSecretCiphertext: null,
      clientSecretRevision: null,
      credentialKeyVersion: null,
    });
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{ authorizationStartedAt: FIVE_MINUTES, connectedAt: null }]));
    transaction.update = jest.fn();
    transaction.insert = jest.fn();
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCredential({
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        descriptorRow as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      operationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'static credential',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: Buffer.from('encrypted-api-key'),
        refreshTokenCiphertext: null,
        authorizationStartedAt: NOW,
        connectedAt: FIVE_MINUTES,
      },
    })).resolves.toBeNull();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('rejects credential persistence after a curated provider is disabled', async () => {
    const descriptorRow = integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
      authStrategy: 'static_api_key',
      oauth: null,
      staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
      clientSecretCiphertext: null,
      clientSecretRevision: null,
      credentialKeyVersion: null,
    });
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: USER_ID }]))
      .mockReturnValueOnce(selectingChain([descriptorRow]))
      .mockReturnValueOnce(selectingChain([{ enabled: false }]))
      .mockReturnValueOnce(selectingChain([descriptorRow]));
    transaction.update = jest.fn();
    transaction.insert = jest.fn();
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.connectDescriptorCredential({
      descriptorId: DESCRIPTOR_ID,
      descriptorFingerprint: integrationDescriptorRoutingFingerprint(
        descriptorRow as Parameters<typeof integrationDescriptorRoutingFingerprint>[0],
      ),
      operationStartedAt: NOW,
      connection: {
        userId: USER_ID,
        provider: 'gmail',
        integrationDescriptorId: DESCRIPTOR_ID,
        externalAccountLabel: 'static credential',
        externalInstallationId: null,
        authorizedPermissions: { scopes: [] },
        accessTokenCiphertext: Buffer.from('encrypted-api-key'),
        refreshTokenCiphertext: null,
        authorizationStartedAt: NOW,
        connectedAt: FIVE_MINUTES,
      },
    })).resolves.toBeNull();
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('renews credential cleanup ownership with the same fenced lease', async () => {
    const lifecycleLock = selectingChain([{ id: USER_ID }]);
    const renewal = returningChain([{ id: INTEGRATION_ID }]);
    transaction.select = jest.fn(() => lifecycleLock);
    transaction.update = jest.fn(() => renewal);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);
    const cleanupLeaseId = '65e22a52-dc56-4cd0-9d13-b2802524fbd3';

    await expect(store.renewCredentialCleanupClaim({
      userId: USER_ID,
      provider: 'github',
      integrationId: INTEGRATION_ID,
      credentialGeneration: 3,
      cleanupLeaseId,
      leaseDurationMs: 60_000,
    })).resolves.toBe(true);

    expect(lifecycleLock.for).toHaveBeenCalledWith('update');
    expect([...collectStrings(renewal.set.mock.calls[0]?.[0])].join(' ')).toContain('statement_timestamp()');
    const predicate = collectStrings(renewal.where.mock.calls[0]?.[0]);
    expect(predicate).toContain('cleanup_pending');
    expect(predicate).toContain(cleanupLeaseId);
    expect(predicate).toContain('credential_generation');
  });

  it('retains the descriptor binding while refreshing configured-provider credentials', async () => {
    const current = userIntegrationRow({
      provider: 'linear',
      integrationDescriptorId: DESCRIPTOR_ID,
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshTokenCiphertext: Buffer.from('encrypted-refresh-token'),
    });
    transaction.select = jest.fn(() => selectingChain([current]));
    const refreshed = userIntegrationRow({
      ...current,
      accessTokenCiphertext: Buffer.from('refreshed-access-token'),
    });
    transaction.update = jest.fn(() => returningChain([refreshed]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: DESCRIPTOR_ID,
      staleAccessTokenCiphertext: current.accessTokenCiphertext ?? Buffer.alloc(0),
      staleCredentialGeneration: current.credentialGeneration,
      staleAuthorizedPermissions: current.authorizedPermissions,
      refreshedAt: NOW,
      refresh: record => {
        expect(record.integrationDescriptorId).toBe(DESCRIPTOR_ID);
        return Promise.resolve({
          kind: 'refreshed',
          accessTokenCiphertext: Buffer.from('refreshed-access-token'),
          refreshTokenCiphertext: record.refreshTokenCiphertext,
        });
      },
    })).resolves.toMatchObject({
      kind: 'refreshed',
      record: { integrationDescriptorId: DESCRIPTOR_ID },
    });
  });

  it('lists active user integrations and clones credential ciphertext', async () => {
    const row = userIntegrationRow();
    const chain = selectingChain([row]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    const rows = await store.listByUser(USER_ID);
    rows[0]?.accessTokenCiphertext?.fill(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: row.id,
      userId: USER_ID,
      provider: 'github',
      externalAccountLabel: 'alice',
    });
    expect(row.accessTokenCiphertext).toEqual(Buffer.from('encrypted-access-token'));
    expect(chain.limit).toHaveBeenCalledWith(25);
  });

  it('finds one active provider integration for a user', async () => {
    const chain = selectingChain([userIntegrationRow()]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.findByProvider(USER_ID, 'github')).resolves.toMatchObject({
      provider: 'github',
      userId: USER_ID,
    });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('maps generic provider integrations with scopes-only permission details', async () => {
    const chain = selectingChain([userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
    })]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.findByProvider(USER_ID, 'linear')).resolves.toMatchObject({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
    });
  });

  it('uses scopes-only default permissions for generic provider error rows', async () => {
    transaction.update = jest.fn(() => returningChain([{ id: INTEGRATION_ID }]));
    transaction.insert = jest.fn((table) => insertChain([{
      ...userIntegrationRow({
        provider: 'linear',
        authorizedPermissions: { scopes: [] },
        status: 'error',
        errorReason: 'provider_unavailable',
        accessTokenCiphertext: null,
        refreshTokenCiphertext: null,
        connectedAt: null,
      }),
      table,
    }]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.recordError({
      userId: USER_ID,
      provider: 'linear',
      integrationId: INTEGRATION_ID,
      credentialGeneration: 0,
      errorReason: 'provider_unavailable',
      occurredAt: NOW,
    })).resolves.toMatchObject({
      provider: 'linear',
      authorizedPermissions: { scopes: [] },
      status: 'error',
    });
  });

  it('preserves credential material for cleanup when revoking a withdrawn descriptor', async () => {
    const chain = returningChain([{ id: INTEGRATION_ID }, { id: '45e22a52-dc56-4cd0-9d13-b2802524fbd4' }]);
    transaction.update = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.revokeAllByDescriptor(DESCRIPTOR_ID, FIVE_MINUTES)).resolves.toBe(2);
    expect(chain.set).toHaveBeenCalledWith({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
      refreshFence: expect.anything(),
      status: expect.anything(),
      errorReason: expect.anything(),
      revokedAt: FIVE_MINUTES,
    });
  });

  it('updates refreshed credentials with a stale-token compare-and-swap', async () => {
    const claimed = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stale-access'),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
      refreshFence: 1,
      refreshLeaseId: '65e22a52-dc56-4cd0-9d13-b2802524fbd3',
      refreshLeaseExpiresAt: FIVE_MINUTES,
    });
    const updated = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
      credentialKeyVersion: 'integration-key-v2',
      credentialGeneration: 1,
    });
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([claimed]))
      .mockReturnValueOnce(returningChain([updated]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({
        kind: 'refreshed' as const,
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
        refreshTokenCiphertext: Buffer.from('fresh-refresh'),
        credentialKeyVersion: 'integration-key-v2',
      }),
    })).resolves.toMatchObject({
      kind: 'refreshed',
      record: {
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
        credentialKeyVersion: 'integration-key-v2',
        credentialGeneration: 1,
      },
    });
    const refreshPredicate = collectStrings(transaction.update.mock.results[1]?.value.where.mock.calls[0]?.[0]);
    expect(refreshPredicate).toContain('connected');
    expect(refreshPredicate).toContain('error');
    expect(refreshPredicate).toContain('authorized_permissions');
    const claimPredicate = collectStrings(transaction.update.mock.results[0]?.value.where.mock.calls[0]?.[0]);
    expect(claimPredicate).toContain('credential_generation');
    expect(claimPredicate).toContain('authorized_permissions');
    expect(transaction.update.mock.results[1]?.value.set).toHaveBeenCalledWith(expect.objectContaining({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
      credentialGeneration: expect.anything(),
    }));
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('releases the durable refresh lease without poisoning credentials on retryable failure', async () => {
    const claimed = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stale-access'),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
      refreshFence: 4,
      refreshLeaseId: '65e22a52-dc56-4cd0-9d13-b2802524fbd3',
      refreshLeaseExpiresAt: FIVE_MINUTES,
    });
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([claimed]))
      .mockReturnValueOnce(returningChain([]));
    transaction.select = jest.fn(() => selectingChain([{
      ...claimed,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    }]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({ kind: 'retryable' as const }),
    })).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'connected', errorReason: null, credentialGeneration: 0 },
    });
    expect(transaction.update.mock.results[1]?.value.set).toHaveBeenCalledWith({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    });
  });

  it('reuses a row refreshed by an earlier caller without invoking the provider', async () => {
    transaction.select = jest.fn(() => selectingChain([userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
    })]));
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.reject(new Error('refresh should not run')),
    })).resolves.toMatchObject({
      kind: 'reused',
      record: {
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      },
    });
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it('does not restore credentials when disconnect wins during provider refresh', async () => {
    const claimed = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stale-access'),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
      refreshFence: 1,
    });
    transaction.select = jest.fn(() => selectingChain([]));
    const claim = returningChain([claimed]);
    const completion = returningChain([]);
    const release = returningChain([]);
    const cleanup = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
      revokedAt: FIVE_MINUTES,
    });
    transaction.insert = jest.fn(() => insertChain([cleanup]));
    transaction.update = jest.fn()
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(completion)
      .mockReturnValueOnce(release);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({
        kind: 'refreshed' as const,
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
        refreshTokenCiphertext: Buffer.from('fresh-refresh'),
      }),
    })).resolves.toMatchObject({
      kind: 'retryable',
      record: { status: 'cleanup_pending', accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN) },
    });
    expect(completion.where).toHaveBeenCalledWith(expect.anything());
    expect(release.set).toHaveBeenCalledWith({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    });
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });

  it('queues a valid refresh result for cleanup when its lease was replaced', async () => {
    const claimed = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stale-access'),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
      refreshFence: 1,
    });
    const cleanup = userIntegrationRow({
      ...claimed,
      accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
      status: 'cleanup_pending',
      errorReason: 'revocation_failed',
      revokedAt: FIVE_MINUTES,
    });
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([claimed]))
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]));
    transaction.insert = jest.fn(() => insertChain([cleanup]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({
        kind: 'refreshed' as const,
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
        refreshTokenCiphertext: Buffer.from('fresh-refresh'),
      }),
    })).resolves.toMatchObject({
      kind: 'retryable',
      record: {
        status: 'cleanup_pending',
        accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      },
    });
    expect(transaction.update.mock.results[2]?.value.set).toHaveBeenCalledWith(expect.objectContaining({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    }));
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });

  it('reuses a competing refresh that rotated only the refresh token', async () => {
    const winner = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stable-access'),
      refreshTokenCiphertext: Buffer.from('winner-refresh'),
      credentialGeneration: 1,
    });
    transaction.select = jest.fn(() => selectingChain([winner]));
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stable-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({
        kind: 'failed' as const,
        errorReason: 'token_refresh_failed' as const,
      }),
    })).resolves.toMatchObject({
      kind: 'reused',
      record: { refreshTokenCiphertext: Buffer.from('winner-refresh') },
    });
  });

  it('fails after bounded retries while another replica owns the refresh lease', async () => {
    const leased = userIntegrationRow({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from('stale-access'),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
      refreshLeaseId: '65e22a52-dc56-4cd0-9d13-b2802524fbd3',
      refreshLeaseExpiresAt: ONE_HOUR,
    });
    transaction.update = jest.fn(() => returningChain([]));
    transaction.select = jest.fn(() => selectingChain([leased]));
    const refresh = jest.fn(() => Promise.resolve({
      kind: 'refreshed' as const,
      accessTokenCiphertext: Buffer.from(FRESH_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
    }));
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from('stale-access'),
      staleCredentialGeneration: 0,
      staleAuthorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      refreshedAt: FIVE_MINUTES,
      refresh,
    })).rejects.toBeInstanceOf(IntegrationRefreshBusyError);
    expect(refresh).not.toHaveBeenCalled();
    expect(transaction.update).toHaveBeenCalledTimes(5);
    expect(transaction.select).toHaveBeenCalledTimes(10);
  });

  it('disconnects only the exact active credential id and generation', async () => {
    const chain = returningChain([]);
    transaction.update = jest.fn(() => chain);
    const store = new PostgresUserIntegrationStore({} as DatabaseInstance);

    await expect(store.disconnect({
      userId: USER_ID,
      provider: 'linear',
      integrationId: INTEGRATION_ID,
      credentialGeneration: 7,
      revokedAt: FIVE_MINUTES,
    })).resolves.toBeNull();

    const predicate = chain.where.mock.calls[0]?.[0];
    expect(collectStrings(predicate)).toContain(INTEGRATION_ID);
    expect(inspect(predicate, { depth: 12 })).toContain('credential_generation');
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
      refreshFence: expect.anything(),
      status: 'revoked',
    }));
  });
});

describe('PostgresIntegrationDescriptorStore', () => {
  it('lists visible curated and BYO descriptors and clones encrypted secrets', async () => {
    const row = integrationDescriptorRow();
    const chain = selectingChain([row]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    const rows = await store.listVisible(USER_ID);
    rows[0]?.clientSecretCiphertext?.fill(0);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'gmail',
      ownership: 'byo',
      apiHosts: ['gmail.googleapis.com'],
    });
    expect(row.clientSecretCiphertext).toEqual(Buffer.from('encrypted-client-secret'));
  });

  it('filters durably disabled curated providers in PostgreSQL visibility queries', async () => {
    const chain = selectingChain([]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await store.listVisiblePage(USER_ID);

    const predicateText = [...collectStrings(chain.where.mock.calls[0]?.[0])].join(' ');
    expect(predicateText).toContain('NOT EXISTS');
    expect(predicateText).toContain('integration_curated_provider_state');
  });

  it('keeps descriptors with legacy private suffixes readable after host hardening', async () => {
    const row = integrationDescriptorRow({
      apiHosts: ['api.company.corp'],
      oauth: {
        ...integrationDescriptorRow().oauth as Record<string, unknown>,
        authorizationUrl: 'https://auth.company.corp/authorize',
        tokenUrl: 'https://auth.company.corp/token',
      },
    });
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.listVisible(USER_ID)).resolves.toEqual([
      expect.objectContaining({ id: DESCRIPTOR_ID, apiHosts: ['api.company.corp'] }),
    ]);
  });

  it('paginates visible descriptors and encodes the next (provider, id) cursor', async () => {
    const rows = [
      integrationDescriptorRow({ provider: 'svc-a', id: '00000000-0000-4000-8000-0000000000a1' }),
      integrationDescriptorRow({ provider: 'svc-b', id: '00000000-0000-4000-8000-0000000000a2' }),
      integrationDescriptorRow({ provider: 'svc-c', id: '00000000-0000-4000-8000-0000000000a3' }),
    ];
    const chain = selectingChain(rows);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    const page = await store.listVisiblePage(USER_ID, { limit: 2 });

    // limit+1 row probing: 3 rows back for limit 2 → one more page exists.
    expect(chain.limit).toHaveBeenCalledWith(3);
    expect(page.items.map(item => item.provider)).toEqual(['svc-a', 'svc-b']);
    expect(page.nextCursor).toBe('svc-b:00000000-0000-4000-8000-0000000000a2');
  });

  it('applies a keyset WHERE predicate carrying the decoded cursor', async () => {
    // Guards the keyset clause itself: without this, the gt/and/or predicate
    // could be deleted from the query and only the chain-mock happy path (which
    // ignores WHERE) would still pass — silently returning duplicate/missing
    // rows on page 2+. Assert the decoded cursor's provider AND id reach the
    // WHERE expression.
    const chain = selectingChain([integrationDescriptorRow()]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);
    const cursorId = '00000000-0000-4000-8000-0000000000a2';

    await store.listVisiblePage(USER_ID, { limit: 2, cursor: `svc-b:${cursorId}` });

    // Drizzle holds bound params inside the expression tree (not via
    // JSON.stringify); collect every string value reachable from the WHERE arg.
    const literals = collectStrings(chain.where.mock.calls[0]?.[0]);
    expect(literals).toContain('svc-b');
    expect(literals).toContain(cursorId);

    // And the no-cursor case's WHERE must NOT carry a cursor value (proves the
    // keyset branch is genuinely conditional, not always appended).
    const plainChain = selectingChain([integrationDescriptorRow()]);
    transaction.select = jest.fn(() => plainChain);
    await store.listVisiblePage(USER_ID, { limit: 2 });
    expect(collectStrings(plainChain.where.mock.calls[0]?.[0])).not.toContain('svc-b');
  });

  it('rejects invalid pagination limits and cursors before querying', async () => {
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.listVisiblePage(USER_ID, { limit: 0 })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { limit: 101 })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { cursor: 'garbage' })).rejects.toThrow(ConsoleStoreValidationError);
    expect(transaction.select).not.toHaveBeenCalled();
  });

  it('upserts descriptors by owner/provider identity', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn(() => insertChain([integrationDescriptorRow()]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput())).resolves.toMatchObject({
      provider: 'gmail',
      ownerUserId: USER_ID,
    });
  });

  it('retries a concurrent first-seed unique race and updates the winning row', async () => {
    const unique = Object.assign(new Error('duplicate descriptor identity'), { code: '23505' });
    const winning = integrationDescriptorRow();
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([winning]));
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    transaction.update = jest.fn(() => returningChain([winning]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput())).resolves.toMatchObject({
      id: DESCRIPTOR_ID,
      provider: 'gmail',
    });
    expect(transaction.select).toHaveBeenCalledTimes(2);
    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it('invalidates callbacks and credentialless bindings before routing mutation', async () => {
    const descriptorLock = selectingChain([integrationDescriptorRow()]);
    const callbackLocks = selectingForUpdateChain([]);
    const credentialBindings = selectingChain([]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(callbackLocks)
      .mockReturnValueOnce(credentialBindings);
    const invalidateCredentials = returningChain([]);
    const updateDescriptor = returningChain([
      integrationDescriptorRow({ apiHosts: ['mail.example.test'] }),
    ]);
    transaction.delete = jest.fn(() => deletingChain());
    transaction.update = jest.fn()
      .mockReturnValueOnce(invalidateCredentials)
      .mockReturnValueOnce(updateDescriptor);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({ apiHosts: ['mail.example.test'] })))
      .resolves.toMatchObject({ apiHosts: ['mail.example.test'] });
    expect(descriptorLock.for).toHaveBeenCalledWith('update');
    expect(callbackLocks.for).toHaveBeenCalledWith('update');
    expect(transaction.delete).toHaveBeenCalledTimes(1);
    expect(invalidateCredentials.set).toHaveBeenCalledWith(expect.objectContaining({
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
      status: 'revoked',
      errorReason: null,
      revokedAt: new Date(NOW.getTime() + 1),
    }));
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('refuses routing mutation while a binding still holds revocable credentials', async () => {
    const descriptorLock = selectingChain([integrationDescriptorRow()]);
    const callbackLocks = selectingForUpdateChain([]);
    const credentialBindings = selectingChain([{ id: INTEGRATION_ID }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(callbackLocks)
      .mockReturnValueOnce(credentialBindings);
    transaction.delete = jest.fn(() => deletingChain());
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({ apiHosts: ['mail.example.test'] })))
      .rejects.toMatchObject({ name: 'IntegrationDescriptorMutationBusyError' });
    expect(descriptorLock.for).toHaveBeenCalledWith('update');
    expect(callbackLocks.for).toHaveBeenCalledWith('update');
    expect(credentialBindings.for).toHaveBeenCalledWith('update');
    expect(transaction.update).toBeUndefined();
  });

  it('permits display-only descriptor edits without consulting callback leases', async () => {
    const updated = integrationDescriptorRow({ displayName: 'Updated Gmail' });
    transaction.select = jest.fn(() => selectingChain([integrationDescriptorRow()]));
    transaction.update = jest.fn(() => returningChain([updated]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({ displayName: 'Updated Gmail' })))
      .resolves.toMatchObject({ displayName: 'Updated Gmail' });
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it('rejects a descriptor update prepared from a stale revision', async () => {
    const current = integrationDescriptorRow({ updatedAt: FIVE_MINUTES });
    transaction.select = jest.fn(() => selectingChain([current]));
    transaction.update = jest.fn();
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(
      integrationDescriptorInput({ displayName: 'Stale name' }),
      { expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ name: 'IntegrationDescriptorRevisionConflictError' });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('does not recreate a descriptor deleted after PATCH read its revision', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn();
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(
      integrationDescriptorInput({ displayName: 'Stale name' }),
      { expectedUpdatedAt: NOW },
    )).rejects.toMatchObject({ name: 'IntegrationDescriptorRevisionConflictError' });
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('advances the descriptor revision when caller and current timestamps are equal', async () => {
    const current = integrationDescriptorRow({ updatedAt: NOW });
    const update = returningChain([integrationDescriptorRow({
      displayName: 'Updated Gmail',
      updatedAt: new Date(NOW.getTime() + 1),
    })]);
    transaction.select = jest.fn(() => selectingChain([current]));
    transaction.update = jest.fn(() => update);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(
      integrationDescriptorInput({ displayName: 'Updated Gmail', updatedAt: NOW }),
      { expectedUpdatedAt: NOW },
    )).resolves.toMatchObject({ updatedAt: new Date(NOW.getTime() + 1) });
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({
      updatedAt: new Date(NOW.getTime() + 1),
    }));
  });

  it('permits at-rest client-secret rewraps without invalidating descriptor bindings', async () => {
    const updated = integrationDescriptorRow({
      clientSecretCiphertext: Buffer.from('rewrapped-client-secret'),
      credentialKeyVersion: 'integration-key-v2',
    });
    transaction.select = jest.fn(() => selectingChain([integrationDescriptorRow()]));
    transaction.update = jest.fn(() => returningChain([updated]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({
      clientSecretCiphertext: Buffer.from('rewrapped-client-secret'),
      credentialKeyVersion: 'integration-key-v2',
    }))).resolves.toMatchObject({ credentialKeyVersion: 'integration-key-v2' });
    expect(transaction.delete).toBeUndefined();
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it('initializes only a proven-equal legacy secret revision without invalidating bindings', async () => {
    const legacy = integrationDescriptorRow({ clientSecretRevision: null });
    const initializedRevision = '00000000-0000-8000-8000-000000000202';
    transaction.select = jest.fn(() => selectingChain([legacy]));
    transaction.update = jest.fn(() => returningChain([
      integrationDescriptorRow({ clientSecretRevision: initializedRevision }),
    ]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(
      integrationDescriptorInput({ clientSecretRevision: initializedRevision }),
      { initializeClientSecretRevision: true },
    )).resolves.toMatchObject({ clientSecretRevision: initializedRevision });
    expect(transaction.delete).toBeUndefined();
    expect(transaction.update).toHaveBeenCalledTimes(1);
  });

  it('does not let revision initialization suppress another routing change', async () => {
    const legacy = integrationDescriptorRow({ clientSecretRevision: null });
    const initializedRevision = '00000000-0000-8000-8000-000000000202';
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([legacy]))
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingChain([]));
    transaction.delete = jest.fn(() => deletingChain());
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([
        integrationDescriptorRow({
          apiHosts: ['rotated.example.com'],
          clientSecretRevision: initializedRevision,
        }),
      ]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(
      integrationDescriptorInput({
        apiHosts: ['rotated.example.com'],
        clientSecretRevision: initializedRevision,
      }),
      { initializeClientSecretRevision: true },
    )).resolves.toMatchObject({ clientSecretRevision: initializedRevision });
    expect(transaction.delete).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('invalidates descriptor bindings when the logical client-secret revision changes', async () => {
    const descriptorLock = selectingChain([integrationDescriptorRow()]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingChain([]));
    const invalidateCredentials = returningChain([]);
    const updateDescriptor = returningChain([
      integrationDescriptorRow({ clientSecretRevision: '00000000-0000-4000-8000-000000000202' }),
    ]);
    transaction.delete = jest.fn(() => deletingChain());
    transaction.update = jest.fn()
      .mockReturnValueOnce(invalidateCredentials)
      .mockReturnValueOnce(updateDescriptor);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({
      clientSecretRevision: '00000000-0000-4000-8000-000000000202',
    }))).resolves.toMatchObject({
      clientSecretRevision: '00000000-0000-4000-8000-000000000202',
    });
    expect(transaction.delete).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('rejects descriptor inputs before writing', async () => {
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({
      apiHosts: ['127.0.0.1'],
    }))).rejects.toThrow(ConsoleStoreValidationError);
    expect(transaction.insert).toBeUndefined();
  });

  it('finds descriptors by id only for the BYO owner', async () => {
    const chain = selectingChain([integrationDescriptorRow()]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.findById(DESCRIPTOR_ID, USER_ID)).resolves.toMatchObject({
      id: DESCRIPTOR_ID,
      ownership: 'byo',
      ownerUserId: USER_ID,
    });
    await expect(store.findById('not-a-uuid', USER_ID)).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.findById(DESCRIPTOR_ID, 'not-a-uuid')).rejects.toThrow(ConsoleStoreValidationError);
  });

  it('finds only deployment-owned curated descriptors by provider', async () => {
    const chain = selectingChain([integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
    })]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.findCuratedByProvider('gmail')).resolves.toMatchObject({
      provider: 'gmail',
      ownership: 'curated',
      ownerUserId: null,
    });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it('deletes descriptors owner-scoped and reports whether a row was removed', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{
        provider: 'gmail',
        ownership: 'byo',
        ownerUserId: USER_ID,
      }]))
      .mockReturnValueOnce(selectingChain([{ id: DESCRIPTOR_ID }]))
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingChain([]));
    transaction.delete = jest.fn(() => deletingChain([{ id: DESCRIPTOR_ID }]));
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.delete(DESCRIPTOR_ID, USER_ID)).resolves.toBe(true);
    expect(transaction.delete).toHaveBeenCalledTimes(2);
    expect(transaction.update).toHaveBeenCalledTimes(1);

    transaction.select = jest.fn(() => selectingChain([]));
    transaction.delete = jest.fn(() => deletingChain([]));
    await expect(store.delete(DESCRIPTOR_ID, USER_ID)).resolves.toBe(false);
    await expect(store.delete('not-a-uuid', USER_ID)).rejects.toThrow(ConsoleStoreValidationError);
  });

  it('refuses routing mutation while a consumed callback owns its completion lease', async () => {
    const descriptorLock = selectingChain([integrationDescriptorRow()]);
    const callbackLocks = selectingForUpdateChain([{ consumedAt: NOW }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(callbackLocks);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({
      apiHosts: ['mail.example.test'],
    }))).rejects.toMatchObject({ name: 'IntegrationDescriptorMutationBusyError' });
    expect(transaction.delete).toBeUndefined();
    expect(transaction.update).toBeUndefined();
  });

  it('takes the canonical descriptor identity lock before a first BYO insert', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn(() => insertChain([integrationDescriptorRow()]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput())).resolves.toMatchObject({
      id: DESCRIPTOR_ID,
    });

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(inspect(transaction.execute.mock.calls[0]?.[0], { depth: 12 }))
      .toContain(`integration-descriptor:byo:${USER_ID}:gmail`);
  });

  it('atomically retains a newer curated seed revision from another replica', async () => {
    const current = integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
      curatedSeedRevision: 2,
      apiHosts: ['current.example.test'],
    });
    transaction.select = jest.fn(() => selectingChain([current]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.upsert(integrationDescriptorInput({
      ownership: 'curated',
      ownerUserId: null,
      curatedSeedRevision: 1,
      apiHosts: ['stale.example.test'],
    }))).resolves.toMatchObject({
      curatedSeedRevision: 2,
      apiHosts: ['current.example.test'],
    });
    expect(transaction.delete).toBeUndefined();
    expect(transaction.update).toBeUndefined();
  });

  it('durably disables a curated provider without deleting its descriptor or user credentials', async () => {
    const descriptor = integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
      curatedSeedRevision: 1,
    });
    const stateLock = selectingChain([]);
    const descriptorLock = selectingChain([descriptor]);
    const callbackLock = selectingForUpdateChain([]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(stateLock)
      .mockReturnValueOnce(descriptorLock)
      .mockReturnValueOnce(callbackLock);
    transaction.delete = jest.fn(() => deletingChain());
    const stateInsert = insertChain();
    transaction.insert = jest.fn(() => stateInsert);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.reconcileCuratedSeed({
      provider: 'gmail',
      seedRevision: 2,
      enabled: false,
      updatedAt: NOW,
    })).resolves.toEqual({
      applied: true,
      enabled: false,
      seedRevision: 2,
      descriptor: null,
    });

    expect(transaction.execute).toHaveBeenCalledTimes(1);
    expect(inspect(transaction.execute.mock.calls[0]?.[0], { depth: 12 }))
      .toContain('integration-descriptor:curated:gmail');
    expect(stateLock.for).toHaveBeenCalledWith('update');
    expect(descriptorLock.for).toHaveBeenCalledWith('update');
    expect(callbackLock.for).toHaveBeenCalledWith('update');
    expect(stateInsert.values).toHaveBeenCalledWith({
      provider: 'gmail',
      seedRevision: 2,
      enabled: false,
      updatedAt: NOW,
    });
    expect(transaction.update).toBeUndefined();
    expect(transaction.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer disabled state when a stale replica attempts to re-enable', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([curatedProviderStateRow({ seedRevision: 3 })]))
      .mockReturnValueOnce(selectingChain([integrationDescriptorRow({
        ownership: 'curated',
        ownerUserId: null,
        curatedSeedRevision: 1,
      })]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.reconcileCuratedSeed({
      provider: 'gmail',
      seedRevision: 2,
      enabled: true,
      descriptor: integrationDescriptorInput({
        ownership: 'curated',
        ownerUserId: null,
        curatedSeedRevision: 2,
      }),
      updatedAt: NOW,
    })).resolves.toEqual({
      applied: false,
      enabled: false,
      seedRevision: 3,
      descriptor: null,
    });
    expect(transaction.insert).toBeUndefined();
    expect(transaction.update).toBeUndefined();
    expect(transaction.delete).toBeUndefined();
  });

  it('rejects a same-revision contradiction instead of re-enabling', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([curatedProviderStateRow()]))
      .mockReturnValueOnce(selectingChain([integrationDescriptorRow({
        ownership: 'curated',
        ownerUserId: null,
        curatedSeedRevision: 1,
      })]));
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.reconcileCuratedSeed({
      provider: 'gmail',
      seedRevision: 2,
      enabled: true,
      descriptor: integrationDescriptorInput({
        ownership: 'curated',
        ownerUserId: null,
        curatedSeedRevision: 2,
      }),
      updatedAt: NOW,
    })).rejects.toMatchObject({ name: 'CuratedIntegrationSeedConflictError' });
    expect(transaction.insert).toBeUndefined();
    expect(transaction.update).toBeUndefined();
    expect(transaction.delete).toBeUndefined();
  });

  it('re-enables with a newer valid revision while preserving existing user credentials', async () => {
    const existing = integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
      curatedSeedRevision: 2,
    });
    const reenabled = integrationDescriptorRow({
      ownership: 'curated',
      ownerUserId: null,
      curatedSeedRevision: 3,
    });
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([curatedProviderStateRow()]))
      .mockReturnValueOnce(selectingChain([existing]));
    const descriptorUpdate = returningChain([reenabled]);
    const stateUpdate = returningChain([]);
    transaction.update = jest.fn()
      .mockReturnValueOnce(descriptorUpdate)
      .mockReturnValueOnce(stateUpdate);
    const store = new PostgresIntegrationDescriptorStore({} as DatabaseInstance);

    await expect(store.reconcileCuratedSeed({
      provider: 'gmail',
      seedRevision: 3,
      enabled: true,
      descriptor: integrationDescriptorInput({
        ownership: 'curated',
        ownerUserId: null,
        curatedSeedRevision: 3,
      }),
      updatedAt: NOW,
    })).resolves.toMatchObject({
      applied: true,
      enabled: true,
      seedRevision: 3,
      descriptor: { curatedSeedRevision: 3 },
    });
    expect(descriptorUpdate.set).toHaveBeenCalled();
    expect(stateUpdate.set).toHaveBeenCalledWith({
      seedRevision: 3,
      enabled: true,
      updatedAt: NOW,
    });
    expect(transaction.delete).toBeUndefined();
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });
});

describe('PostgresIntegrationOpenApiSpecStore', () => {
  it('finds specs by descriptor id and clones JSON content', async () => {
    const row = openApiSpecRow();
    const chain = selectingChain([row]);
    transaction.select = jest.fn(() => chain);
    const store = new PostgresIntegrationOpenApiSpecStore({} as DatabaseInstance);

    const found = await store.findByDescriptorId(DESCRIPTOR_ID);
    (found?.spec.paths as Record<string, unknown>).tampered = true;

    expect(found).toMatchObject({
      descriptorId: DESCRIPTOR_ID,
      specHash: SPEC_HASH,
    });
    expect(row.spec).toEqual({ openapi: '3.1.0', paths: {} });
  });

  it('upserts OpenAPI specs by descriptor id', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn(() => insertChain([openApiSpecRow()]));
    const store = new PostgresIntegrationOpenApiSpecStore({} as DatabaseInstance);

    await expect(store.upsert(openApiSpecInput())).resolves.toMatchObject({
      descriptorId: DESCRIPTOR_ID,
      specHash: SPEC_HASH,
    });
  });

  it('rejects invalid specs before writing', async () => {
    const store = new PostgresIntegrationOpenApiSpecStore({} as DatabaseInstance);

    await expect(store.upsert(openApiSpecInput({
      spec: { openapi: '3.1.0' },
    }))).rejects.toThrow(ConsoleStoreValidationError);
    expect(transaction.insert).toBeUndefined();
  });

  it('deletes specs by descriptor id and reports whether one existed', async () => {
    transaction.delete = jest.fn(() => deletingChain([{ id: SPEC_ID }]));
    const store = new PostgresIntegrationOpenApiSpecStore({} as DatabaseInstance);

    await expect(store.deleteByDescriptorId(DESCRIPTOR_ID)).resolves.toBe(true);

    transaction.delete = jest.fn(() => deletingChain([]));
    await expect(store.deleteByDescriptorId(DESCRIPTOR_ID)).resolves.toBe(false);
    await expect(store.deleteByDescriptorId('not-a-uuid')).rejects.toThrow(ConsoleStoreValidationError);
  });
});

describe('PostgresPortfolioSyncJobStore', () => {
  it('creates and finds owner-scoped portfolio sync jobs', async () => {
    const row = portfolioSyncJobRow();
    transaction.insert = jest.fn(() => insertChain([row]));
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.create({
      userId: USER_ID,
      integrationId: row.integrationId,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    })).resolves.toMatchObject({
      id: row.id,
      userId: USER_ID,
      status: 'queued',
    });
    await expect(store.findById(USER_ID, row.id)).resolves.toMatchObject({
      id: row.id,
      userId: USER_ID,
    });
  });

  it('maps pending-job unique violations to an already-pending error', async () => {
    transaction.insert = jest.fn(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.create({
      userId: USER_ID,
      integrationId: INTEGRATION_ID,
      direction: 'pull',
      conflictPolicy: 'fail',
      createdAt: NOW,
    })).rejects.toThrow(PortfolioSyncAlreadyPendingError);
  });

  it('claims queued jobs with one atomic skip-locked update', async () => {
    const running = portfolioSyncJobRow({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      attemptCount: 1,
      startedAt: NOW,
    });
    transaction.execute = jest.fn(() => Promise.resolve([running]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.claimNext({
      workerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      now: NOW,
    })).resolves.toMatchObject({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
    });
    expect(transaction.execute).toHaveBeenCalledWith(expect.objectContaining({
      queryChunks: expect.any(Array),
    }));
  });

  it('returns null when atomic claim finds no eligible job', async () => {
    transaction.execute = jest.fn(() => Promise.resolve([]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);

    await expect(store.claimNext({
      workerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      now: NOW,
    })).resolves.toBeNull();
  });

  it('rejects stale completion and updates renew/fail rows through fenced predicates', async () => {
    const queued = portfolioSyncJobRow();
    const running = portfolioSyncJobRow({
      status: 'running',
      claimVersion: 1,
      claimedByWorkerId: 'worker-1',
      leaseUntil: FIVE_MINUTES,
      attemptCount: 1,
      startedAt: NOW,
    });
    const failed = portfolioSyncJobRow({
      ...running,
      status: 'failed',
      claimedByWorkerId: null,
      leaseUntil: null,
      resultSummary: { failed: 1 },
      operationalErrorCode: 'provider_unavailable',
      completedAt: FIVE_MINUTES,
    });
    transaction.update = jest.fn(() => returningChain([]));
    const store = new PostgresPortfolioSyncJobStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.complete({
      jobId: queued.id,
      claimVersion: 0,
      resultSummary: { imported: 1 },
      completedAt: FIVE_MINUTES,
    })).resolves.toBeNull();

    transaction.update = jest.fn(() => returningChain([running]));
    await expect(store.renewLease({
      jobId: queued.id,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: THIRTY_MINUTES,
      now: NOW,
    })).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.renewLease({
      jobId: queued.id,
      claimVersion: 1,
      workerId: 'worker-1',
      leaseUntil: THIRTY_MINUTES,
      now: FIVE_MINUTES,
    })).resolves.toBe(false);

    transaction.update = jest.fn(() => returningChain([failed]));
    await expect(store.fail({
      jobId: queued.id,
      claimVersion: 1,
      operationalErrorCode: 'provider_unavailable',
      resultSummary: { failed: 1 },
      completedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      status: 'failed',
      operationalErrorCode: 'provider_unavailable',
    });
  });
});

describe('PostgresIdempotencyStore', () => {
  it('returns ownership of a newly inserted pending claim', async () => {
    const deleting = { where: jest.fn(() => Promise.resolve([])) };
    const pendingInsert = {
      onConflictDoNothing: jest.fn(() => ({
        returning: jest.fn(() => Promise.resolve([{}])),
      })),
    };
    const inserting = { values: jest.fn(() => pendingInsert) };
    transaction.delete = jest.fn(() => deleting);
    transaction.insert = jest.fn(() => inserting);
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    const result = await store.claim(idempotencyIdentity());

    expect(result).toMatchObject({
      kind: 'claimed',
      claim: idempotencyIdentity(),
    });
    expect(result.kind === 'claimed' && result.claim.claimId)
      .toMatch(/^[0-9a-f-]{36}$/);
    expect(inserting.values).toHaveBeenCalledWith(expect.objectContaining({
      state: 'pending',
      responseStatus: null,
      responseBodyPresent: null,
      responseBody: null,
    }));
  });

  it('reports a typed conflict if the winning record is no longer visible after insert conflict', async () => {
    const deleting = { where: jest.fn(() => Promise.resolve([])) };
    const inserting = {
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
      })),
    };
    transaction.delete = jest.fn(() => deleting);
    transaction.insert = jest.fn(() => inserting);
    transaction.select = jest.fn(() => selectingChain([]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.claim(idempotencyIdentity())).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('clones retained response state returned from PostgreSQL', async () => {
    const row = {
      ...idempotencyRecord(),
      responseStatus: 200,
      responseBodyPresent: true,
      responseBody: { ok: true },
    };
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    const returned = await store.find(hash(1), row.idempotencyKey, FOUR_MINUTES);
    returned?.requestFingerprint.fill(0);
    (returned?.responseBody as { ok: boolean }).ok = false;

    expect(row.requestFingerprint).toEqual(hash(7));
    expect(row.responseBody).toEqual({ ok: true });
  });

  it('rejects corrupt completed rows and counts deleted expired responses', async () => {
    transaction.select = jest.fn(() => selectingChain([{
      ...idempotencyRecord(),
      httpMethod: 'GET',
    }]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);
    await expect(store.find(hash(1), idempotencyRecord().idempotencyKey, FOUR_MINUTES))
      .rejects.toThrow(ConsoleStoreValidationError);

    transaction.delete = jest.fn(() => returningChain([{ idempotencyKey: idempotencyRecord().idempotencyKey }]));
    await expect(store.sweepExpired(ONE_HOUR)).resolves.toBe(1);
  });

  it('completes only the active pending claim token', async () => {
    const completed = idempotencyRecord();
    transaction.update = jest.fn(() => returningChain([completed]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.complete(idempotencyClaim(), {
      responseStatus: 204,
      responseBodyPresent: false,
      responseBody: null,
    })).resolves.toMatchObject({ state: 'completed', responseStatus: 204 });
  });

  it('rejects corrupt pending rows read during an insert conflict', async () => {
    transaction.delete = jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) }));
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        onConflictDoNothing: jest.fn(() => ({
          returning: jest.fn(() => Promise.resolve([])),
        })),
      })),
    }));
    transaction.select = jest.fn(() => selectingChain([{
      ...idempotencyClaim(),
      state: 'pending',
      httpMethod: 'GET',
      responseStatus: null,
      responseBodyPresent: null,
      responseBody: null,
    }]));
    const store = new PostgresIdempotencyStore({} as DatabaseInstance);

    await expect(store.claim(idempotencyIdentity())).rejects.toThrow(ConsoleStoreValidationError);
  });
});

describe('PostgresConsoleFactorStore', () => {
  it('refuses to recreate factor material after the principal lifecycle fence closes', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn();
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.createTotpFactor(factorRow(), [hash(11)]))
      .rejects.toMatchObject({ name: 'InactiveUserLifecycleError' });
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('normalizes duplicate active TOTP inserts to a store conflict', async () => {
    const conflict = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.reject(conflict)),
    }));
    transaction.select = jest.fn(() => selectingChain([{ id: USER_ID }]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.createTotpFactor(factorRow(), [hash(11)])).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('returns status-only active factor projection', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{
        factorId: '22222222-2222-4222-8222-222222222222',
        factorType: 'totp',
        enrolledAt: NOW,
        disabledAt: null,
        lastUsedAt: FIVE_MINUTES,
      }]))
      .mockReturnValueOnce(selectingChain([{ count: 2 }]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: true,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: FIVE_MINUTES,
      backupCodesRemaining: 2,
    });
  });

  it('falls back to latest disabled factor metadata when no active factor exists', async () => {
    const activeChain = selectingChain([]);
    const disabledChain = selectingChain([{
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: FIVE_MINUTES,
      lastUsedAt: FOUR_MINUTES,
    }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(activeChain)
      .mockReturnValueOnce(disabledChain);
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: false,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: FIVE_MINUTES,
      lastUsedAt: FOUR_MINUTES,
      backupCodesRemaining: 0,
    });
    expect(disabledChain.orderBy).toHaveBeenCalledWith(desc(accountFactors.disabledAt));
  });

  it('returns empty status when no active or disabled factor exists', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getTotpStatus(USER_ID)).resolves.toEqual({
      enrolled: false,
      factorType: null,
      enrolledAt: null,
      disabledAt: null,
      lastUsedAt: null,
      backupCodesRemaining: 0,
    });
  });

  it('clones AS-only active factor material from PostgreSQL', async () => {
    const row = factorRow();
    transaction.select = jest.fn(() => selectingChain([row]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    const returned = await store.getActiveTotpFactorForAs(USER_ID);
    returned?.secretCiphertext.fill(0);

    expect(row.secretCiphertext).toEqual(Buffer.from('encrypted-totp-seed'));
  });

  it('rejects corrupt factor rows with an explicit null-ciphertext error', async () => {
    transaction.select = jest.fn(() => selectingChain([factorRow({ secretCiphertext: null })]));
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);

    await expect(store.getActiveTotpFactorForAs(USER_ID))
      .rejects.toThrow('unexpected NULL ciphertext for active TOTP factor row');
  });

  it('conditionally updates factor use and rejects non-matching use attempts', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ factorId: factorRow().factorId }]));
    await expect(store.markTotpUsed(USER_ID, factorRow().factorId, FIVE_MINUTES)).resolves.toBe(true);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.markTotpUsed(USER_ID, '7acb0d42-8772-4326-a08f-f816b59fc176', FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.markTotpUsed(USER_ID, factorRow().factorId, BEFORE_NOW)).resolves.toBe(false);
    const predicate = transaction.update.mock.results[0]?.value.where.mock.calls[0]?.[0];
    expect(collectStrings(predicate)).toContain('last_used_at');
  });

  it('consumes a matching active backup code once', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    const chain = returningChain([{ codeId: '7acb0d42-8772-4326-a08f-f816b59fc176' }]);
    transaction.update = jest.fn(() => chain);

    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(true);
    expect(chain.set).toHaveBeenCalledWith({ usedAt: FIVE_MINUTES });
    expect(chain.where).toHaveBeenCalledWith(expect.anything());

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(false);
  });

  it('does not consume backup codes for inactive, foreign, or not-yet-created factors', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([]));

    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.consumeBackupCode(USER_ID, factorRow().factorId, hash(11), BEFORE_NOW)).resolves.toBe(false);
  });

  it('disables with a matching backup code in one transactional store operation', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([{ codeId: '7acb0d42-8772-4326-a08f-f816b59fc176' }]))
      .mockReturnValueOnce(returningChain([{ factorId: factorRow().factorId }]));

    await expect(store.disableActiveTotpWithBackupCode(USER_ID, factorRow().factorId, hash(11), FIVE_MINUTES))
      .resolves.toBe(true);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('conditionally disables active TOTP and permits re-enrollment after disable', async () => {
    const store = new PostgresConsoleFactorStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ factorId: factorRow().factorId }]));
    await expect(store.disableActiveTotp(USER_ID, FIVE_MINUTES)).resolves.toBe(true);

    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => Promise.resolve()),
    }));
    transaction.select = jest.fn(() => selectingChain([{ id: USER_ID }]));
    await expect(store.createTotpFactor(factorRow({
      factorId: '7acb0d42-8772-4326-a08f-f816b59fc176',
      enrolledAt: FIVE_MINUTES,
    }), [hash(11), hash(12)])).resolves.toBeUndefined();

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.disableActiveTotp(USER_ID, FIVE_MINUTES)).resolves.toBe(false);
    await expect(store.disableActiveTotp(USER_ID, BEFORE_NOW)).resolves.toBe(false);
  });
});

describe('PostgresConsoleIdentityResolver', () => {
  it('returns the canonical security state with roles from user_admin_roles', async () => {
    // The resolver checks the durable subject fence before principal and role
    // projection while holding the same subject authority lock as mutations.
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{
        sub: PRIMARY_SUB,
        userId: USER_ID,
        disabledAt: null,
        authzVersion: 4,
      }]))
      .mockReturnValueOnce(selectingOrderedChain([{ role: 'admin' }]));
    const resolver = new PostgresConsoleIdentityResolver({} as DatabaseInstance);

    await expect(resolver.resolveEnabledPrincipal(PRIMARY_SUB)).resolves.toEqual({
      sub: PRIMARY_SUB,
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 4,
      roles: ['admin'],
    });
  });

  it('rejects a console identity while its durable subject fence exists', async () => {
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ subjectHash: 'fenced' }]));
    const resolver = new PostgresConsoleIdentityResolver({} as DatabaseInstance);

    await expect(resolver.resolveEnabledPrincipal(PRIMARY_SUB)).resolves.toBeNull();
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresConsoleAccountAdminStore', () => {
  it('writes role grants through the role table and bumps principal authz version', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    mockLivePrincipalLock();
    transaction.insert = jest.fn(() => insertChain([roleRow()]));
    const authorityUpdate = returningChain([]);
    transaction.update = jest.fn(() => authorityUpdate);

    await expect(store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ userId: USER_ID, role: 'account_admin' });

    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect([...collectStrings(authorityUpdate.set.mock.calls[0]?.[0])].join(' '))
      .toContain('statement_timestamp()');
  });

  it('translates duplicate role grants to a store conflict', async () => {
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    mockLivePrincipalLock();
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);

    await expect(store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    })).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('revokes account-admin roles through an atomic orphan-checked statement', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    mockLivePrincipalLock();
    transaction.execute.mockResolvedValueOnce(
      [roleMutationRow({ revokedAt: FIVE_MINUTES, revokedByUserId: SECOND_USER_ID })],
    );
    transaction.update = jest.fn();

    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'account_admin',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ revokedAt: FIVE_MINUTES });

    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it('revokes non-account-admin roles and bumps authz version in one system transaction', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    mockLivePrincipalLock({ roles: ['operator'] });
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([roleRow({
        role: 'operator',
        revokedAt: FIVE_MINUTES,
        revokedByUserId: SECOND_USER_ID,
      })]))
      .mockReturnValueOnce(returningChain([]));

    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'operator',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ revokedAt: FIVE_MINUTES });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('returns null for no-op role and principal state changes', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    mockLivePrincipalLock({ roles: [] });
    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'operator',
      revokedByUserId: SECOND_USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toBeNull();

    transaction.execute = jest.fn(() => Promise.resolve([]));
    await expect(store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES })).resolves.toBeNull();
    await expect(store.enablePrincipal({ userId: USER_ID, enabledAt: THIRTY_MINUTES })).resolves.toBeNull();
  });

  it('counts enabled account administrators', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.execute = jest.fn(() => Promise.resolve([{ count: '2' }]));
    await expect(store.countEnabledAccountsAdmins()).resolves.toBe(2);
  });

  it('bumps authz_version when disabling and enabling principals', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.execute = jest.fn(() => Promise.resolve([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }]));

    await expect(store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES }))
      .resolves.toEqual({ userId: USER_ID, authzVersion: 2, disabledAt: FIVE_MINUTES, changedAt: FIVE_MINUTES });

    transaction.update = jest.fn(() => returningChain([{ userId: USER_ID, authzVersion: 3, disabledAt: null }]));
    await expect(store.enablePrincipal({ userId: USER_ID, enabledAt: THIRTY_MINUTES }))
      .resolves.toEqual({ userId: USER_ID, authzVersion: 3, disabledAt: null, changedAt: THIRTY_MINUTES });
  });

  it('projects account directory rows without private content', async () => {
    const row = principalProjectionRow();
    transaction.execute = jest.fn(() => Promise.resolve([row]));
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);

    await expect(store.listPrincipals({ sub: PRIMARY_SUB, limit: 20 })).resolves.toEqual({
      items: [{
        userId: USER_ID,
        primarySub: PRIMARY_SUB,
        username: 'alice',
        displayName: 'Alice',
        email: ALICE_EMAIL,
        emailVerified: true,
        authMethods: ['github'],
        roles: ['account_admin'],
        disabledAt: null,
        createdAt: NOW,
        lastLoginAt: FIVE_MINUTES,
        adminFactorEnrolled: true,
        accountCorrelationId: ACCOUNT_CORRELATION_ID,
        authzVersion: 3,
      }],
      nextCursor: null,
    });

    transaction.execute = jest.fn(() => Promise.resolve([principalProjectionRow({ roles: ['unknown'] })]));
    await expect(store.findPrincipal(USER_ID)).rejects.toThrow('unknown administrative role');

    transaction.execute = jest.fn(() => Promise.resolve([row]));
    await expect(store.findPrincipalByAccountCorrelationId(ACCOUNT_CORRELATION_ID))
      .resolves.toMatchObject({ userId: USER_ID, accountCorrelationId: ACCOUNT_CORRELATION_ID });
  });

  it('updates principal display name before re-projecting account metadata', async () => {
    const store = new PostgresConsoleAccountAdminStore({} as DatabaseInstance);
    transaction.update = jest.fn(() => returningChain([{ id: USER_ID }]));
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([principalProjectionRow({ display_name: 'Alice Console' })]);

    await expect(store.updatePrincipalProfile({
      userId: USER_ID,
      displayName: 'Alice Console',
      updatedAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      userId: USER_ID,
      displayName: 'Alice Console',
    });
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(2);

    transaction.update = jest.fn(() => returningChain([]));
    await expect(store.updatePrincipalProfile({
      userId: USER_ID,
      displayName: null,
      updatedAt: FIVE_MINUTES,
    })).resolves.toBeNull();
  });
});

describe('PostgresConsoleSecurityInvalidationStore', () => {
  it('appends invalidation events and lists them by durable sequence', async () => {
    const row = {
      sequenceId: 7,
      eventId: 'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      kind: 'principal_disabled' as const,
      urgency: 'acknowledged' as const,
      userId: USER_ID,
      consoleSessionIdHash: null,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    };
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    transaction.insert = jest.fn(() => insertChain([row]));

    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    })).resolves.toMatchObject({ sequenceId: 7, eventId: row.eventId });

    transaction.select = jest.fn(() => selectingChain([row]));
    await expect(store.listEventsAfter(6, 10)).resolves.toHaveLength(1);
  });

  it('records monotonic cursors, live leases, and acknowledgements with upserts', async () => {
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    const cursorChain = insertChain();
    const leaseChain = insertChain();
    const ackChain = insertChain([{ commandId: RUNTIME_COMMAND_ID }]);
    transaction.insert = jest.fn()
      .mockReturnValueOnce(cursorChain)
      .mockReturnValueOnce(leaseChain)
      .mockReturnValueOnce(ackChain);

    await expect(store.recordReplicaCursor('replica-a', 7, FIVE_MINUTES)).resolves.toBeUndefined();
    await expect(store.acquireReplicaLease({
      replicaId: 'replica-a',
      renewedAt: FIVE_MINUTES,
      leaseUntil: THIRTY_MINUTES,
    })).resolves.toBeUndefined();
    await expect(store.acknowledgeEvent(
      'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      'replica-a',
      THIRTY_MINUTES,
    )).resolves.toBeUndefined();

    expect(transaction.insert).toHaveBeenCalledTimes(3);
    expect(cursorChain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ lastSequenceId: expect.anything() }),
    }));
    expect([...collectStrings(leaseChain.values.mock.calls[0]?.[0])].join(' '))
      .toContain('statement_timestamp()');
    expect(ackChain.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.any(Array),
    }));
    expect(ackChain.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('reads cursors, live replicas, and acknowledgement IDs', async () => {
    const store = new PostgresConsoleSecurityInvalidationStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{ lastSequenceId: 12 }]))
      .mockReturnValueOnce(selectingOrderedChain([{ replicaId: 'replica-a' }, { replicaId: 'replica-b' }]))
      .mockReturnValueOnce(selectingOrderedChain([{ replicaId: 'replica-b' }]));

    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(0);
    await expect(store.getReplicaCursor('replica-a')).resolves.toBe(12);
    await expect(store.listLiveReplicaIds()).resolves.toEqual(['replica-a', 'replica-b']);
    await expect(store.listAcknowledgedReplicaIds('e6174fd8-f6ef-4286-8bd2-3f3eb30194c1'))
      .resolves.toEqual(['replica-b']);
  });
});

describe('PostgresRuntimeSessionControlStore', () => {
  const presenceRow = {
    sessionId: RUNTIME_SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    replicaId: 'replica-a',
    transport: 'streamable-http' as const,
    clientName: 'Dollhouse CLI',
    clientVersion: '1.0.0',
    startedAt: NOW,
    lastActiveAt: FIVE_MINUTES,
    requestCount: 3,
    errorCount: 1,
    leaseUntil: THIRTY_MINUTES,
    status: 'active' as const,
    closedAt: null,
  };
  const commandRow = {
    commandId: RUNTIME_COMMAND_ID,
    kind: 'terminate_session',
    sessionId: RUNTIME_SESSION_ID,
    targetReplicaId: 'replica-a',
    reason: 'admin_terminated' as const,
    requestedAt: NOW,
    requestedByKind: 'admin' as const,
    requestedByUserId: SECOND_USER_ID,
    invalidationEventId: null,
  };
  const ackRow = {
    commandId: RUNTIME_COMMAND_ID,
    replicaId: 'replica-a',
    acknowledgedAt: FIVE_MINUTES,
    result: 'terminated' as const,
    errorCode: null,
  };

  it('refuses to recreate runtime presence after the principal lifecycle fence closes', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.insert = jest.fn();
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);

    await expect(store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: 'streamable-http',
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    })).rejects.toMatchObject({ name: 'InactiveUserLifecycleError' });
    expect(transaction.insert).not.toHaveBeenCalled();
  });

  it('upserts runtime presence and maps heartbeat/closing updates', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    const registerChain = insertChain([presenceRow]);
    const heartbeatChain = returningChain([presenceRow]);
    const closingChain = returningChain([{ ...presenceRow, status: 'closing', closedAt: THIRTY_MINUTES }]);
    transaction.insert = jest.fn(() => registerChain);
    transaction.select = jest.fn(() => selectingChain([{ id: USER_ID }]));
    transaction.update = jest.fn()
      .mockReturnValueOnce(heartbeatChain)
      .mockReturnValueOnce(closingChain);

    await expect(store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: 'streamable-http',
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    })).resolves.toMatchObject({
      sessionId: RUNTIME_SESSION_ID,
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
    });
    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: FIVE_MINUTES,
      requestCount: 3,
      errorCount: 1,
      leaseUntil: THIRTY_MINUTES,
    })).resolves.toMatchObject({ kind: 'updated', presence: { requestCount: 3, errorCount: 1 } });
    await expect(store.markPresenceClosing(RUNTIME_SESSION_ID, 'replica-a', THIRTY_MINUTES))
      .resolves.toMatchObject({ status: 'closing', closedAt: THIRTY_MINUTES });

    expect(registerChain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ sessionId: RUNTIME_SESSION_ID }),
    }));
    expect(registerChain.values).toHaveBeenCalledWith(expect.objectContaining({
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    }));
    expect([...collectStrings(heartbeatChain.set.mock.calls[0]?.[0])].join(' '))
      .toContain('statement_timestamp()');
    expect(transaction.update).toHaveBeenCalledTimes(2);
  });

  it('uses PostgreSQL time when evaluating durable presence by default', async () => {
    const presenceChain = selectingChain([presenceRow]);
    const activeChain = selectingChain([{ sessionId: RUNTIME_SESSION_ID }]);
    transaction.select = jest.fn()
      .mockReturnValueOnce(presenceChain)
      .mockReturnValueOnce(activeChain);
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);

    await expect(store.findPresence(RUNTIME_SESSION_ID)).resolves.toMatchObject({
      sessionId: RUNTIME_SESSION_ID,
    });
    await expect(isRuntimePresenceActiveWithTx(
      transaction as never,
      RUNTIME_SESSION_ID,
      USER_ID,
    )).resolves.toBe(true);
    expect([...collectStrings(presenceChain.where.mock.calls[0]?.[0])].join(' '))
      .toContain('statement_timestamp()');
    expect([...collectStrings(activeChain.where.mock.calls[0]?.[0])].join(' '))
      .toContain('statement_timestamp()');
  });

  it('reads runtime presence for self/admin/operator projections', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([presenceRow]))
      .mockReturnValueOnce(selectingChain([presenceRow]))
      .mockReturnValueOnce(selectingChain([{ ...presenceRow, status: 'closing' }]))
      .mockReturnValueOnce(selectingChain([presenceRow]));

    await expect(store.findPresence(RUNTIME_SESSION_ID, NOW)).resolves.toMatchObject({ sessionId: RUNTIME_SESSION_ID });
    await expect(store.listPresenceByUser(USER_ID, { now: NOW })).resolves.toHaveLength(1);
    await expect(store.findOperationalPresence(RUNTIME_SESSION_ID, NOW))
      .resolves.toMatchObject({ sessionId: RUNTIME_SESSION_ID, status: 'closing' });
    expect((await store.listOperationalPresence({ now: NOW })).items).toHaveLength(1);
  });

  it('reads recorded presence without hiding closed or expired ownership evidence', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{
        ...presenceRow,
        status: 'closing',
        closedAt: THIRTY_MINUTES,
        leaseUntil: BEFORE_NOW,
      }]))
      .mockReturnValueOnce(selectingChain([]));

    await expect(store.findRecordedPresence(RUNTIME_SESSION_ID)).resolves.toMatchObject({
      sessionId: RUNTIME_SESSION_ID,
      status: 'closing',
      leaseUntil: BEFORE_NOW,
    });
    await expect(store.findRecordedPresence('mcp-session-missing')).resolves.toBeNull();
  });

  it('sweeps stale runtime presence rows', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn(() => selectingChain([]));
    transaction.delete = jest.fn(() => returningChain([{ sessionId: RUNTIME_SESSION_ID }]));

    await expect(store.sweepStalePresence(ONE_HOUR)).resolves.toBe(1);

    expect(transaction.delete).toHaveBeenCalledTimes(1);
  });

  it('creates runtime termination commands and idempotent acknowledgements', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    const commandChain = insertChain([commandRow]);
    const ackChain = insertChain([{ commandId: RUNTIME_COMMAND_ID }]);
    transaction.insert = jest.fn()
      .mockReturnValueOnce(commandChain)
      .mockReturnValueOnce(ackChain);

    await expect(store.createTerminationCommand({
      commandId: RUNTIME_COMMAND_ID,
      sessionId: RUNTIME_SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'admin_terminated',
      requestedAt: NOW,
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    })).resolves.toMatchObject({
      commandId: RUNTIME_COMMAND_ID,
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    });
    await expect(store.acknowledgeCommand({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
    })).resolves.toBe(true);

    expect(commandChain.returning).toHaveBeenCalled();
    expect(ackChain.onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.anything(),
    }));
  });

  it('reads pending commands and acknowledgements', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingJoinedChain([{ command: commandRow }]))
      .mockReturnValueOnce(selectingChain([ackRow]));

    await expect(store.listPendingCommandsForReplica('replica-a')).resolves.toEqual([
      expect.objectContaining({ commandId: RUNTIME_COMMAND_ID }),
    ]);
    await expect(store.getCommandAck(RUNTIME_COMMAND_ID)).resolves.toEqual({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
      errorCode: null,
    });
  });

  it('maps lost heartbeat ownership and ignores a delayed current-owner snapshot', async () => {
    const store = new PostgresRuntimeSessionControlStore({} as DatabaseInstance);
    transaction.update = jest.fn()
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]))
      .mockReturnValueOnce(returningChain([]));
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([]))
      .mockReturnValueOnce(selectingChain([{ replicaId: 'replica-b', status: 'active' }]))
      .mockReturnValueOnce(selectingChain([{ replicaId: 'replica-a', status: 'closing' }]))
      .mockReturnValueOnce(selectingChain([presenceRow]));

    const heartbeat = {
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: FIVE_MINUTES,
      requestCount: 3,
      errorCount: 1,
      leaseUntil: THIRTY_MINUTES,
    };
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'missing' });
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'replica_mismatch' });
    await expect(store.heartbeatPresence(heartbeat)).resolves.toEqual({ kind: 'lost', reason: 'closing' });
    await expect(store.heartbeatPresence(heartbeat)).resolves.toMatchObject({
      kind: 'updated',
      presence: { requestCount: presenceRow.requestCount, leaseUntil: presenceRow.leaseUntil },
    });
  });
});

describe('PostgresAdminAuditWriter', () => {
  it('serializes audit appends through the admin chain head', async () => {
    const event = adminAuditEvent();
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 5);
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([{ sequence_id: '1', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(event)).resolves.toBeUndefined();

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(sqlText(0)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(1)).toContain('FOR UPDATE');
    expect(sqlText(2)).toContain('INSERT INTO admin_audit_events');
    expect(sqlText(3)).toContain('UPDATE admin_audit_chain_heads');

    const insertChunks = sqlChunks(2);
    expect(insertChunks).toContain(AUDIT_KEY_ID);
    expect(insertChunks).toContain(null);
    expect(insertChunks).toContainEqual(expectedAuditHmac(event, key, null));
    expect(sqlChunks(3)).toContain(returnedChainHmac);
  });

  it('chains subsequent audit events to the previous HMAC value', async () => {
    const event = adminAuditEvent();
    const previous = Buffer.alloc(32, 4);
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 6);
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: '7', last_chain_hmac: previous }])
      .mockResolvedValueOnce([{ sequence_id: '8', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(event)).resolves.toBeUndefined();

    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(sqlChunks(2)).toContainEqual(previous);
    expect(sqlChunks(2)).toContainEqual(expectedAuditHmac(event, key, previous));
    expect(sqlChunks(3)).toContainEqual(returnedChainHmac);
  });

  it('rejects missing audit chain rows and missing inserted audit rows', async () => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(writer.write(adminAuditEvent())).rejects.toThrow('admin audit chain head is unavailable');

    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([]);

    await expect(writer.write(adminAuditEvent())).rejects.toThrow('admin audit append did not return a row');
  });

  it('rejects oversized redacted audit payloads before writing', async () => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn();

    await expect(writer.write(adminAuditEvent({
      argsRedacted: { value: 'x'.repeat(4096) },
    }))).rejects.toThrow('argsRedacted');

    expect(transaction.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['actorConsoleSessionHash', { actorConsoleSessionHash: Buffer.alloc(31, 8) }, 'actor session hash'],
    ['actorSub', { actorSub: ' ' }, 'actorSub'],
    ['actorCapabilityRole', { actorCapabilityRole: ' ' as unknown as ConsoleAdminActorRole }, 'actorCapabilityRole'],
    ['endpoint', { endpoint: ' ' }, 'endpoint'],
    ['operation', { operation: ' ' }, 'operation'],
    ['correlationId', { correlationId: ' ' }, 'correlationId'],
  ])('validates audit event field %s', async (_field, overrides, message) => {
    const writer = new PostgresAdminAuditWriter({} as DatabaseInstance, {
      resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
    });
    transaction.execute = jest.fn();

    await expect(writer.write(adminAuditEvent(overrides))).rejects.toThrow(message);
    expect(transaction.execute).not.toHaveBeenCalled();
  });
});

describe('PostgresConsoleAccountAllowlistStore', () => {
  it('blocks sign-in authority cutover while legacy identities need review', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([{ entryId: ALLOWLIST_ID }])
      .mockResolvedValueOnce([]);

    await expect(store.assertIdentityMigrationReviewed()).rejects.toThrow(
      'legacy account allowlist identities require operator review',
    );
    await expect(store.assertIdentityMigrationReviewed()).resolves.toBeUndefined();
    expect(transaction.execute).toHaveBeenCalledTimes(2);
  });

  it('uses active-entry filters and maps allowlist rows without exposing revoked history', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn(() => selectingOrderedChain([allowlistRow()]));

    await expect(store.listActive()).resolves.toEqual([{
      id: ALLOWLIST_ID,
      kind: 'email',
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
      note: 'initial',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
      revokedByUserId: null,
      revokedAt: null,
    }]);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it('finds a single active allowlist row by id', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn(() => selectingChain([allowlistRow()]));

    await expect(store.findActive(ALLOWLIST_ID)).resolves.toMatchObject({
      id: ALLOWLIST_ID,
      normalizedValue: ALICE_EMAIL,
    });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
  });

  it('checks account allowlist sign-in authority through active rows only', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingChain([{ id: ALLOWLIST_ID }]))
      .mockReturnValueOnce(selectingChain([{ authorityOrder: 1 }]))
      .mockReturnValueOnce(selectingChain([]));

    await expect(store.hasActiveEntries()).resolves.toBe(true);
    await expect(store.matchesIdentity({ email: 'Alice@Example.Test' })).resolves.toBe(true);
    await expect(store.matchesIdentity({ githubId: '123' })).resolves.toBe(false);
    expect(transaction.select).toHaveBeenCalledTimes(3);
  });

  it('locks the authoritative allowlist match through account provisioning', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    const bootstrapSelect = selectingForUpdateChain([]);
    const allowlistSelect = selectingForUpdateChain([{ authorityOrder: 1 }]);
    const tombstoneSelect = selectingForUpdateChain([]);
    const deletionFenceSelect = selectingChain([]);
    const accountInsert = insertChain();
    const auditInsert = insertChain();
    transaction.select = jest.fn()
      .mockReturnValueOnce(bootstrapSelect)
      .mockReturnValueOnce(allowlistSelect)
      .mockReturnValueOnce(tombstoneSelect)
      .mockReturnValueOnce(deletionFenceSelect);
    transaction.insert = jest.fn()
      .mockReturnValueOnce(accountInsert)
      .mockReturnValueOnce(auditInsert);

    await expect(store.provisionAccountIfAllowed({
      identity: {
        sub: 'github_42',
        method: 'github',
        email: ALICE_EMAIL,
        githubId: '42',
      },
      account: {
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: ALICE_EMAIL,
        emailVerified: true,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
      },
      required: true,
      successAuditEvent: {
        type: 'auth.social.identity_changed',
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        details: { previousEmail: 'old@example.test', newEmail: ALICE_EMAIL },
        timestamp: NOW.getTime(),
      },
    })).resolves.toEqual({ allowed: true });

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    // One authority subject lock, locks for the email and stable GitHub id,
    // plus the central account-upsert subject lock before its deletion check.
    expect(transaction.execute).toHaveBeenCalledTimes(4);
    expect(bootstrapSelect.for).toHaveBeenCalledWith('update');
    expect(allowlistSelect.for).toHaveBeenCalledWith('update');
    expect(tombstoneSelect.for).toHaveBeenCalledWith('update');
    expect(accountInsert.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(auditInsert.values).toHaveBeenCalledWith(expect.objectContaining({
      type: 'auth.social.identity_changed',
      sub: 'github_42',
    }));
  });

  it('does not let empty-list fallback re-provision a revoked identity', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingForUpdateChain([{ authorityOrder: 2 }]));
    const inserts: ReturnType<typeof insertChain>[] = [];
    transaction.insert = jest.fn(() => {
      const chain = insertChain();
      inserts.push(chain);
      return chain;
    });
    transaction.transaction = jest.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction));

    await expect(store.provisionAccountIfAllowed({
      identity: {
        sub: 'github_42',
        method: 'github',
        email: ALICE_EMAIL,
        githubId: '42',
      },
      account: {
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: ALICE_EMAIL,
        emailVerified: true,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
      },
      required: false,
    })).resolves.toEqual({
      allowed: false,
      reason: 'This identity is not on the sign-in allowlist.',
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('lets a newer stable-identity tombstone override an older active alias', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    transaction.select = jest.fn()
      .mockReturnValueOnce(selectingForUpdateChain([]))
      .mockReturnValueOnce(selectingForUpdateChain([{ authorityOrder: 4 }]))
      .mockReturnValueOnce(selectingForUpdateChain([{ authorityOrder: 5 }]));
    const denialAudit = insertChain();
    transaction.insert = jest.fn(() => denialAudit);
    transaction.transaction = jest.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction));

    await expect(store.provisionAccountIfAllowed({
      identity: {
        sub: 'github_42',
        method: 'github',
        email: ALICE_EMAIL,
        githubUsername: 'new-alias',
        githubId: '42',
      },
      account: {
        sub: 'github_42',
        provider: 'github',
        externalSub: '42',
        email: ALICE_EMAIL,
        emailVerified: true,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
      },
      required: false,
    })).resolves.toEqual({
      allowed: false,
      reason: 'This identity is not on the sign-in allowlist.',
    });
    expect(denialAudit.onConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('normalizes inserted allowlist values and maps duplicate active entries to conflicts', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    const insert = insertChain([allowlistRow()]);
    transaction.insert = jest.fn(() => insert);

    await expect(store.add({
      kind: 'email',
      value: ` ${ALICE_DISPLAY_EMAIL} `,
      note: 'initial',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).resolves.toMatchObject({
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
    });
    expect(insert.values).toHaveBeenCalledWith(expect.objectContaining({
      normalizedValue: ALICE_EMAIL,
      displayValue: ALICE_DISPLAY_EMAIL,
    }));
    expect(transaction.execute).toHaveBeenCalledTimes(1);

    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    await expect(store.add({
      kind: 'email',
      value: ALICE_EMAIL,
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow(ConsoleStoreConflictError);
  });

  it('updates and removes only active allowlist rows', async () => {
    const store = new PostgresConsoleAccountAllowlistStore({} as DatabaseInstance);
    const update = returningChain([allowlistRow({ note: null })]);
    transaction.update = jest.fn(() => update);

    await expect(store.update({
      id: ALLOWLIST_ID,
      note: null,
    })).resolves.toMatchObject({ note: null });
    expect(update.set).toHaveBeenCalledWith({ note: null });

    transaction.select = jest.fn(() => selectingChain([allowlistRow({ note: 'initial' })]));
    transaction.update = jest.fn();
    await expect(store.update({ id: ALLOWLIST_ID })).resolves.toMatchObject({ note: 'initial' });
    expect(transaction.update).not.toHaveBeenCalled();

    const remove = returningChain([allowlistRow({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    })]);
    transaction.select = jest.fn(() => selectingChain([allowlistRow()]));
    transaction.update = jest.fn(() => remove);
    await expect(store.remove({
      id: ALLOWLIST_ID,
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    })).resolves.toMatchObject({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    });
    expect(remove.set).toHaveBeenCalledWith(expect.objectContaining({
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
      authorityOrder: expect.anything(),
    }));
    expect(transaction.execute).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresAccountAdminMutationTransactionRunner', () => {
  it('does not prepare invite signing for unrelated account-admin transactions', async () => {
    const preparedIssue = jest.fn();
    const prepareIssueInviteWithTx = jest.fn(async () => preparedIssue);
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.run(() => Promise.reject(new Error('stop after open'))))
      .rejects.toThrow('stop after open');
    expect(prepareIssueInviteWithTx).not.toHaveBeenCalled();
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(preparedIssue).not.toHaveBeenCalled();
  });

  it('prepares invite signing before opening the dedicated invite transaction', async () => {
    const preparedIssue = jest.fn();
    const prepareIssueInviteWithTx = jest.fn(async () => {
      expect(withSystemContextMock).not.toHaveBeenCalled();
      return preparedIssue;
    });
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.runInvite(() => Promise.reject(new Error('stop after open'))))
      .rejects.toThrow('stop after open');
    expect(prepareIssueInviteWithTx).toHaveBeenCalledTimes(1);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(preparedIssue).not.toHaveBeenCalled();
  });

  it('retries the whole invite prebind and transaction after a signing lifecycle conflict', async () => {
    const conflict = new SigningKeyLifecycleConflictError('invite key rotated');
    const preparedIssue = jest.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ inviteUrl: 'https://example.test/invite', userId: USER_ID });
    const prepareIssueInviteWithTx = jest.fn(async () => preparedIssue);
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.runInvite(async tx => {
      await tx.issueInvite({
        username: 'alice',
        email: ALICE_EMAIL,
        ttlMinutes: 15,
        roles: [],
        actorUserId: USER_ID,
        issuedAt: FIVE_MINUTES,
      });
      throw new Error('second transaction reached');
    })).rejects.toThrow('second transaction reached');

    expect(prepareIssueInviteWithTx).toHaveBeenCalledTimes(2);
    expect(preparedIssue).toHaveBeenCalledTimes(2);
    expect(withSystemContextMock).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated invite signing lifecycle conflicts to three transactions', async () => {
    const conflict = new SigningKeyLifecycleConflictError('invite key keeps rotating');
    const preparedIssue = jest.fn(() => Promise.reject(conflict));
    const prepareIssueInviteWithTx = jest.fn(async () => preparedIssue);
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.runInvite(tx => tx.issueInvite({
      username: 'alice',
      email: ALICE_EMAIL,
      ttlMinutes: 15,
      roles: [],
      actorUserId: USER_ID,
      issuedAt: FIVE_MINUTES,
    }))).rejects.toBe(conflict);

    expect(prepareIssueInviteWithTx).toHaveBeenCalledTimes(3);
    expect(preparedIssue).toHaveBeenCalledTimes(3);
    expect(withSystemContextMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-lifecycle invite transaction failures', async () => {
    const databaseFailure = new Error('invite key lookup failed');
    const preparedIssue = jest.fn(() => Promise.reject(databaseFailure));
    const prepareIssueInviteWithTx = jest.fn(async () => preparedIssue);
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.runInvite(tx => tx.issueInvite({
      username: 'alice',
      email: ALICE_EMAIL,
      ttlMinutes: 15,
      roles: [],
      actorUserId: USER_ID,
      issuedAt: FIVE_MINUTES,
    }))).rejects.toBe(databaseFailure);

    expect(prepareIssueInviteWithTx).toHaveBeenCalledTimes(1);
    expect(preparedIssue).toHaveBeenCalledTimes(1);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery mutations usable when invite-key prebinding is unavailable', async () => {
    const prepareIssueInviteWithTx = jest.fn(() => Promise.reject(new Error('no active invite key')));
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
      inviteIssuer: {
        issueInvite: jest.fn(),
        prepareIssueInviteWithTx,
      },
    });

    await expect(runner.run(() => Promise.reject(new Error('recovery route reached'))))
      .rejects.toThrow('recovery route reached');
    expect(prepareIssueInviteWithTx).not.toHaveBeenCalled();
    await expect(runner.runInvite(() => Promise.resolve()))
      .rejects.toThrow('no active invite key');
  });

  it('resolves the audit HMAC key before opening the mutation transaction', async () => {
    const resolve = jest.fn(async () => {
      expect(withSystemContextMock).not.toHaveBeenCalled();
      return { keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) };
    });
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: { resolve },
    });

    await expect(runner.run(() => Promise.reject(new Error('stop after open'))))
      .rejects.toThrow('stop after open');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the mutation transaction connection for session and OAuth cleanup', async () => {
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });
    const returning = jest.fn(() => Promise.resolve([{ idHash: Buffer.alloc(32, 1) }]));
    const whereUpdate = jest.fn(() => ({ returning }));
    const set = jest.fn(() => ({ where: whereUpdate }));
    transaction.update = jest.fn(() => ({ set }));
    const whereSelect = jest.fn(() => Promise.resolve([{ id: 'grant-a' }]));
    const from = jest.fn(() => ({ where: whereSelect }));
    transaction.select = jest.fn(() => ({ from }));
    const whereDelete = jest.fn(() => Promise.resolve());
    transaction.delete = jest.fn(() => ({ where: whereDelete }));

    await expect(runner.run(async tx => {
      await expect(tx.revokeBrowserSessionsForUser?.(USER_ID, FIVE_MINUTES)).resolves.toBe(1);
      await expect(tx.revokeOAuthSubjectGrants?.(PRIMARY_SUB)).resolves.toBe(1);
      throw new Error('stop after transactional cleanup');
    })).rejects.toThrow('stop after transactional cleanup');

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.update).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
    expect(transaction.delete).toHaveBeenCalledTimes(1);
  });
  it('composes account mutation, invalidation append, and audit append in one system transaction', async () => {
    const auditEvent = adminAuditEvent();
    const key = Buffer.alloc(32, 9);
    const returnedChainHmac = Buffer.alloc(32, 5);
    const invalidationRow = {
      sequenceId: 7,
      eventId: 'e6174fd8-f6ef-4286-8bd2-3f3eb30194c1',
      kind: 'principal_disabled' as const,
      urgency: 'acknowledged' as const,
      userId: USER_ID,
      consoleSessionIdHash: null,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 1 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    };
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key }),
      },
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ last_sequence_id: null, last_chain_hmac: null }])
      .mockResolvedValueOnce([{ sequence_id: '1', chain_hmac: returnedChainHmac }])
      .mockResolvedValueOnce([]);
    transaction.insert = jest.fn(() => insertChain([invalidationRow]));

    const result = await runner.run(async tx => {
      const stateChange = await tx.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES });
      const invalidation = await tx.appendSecurityInvalidationEvent({
        kind: 'principal_disabled',
        urgency: 'acknowledged',
        userId: USER_ID,
        authzVersion: stateChange?.authzVersion ?? null,
        reason: 'admin_disabled',
        payload: { revokedSessions: 1 },
        createdAt: FIVE_MINUTES,
        createdByUserId: SECOND_USER_ID,
      });
      await tx.writeAdminAuditEvent(auditEvent);
      return { stateChange, invalidation };
    });

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(result.stateChange).toEqual({
      userId: USER_ID,
      authzVersion: 2,
      disabledAt: FIVE_MINUTES,
      changedAt: FIVE_MINUTES,
    });
    expect(result.invalidation).toMatchObject({ sequenceId: 7, eventId: invalidationRow.eventId });
    expect(transaction.execute).toHaveBeenCalledTimes(7);
    expect(transaction.insert).toHaveBeenCalledTimes(1);
    expect(sqlText(0)).toContain('pg_advisory_xact_lock');
    expect(sqlChunks(1)).toContain(`dollhouse:user-lifecycle:${USER_ID}`);
    expect(sqlText(2)).toContain('UPDATE users');
    expect(sqlText(3)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(5)).toContain('INSERT INTO admin_audit_events');
  });

  it('propagates audit append failures so the transaction can roll back the mutation', async () => {
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });
    transaction.execute = jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId: USER_ID, authzVersion: '2', disabledAt: FIVE_MINUTES }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(runner.run(async tx => {
      await tx.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES });
      await tx.writeAdminAuditEvent(adminAuditEvent());
    })).rejects.toThrow('admin audit chain head is unavailable');

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.execute).toHaveBeenCalledTimes(5);
    expect(sqlText(0)).toContain('pg_advisory_xact_lock');
    expect(sqlChunks(1)).toContain(`dollhouse:user-lifecycle:${USER_ID}`);
    expect(sqlText(2)).toContain('UPDATE users');
    expect(sqlText(3)).toContain('INSERT INTO admin_audit_chain_heads');
    expect(sqlText(4)).toContain('FOR UPDATE');
  });

  it('propagates operation callback failures through the transaction boundary', async () => {
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });

    await expect(runner.run(async () => {
      await Promise.resolve();
      throw new Error('abort');
    })).rejects.toThrow('abort');

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate role grants to a typed conflict through the transaction runner path', async () => {
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    const runner = new PostgresAccountAdminMutationTransactionRunner({
      ...postgresMutationRunnerStores(),
      hmacKeyResolver: {
        resolve: () => Promise.resolve({ keyId: AUDIT_KEY_ID, key: Buffer.alloc(32, 9) }),
      },
    });
    transaction.insert = jest.fn(() => ({
      values: jest.fn(() => ({
        returning: jest.fn(() => Promise.reject(unique)),
      })),
    }));
    mockLivePrincipalLock();

    await expect(runner.run(tx => tx.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: SECOND_USER_ID,
      grantedAt: FIVE_MINUTES,
    }))).rejects.toThrow(ConsoleStoreConflictError);

    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });
});

function adminAuditEvent(overrides: Partial<ConsoleAdminAuditEvent> = {}): ConsoleAdminAuditEvent {
  return {
    occurredAt: FIVE_MINUTES,
    actorUserId: USER_ID,
    actorSub: PRIMARY_SUB,
    actorRole: null,
    actorCapabilityRole: 'account_admin',
    actorConsoleSessionHash: hash(8),
    capability: 'console:admin:accounts',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: BEFORE_NOW,
    correlationId: '497ed92c-22a8-4a6f-87e3-5b458bfe9d38',
    endpoint: 'POST /api/v1/admin/accounts/users/{user_id}/disable',
    operation: 'accounts.user.disable',
    resourceKind: 'user',
    resourceId: USER_ID,
    targetUserId: USER_ID,
    argsRedacted: { reason: 'bounded' },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { authzVersion: 2 },
    clientIp: '192.0.2.10',
    userAgent: 'console-test',
    ...overrides,
  };
}

function sqlChunks(callIndex: number): readonly unknown[] {
  const statement = transaction.execute.mock.calls[callIndex]?.[0] as { queryChunks?: readonly unknown[] } | undefined;
  return statement?.queryChunks ?? [];
}

function sqlText(callIndex: number): string {
  return sqlChunks(callIndex)
    .map(chunk => typeof chunk === 'object' && chunk !== null && 'value' in chunk
      ? String((chunk as { value: readonly string[] }).value.join(''))
      : '')
    .join('');
}

function expectedAuditHmac(event: ConsoleAdminAuditEvent, key: Buffer, chainPrev: Buffer | null): Buffer {
  const canonical = JSON.stringify({
    occurredAt: event.occurredAt.toISOString(),
    actorUserId: event.actorUserId,
    actorSub: event.actorSub,
    actorRole: event.actorRole,
    actorCapabilityRole: event.actorCapabilityRole,
    actorConsoleSessionHash: event.actorConsoleSessionHash.toString('hex'),
    capability: event.capability,
    elevationAcr: event.elevationAcr,
    elevationAmr: [...event.elevationAmr],
    elevationAuthTime: event.elevationAuthTime ? event.elevationAuthTime.toISOString() : null,
    endpoint: event.endpoint,
    operation: event.operation,
    resourceKind: event.resourceKind,
    resourceId: event.resourceId,
    targetUserId: event.targetUserId,
    argsRedacted: event.argsRedacted,
    result: event.result,
    errorCode: event.errorCode,
    resultDetailRedacted: event.resultDetailRedacted,
    correlationId: event.correlationId,
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    chainPrev: chainPrev ? chainPrev.toString('hex') : null,
  });
  return createHmac('sha256', key).update(canonical).digest();
}
