import { describe, expect, it } from '@jest/globals';

import {
  ConsoleStoreValidationError,
  InMemoryConsoleSessionStore,
  InMemoryConsoleFactorStore,
  InMemoryConsoleAccountAllowlistStore,
  InMemoryConsoleAccountAdminStore,
  InMemoryIdempotencyStore,
  InMemoryLoginTransactionStore,
  InMemoryIntegrationDescriptorStore,
  InMemoryIntegrationOpenApiSpecStore,
  InMemoryUserIntegrationStore,
  isUniqueViolation,
} from '../../../../src/web-console/stores/index.js';
import { InMemoryConsoleSecurityInvalidationStore } from '../../../../src/web-console/services/invalidation/index.js';
import { InMemoryRuntimeSessionControlStore } from '../../../../src/web-console/services/runtime/index.js';
import { InMemoryConsoleIdentityResolver } from '../../../../src/web-console/identity/index.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { UserIntegrationRecord } from '../../../../src/web-console/stores/IUserIntegrationStore.js';
import type { ConsoleTotpFactorRecord } from '../../../../src/web-console/stores/IConsoleFactorStore.js';
import type {
  IdempotencyCompletion,
  IdempotencyRequestIdentity,
} from '../../../../src/web-console/stores/IIdempotencyStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const READ_ISSUES_SCOPE = 'read:issues';
const STALE_ACCESS_TOKEN = 'stale-access';
const SECOND_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const DESCRIPTOR_ID = '19b9f7d7-0bf5-4cc0-9892-cf00d0f4f74d';
const DESCRIPTOR_FINGERPRINT = 'b'.repeat(64);
const SPEC_HASH = 'a'.repeat(64);
const FACTOR_ID = 'cd8f6d0e-7294-42bc-9e01-094890a820a8';
const BEFORE_NOW = new Date('2026-05-26T11:59:00.000Z');
const NOW = new Date('2026-05-26T12:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-26T12:05:00.000Z');
const FOUR_MINUTES = new Date('2026-05-26T12:04:00.000Z');
const THIRTY_MINUTES = new Date('2026-05-26T12:30:00.000Z');
const ONE_HOUR = new Date('2026-05-26T13:00:00.000Z');
const SELF_CAPABILITY = 'console:self' as const;
const ADMIN_ACR = 'urn:dollhouse:acr:admin';
const ALICE_EMAIL = 'alice@example.test';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const RUNTIME_SESSION_ID = 'mcp-session-1';
const RUNTIME_COMMAND_ID = '9f8a54b9-f195-41f0-802d-d0ec2fdfb30f';
const RUNTIME_TRANSPORT = 'streamable-http' as const;

function hash(byte: number): Buffer {
  return Buffer.alloc(32, byte);
}

function session(overrides: Partial<ConsoleSessionRecord> = {}): ConsoleSessionRecord {
  return {
    idHash: hash(1),
    userId: USER_ID,
    authSub: 'github_user-7',
    csrfTokenHash: hash(2),
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
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

function loginTransaction(
  overrides: Partial<ConsoleLoginTransaction> = {},
): ConsoleLoginTransaction {
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
    ...overrides,
  };
}

function userIntegration(overrides: Partial<UserIntegrationRecord> = {}): UserIntegrationRecord {
  return {
    id: '35e22a52-dc56-4cd0-9d13-b2802524fbd3',
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
    status: 'connected',
    errorReason: null,
    connectedAt: NOW,
    lastSyncAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function oauthDescriptorInput(overrides: Partial<Parameters<InMemoryIntegrationDescriptorStore['upsert']>[0]> = {}) {
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

function openApiSpecInput(overrides: Partial<Parameters<InMemoryIntegrationOpenApiSpecStore['upsert']>[0]> = {}) {
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

function idempotencyIdentity(
  overrides: Partial<IdempotencyRequestIdentity> = {},
): IdempotencyRequestIdentity {
  return {
    consoleSessionIdHash: hash(1),
    idempotencyKey: 'a51d7564-c85e-4e11-b319-dbc156d26f70',
    httpMethod: 'POST',
    canonicalTarget: '/api/v1/me/sessions/revoke',
    requestFingerprint: hash(9),
    createdAt: NOW,
    expiresAt: ONE_HOUR,
    ...overrides,
  };
}

const BODYLESS_COMPLETION: IdempotencyCompletion = {
  responseStatus: 204,
  responseBodyPresent: false,
  responseBody: null,
};

function totpFactor(overrides: Partial<ConsoleTotpFactorRecord> = {}): ConsoleTotpFactorRecord {
  return {
    userId: USER_ID,
    factorId: FACTOR_ID,
    factorType: 'totp' as const,
    secretCiphertext: Buffer.from('encrypted-totp-seed'),
    enrolledAt: NOW,
    disabledAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

type PrincipalFixture = ConstructorParameters<typeof InMemoryConsoleAccountAdminStore>[0][number];

function principal(overrides: Partial<PrincipalFixture> = {}): PrincipalFixture {
  return {
    userId: USER_ID,
    primarySub: 'github_user-7',
    username: 'alice',
    displayName: 'Alice',
    email: ALICE_EMAIL,
    emailVerified: true,
    authMethods: ['github'],
    roles: [] as const,
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: null,
    adminFactorEnrolled: false,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    authzVersion: 1,
    ...overrides,
  };
}

describe('InMemoryConsoleSessionStore', () => {
  it('creates an isolated active self-service session and revokes it immediately', async () => {
    const store = new InMemoryConsoleSessionStore();
    const source = session();
    await store.create(source);
    source.idHash.fill(0);

    expect(await store.findActiveByIdHash(hash(1), FIVE_MINUTES)).toMatchObject({
      userId: USER_ID,
      grantedCapabilities: [SELF_CAPABILITY],
    });
    expect(await store.revoke(hash(1), FIVE_MINUTES)).toBe(true);
    expect(await store.findActiveByIdHash(hash(1), FIVE_MINUTES)).toBeNull();
  });

  it('adds administrative capability only with TOTP-backed elevation evidence', async () => {
    const store = new InMemoryConsoleSessionStore();
    await store.create(session());

    expect(await store.setElevation(hash(1), {
      capabilities: ['console:admin:security'],
      expiresAt: THIRTY_MINUTES,
      acr: ADMIN_ACR,
      amr: ['pwd', 'otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).toBe(true);

    const elevated = await store.findActiveByIdHash(hash(1), FIVE_MINUTES);
    expect(elevated?.grantedCapabilities).toEqual([SELF_CAPABILITY, 'console:admin:security']);
    expect(elevated?.elevation?.amr).toContain('otp');
    expect(await store.setElevation(hash(1), {
      capabilities: ['console:admin:operate'],
      expiresAt: THIRTY_MINUTES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).toBe(false);
    expect(await store.setElevation(hash(1), {
      capabilities: ['console:admin:operate'],
      expiresAt: new Date('2026-05-26T14:00:00.000Z'),
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).toBe(false);
  });

  it('clears active elevation without revoking the ordinary browser session', async () => {
    const store = new InMemoryConsoleSessionStore();
    await store.create(session());
    await expect(store.setElevation(hash(1), {
      capabilities: ['console:admin:security'],
      expiresAt: THIRTY_MINUTES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).resolves.toBe(true);

    expect(await store.clearElevation(hash(1), FIVE_MINUTES)).toBe(true);

    const ordinary = await store.findActiveByIdHash(hash(1), FIVE_MINUTES);
    expect(ordinary?.grantedCapabilities).toEqual([SELF_CAPABILITY]);
    expect(ordinary?.elevation).toBeNull();
    expect(await store.clearElevation(hash(1), FIVE_MINUTES)).toBe(false);
  });

  it('rejects raw-sized identifiers and administrative grants without elevation', async () => {
    const store = new InMemoryConsoleSessionStore();
    await expect(store.create(session({ idHash: Buffer.from('raw-cookie') })))
      .rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.create(session({ grantedCapabilities: [SELF_CAPABILITY, 'console:admin:audit'] })))
      .rejects.toThrow('admin capabilities require an elevation record');
  });

  it('touches only active monotonic sessions and supports user revocation and expiry cleanup', async () => {
    const store = new InMemoryConsoleSessionStore();
    await store.create(session());
    await store.create(session({ idHash: hash(5) }));

    expect(await store.touch(hash(1), {
      lastUsedAt: FOUR_MINUTES,
      idleExpiresAt: THIRTY_MINUTES,
      lastIp: '198.51.100.1',
    }, FOUR_MINUTES)).toBe(true);
    expect(await store.touch(hash(1), {
      lastUsedAt: NOW,
      idleExpiresAt: THIRTY_MINUTES,
    }, FIVE_MINUTES)).toBe(false);
    expect(await store.touch(hash(1), {
      lastUsedAt: FIVE_MINUTES,
      idleExpiresAt: FIVE_MINUTES,
    }, FIVE_MINUTES)).toBe(false);
    expect(await store.revokeForUser(USER_ID, FIVE_MINUTES)).toBe(2);
    expect(await store.findActiveByIdHash(hash(5), FIVE_MINUTES)).toBeNull();
    expect(await store.sweepExpired(ONE_HOUR)).toBe(2);
  });

  it('lists and revokes active sessions for one user without exposing other users', async () => {
    const store = new InMemoryConsoleSessionStore();
    await store.create(session());
    await store.create(session({ idHash: hash(5), lastUsedAt: FIVE_MINUTES }));
    await store.create(session({
      idHash: hash(7),
      idleExpiresAt: FOUR_MINUTES,
      absoluteExpiresAt: FIVE_MINUTES,
    }));
    await store.create(session({ idHash: hash(6), userId: SECOND_USER_ID }));

    expect((await store.listActiveForUser(USER_ID, FIVE_MINUTES)).map(record => record.idHash))
      .toEqual([hash(5), hash(1)]);
    expect(await store.revokeForUserSession(SECOND_USER_ID, hash(5), FIVE_MINUTES)).toBe(false);
    expect(await store.revokeForUserSession(USER_ID, hash(5), FIVE_MINUTES)).toBe(true);
    await store.create(session({ idHash: hash(8), lastUsedAt: FIVE_MINUTES }));
    expect(await store.revokeForUserExcept(USER_ID, hash(1), FIVE_MINUTES)).toBe(2);
    expect(await store.findActiveByIdHash(hash(1), FIVE_MINUTES)).not.toBeNull();
    expect(await store.findActiveByIdHash(hash(8), FIVE_MINUTES)).toBeNull();
  });

  it('rejects elevating self scope or using stale authentication evidence', async () => {
    const store = new InMemoryConsoleSessionStore();
    await store.create(session());

    await expect(store.setElevation(hash(1), {
      capabilities: [SELF_CAPABILITY],
      expiresAt: THIRTY_MINUTES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: FIVE_MINUTES,
    }, FIVE_MINUTES)).rejects.toThrow('administrative capabilities');
    await expect(store.setElevation(hash(1), {
      capabilities: ['console:admin:audit'],
      expiresAt: THIRTY_MINUTES,
      acr: ADMIN_ACR,
      amr: ['otp'],
      authTime: BEFORE_NOW,
    }, FIVE_MINUTES)).rejects.toThrow('timestamps are inconsistent');
  });
});

describe('ConsoleStoreValidation', () => {
  it('detects unique violations through bounded error causes without cycling forever', () => {
    const unique = Object.assign(new Error('duplicate'), { code: '23505' });
    expect(isUniqueViolation(new Error('outer', { cause: unique }))).toBe(true);

    const cyclic: Error & { cause?: unknown } = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});

describe('InMemoryLoginTransactionStore', () => {
  it('consumes matching callback state once and rejects replay or mismatch', async () => {
    const store = new InMemoryLoginTransactionStore();
    await store.create(loginTransaction());

    expect(await store.consume(hash(3), hash(8), FOUR_MINUTES)).toBeNull();
    expect(await store.consume(hash(3), hash(4), FOUR_MINUTES)).toMatchObject({ consumedAt: FOUR_MINUTES });
    expect(await store.consume(hash(3), hash(4), FOUR_MINUTES)).toBeNull();
  });

  it('completes consumed state while retaining it for replay classification', async () => {
    const store = new InMemoryLoginTransactionStore();
    await store.create(loginTransaction());
    await store.consume(hash(3), hash(4), FOUR_MINUTES);

    await expect(store.completeConsumed(hash(3))).resolves.toBe(true);
    await expect(store.findByIdHash(hash(3))).resolves.toMatchObject({
      consumedAt: FOUR_MINUTES,
      expiresAt: FOUR_MINUTES,
    });
  });

  it('requires bound elevated flows and a short relative return target', async () => {
    const store = new InMemoryLoginTransactionStore();
    await expect(store.create(loginTransaction({
      flowKind: 'step_up',
      requestedCapability: 'console:admin:accounts',
    }))).rejects.toThrow('requires principal and session binding');
    await expect(store.create(loginTransaction({ returnTo: 'https://evil.example' })))
      .rejects.toThrow('relative application path');
    await expect(store.create(loginTransaction({ returnTo: String.raw`/\evil.example` })))
      .rejects.toThrow('relative application path');
    await expect(store.create(loginTransaction({ expiresAt: ONE_HOUR })))
      .rejects.toThrow('expire within 10 minutes');
    await expect(store.create(loginTransaction({ pkceVerifierEnc: Buffer.alloc(0) })))
      .rejects.toThrow('encrypted ciphertext');
    await expect(store.create(loginTransaction({
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
      integrationDescriptorId: DESCRIPTOR_ID,
    }))).rejects.toThrow('integrationDescriptorFingerprint');
    await expect(store.create(loginTransaction({
      flowKind: 'integration_link',
      userId: USER_ID,
      consoleSessionIdHash: hash(5),
      integrationDescriptorId: DESCRIPTOR_ID,
      integrationDescriptorFingerprint: DESCRIPTOR_FINGERPRINT,
    }))).resolves.toBeUndefined();
  });

  it('retains in-flight consumed transactions until completion or expiry', async () => {
    const store = new InMemoryLoginTransactionStore();
    await store.create(loginTransaction());
    await store.create(loginTransaction({ idHash: hash(6) }));
    await store.consume(hash(6), hash(4), FOUR_MINUTES);

    expect(await store.sweepExpired(FOUR_MINUTES)).toBe(0);
    await store.completeConsumed(hash(6));
    expect(await store.sweepExpired(FOUR_MINUTES)).toBe(1);
    expect(await store.sweepExpired(FIVE_MINUTES)).toBe(1);
  });

  it('retains a callback consumed just before its original deadline through the completion lease', async () => {
    const store = new InMemoryLoginTransactionStore();
    const consumedAt = new Date(FIVE_MINUTES.getTime() - 1);
    await store.create(loginTransaction());

    const consumed = await store.consume(hash(3), hash(4), consumedAt);

    expect(consumed?.expiresAt.getTime()).toBeGreaterThan(FIVE_MINUTES.getTime());
    expect(await store.sweepExpired(FIVE_MINUTES)).toBe(0);
    await store.completeConsumed(hash(3));
    expect(await store.sweepExpired(consumedAt)).toBe(1);
  });

  it('rejects consumed transactions whose completion lease exceeds five minutes', async () => {
    const store = new InMemoryLoginTransactionStore();
    await expect(store.create(loginTransaction({
      consumedAt: FOUR_MINUTES,
      expiresAt: new Date('2026-05-26T12:09:00.001Z'),
    }))).rejects.toThrow('invalid completion lease');
  });
});

describe('InMemoryUserIntegrationStore', () => {
  it('lists only active integrations owned by the requested user and clones credential fields', async () => {
    const active = userIntegration();
    const store = new InMemoryUserIntegrationStore([
      active,
      userIntegration({
        id: '45e22a52-dc56-4cd0-9d13-b2802524fbd4',
        userId: SECOND_USER_ID,
      }),
      userIntegration({
        id: '55e22a52-dc56-4cd0-9d13-b2802524fbd5',
        status: 'revoked',
        revokedAt: FIVE_MINUTES,
      }),
    ]);

    const rows = await store.listByUser(USER_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: active.id,
      userId: USER_ID,
      provider: 'github',
      externalAccountLabel: 'alice',
    });
    rows[0]?.accessTokenCiphertext?.fill(0);
    expect((await store.findByProvider(USER_ID, 'github'))?.accessTokenCiphertext)
      .toEqual(Buffer.from('encrypted-access-token'));
  });

  it('stores generic provider integrations with scopes-only permission details', async () => {
    const generic = userIntegration({
      provider: 'linear',
      authorizedPermissions: {
        scopes: [READ_ISSUES_SCOPE, 'write:comments'],
      },
    });
    const store = new InMemoryUserIntegrationStore([generic]);

    await expect(store.findByProvider(USER_ID, 'linear')).resolves.toMatchObject({
      provider: 'linear',
      authorizedPermissions: {
        scopes: [READ_ISSUES_SCOPE, 'write:comments'],
      },
    });
  });

  it('serializes concurrent refresh and lets the losing caller reuse the fresh token', async () => {
    const store = new InMemoryUserIntegrationStore([userIntegration({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
    })]);
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    const refresh = async () => {
      refreshCalls += 1;
      await refreshGate;
      return {
        kind: 'refreshed' as const,
        accessTokenCiphertext: Buffer.from('fresh-access'),
        refreshTokenCiphertext: Buffer.from('fresh-refresh'),
        credentialKeyVersion: 'integration-key-v2',
      };
    };

    const first = store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
      refreshedAt: FIVE_MINUTES,
      refresh,
    });
    const second = store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
      refreshedAt: FIVE_MINUTES,
      refresh,
    });
    await Promise.resolve();
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'refreshed' }),
      expect.objectContaining({ kind: 'reused' }),
    ]);
    expect(refreshCalls).toBe(1);
    await expect(store.findByProvider(USER_ID, 'linear')).resolves.toMatchObject({
      status: 'connected',
      credentialKeyVersion: 'integration-key-v2',
      accessTokenCiphertext: Buffer.from('fresh-access'),
      refreshTokenCiphertext: Buffer.from('fresh-refresh'),
    });
  });

  it('records refresh failure without deleting the previous encrypted credential', async () => {
    const store = new InMemoryUserIntegrationStore([userIntegration({
      provider: 'linear',
      authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      accessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
      refreshTokenCiphertext: Buffer.from('stale-refresh'),
    })]);

    await expect(store.refresh({
      userId: USER_ID,
      provider: 'linear',
      integrationDescriptorId: null,
      staleAccessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
      refreshedAt: FIVE_MINUTES,
      refresh: () => Promise.resolve({ kind: 'failed' as const, errorReason: 'token_refresh_failed' }),
    })).resolves.toMatchObject({
      kind: 'failed',
      record: {
        status: 'error',
        errorReason: 'token_refresh_failed',
        accessTokenCiphertext: Buffer.from(STALE_ACCESS_TOKEN),
        refreshTokenCiphertext: Buffer.from('stale-refresh'),
      },
    });
  });

  it('revokes and clears only active credentials bound to a withdrawn descriptor', async () => {
    const store = new InMemoryUserIntegrationStore([
      userIntegration({
        provider: 'linear',
        integrationDescriptorId: DESCRIPTOR_ID,
        authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      }),
      userIntegration({
        id: '45e22a52-dc56-4cd0-9d13-b2802524fbd4',
        userId: SECOND_USER_ID,
        provider: 'linear',
        integrationDescriptorId: DESCRIPTOR_ID,
        authorizedPermissions: { scopes: [READ_ISSUES_SCOPE] },
      }),
      userIntegration({
        id: '55e22a52-dc56-4cd0-9d13-b2802524fbd5',
        provider: 'github',
      }),
    ]);

    await expect(store.revokeAllByDescriptor(DESCRIPTOR_ID, FIVE_MINUTES)).resolves.toBe(2);
    await expect(store.findByProvider(USER_ID, 'linear')).resolves.toBeNull();
    await expect(store.findByProvider(SECOND_USER_ID, 'linear')).resolves.toBeNull();
    await expect(store.findByProvider(USER_ID, 'github')).resolves.toMatchObject({ status: 'connected' });
  });

  it('validates integration records before storing them', () => {
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'read' },
        unsafe_padding: 'x'.repeat(5000),
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'read', administration: 'write' },
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'read' },
        accessToken: 'plaintext-token',
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      accessTokenCiphertext: Buffer.alloc(0),
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      provider: 'GitHub',
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      provider: 'x',
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      provider: 'linear',
      authorizedPermissions: {
        repository_selection: 'selected',
        permissions: { contents: 'read' },
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      provider: 'linear',
      authorizedPermissions: {
        scopes: [READ_ISSUES_SCOPE],
        token: 'plaintext-token',
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      provider: 'linear',
      authorizedPermissions: {
        scopes: [''],
      },
    })])).toThrow(ConsoleStoreValidationError);
    expect(() => new InMemoryUserIntegrationStore([userIntegration({
      status: 'revoked',
      revokedAt: null,
    })])).toThrow(ConsoleStoreValidationError);
  });
});

describe('InMemoryIntegrationDescriptorStore', () => {
  it('stores visible curated and BYO descriptors and clones encrypted client secrets', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const created = await store.upsert(oauthDescriptorInput());

    created.clientSecretCiphertext?.fill(0);

    const found = await store.findVisibleByProvider(USER_ID, 'gmail');
    expect(found).toMatchObject({
      provider: 'gmail',
      ownership: 'byo',
      ownerUserId: USER_ID,
      authStrategy: 'oauth2_authorization_code',
      apiHosts: ['gmail.googleapis.com'],
    });
    expect(found?.clientSecretCiphertext).toEqual(Buffer.from('encrypted-client-secret'));
    await expect(store.findVisibleByProvider(SECOND_USER_ID, 'gmail')).resolves.toBeNull();
  });

  it('paginates visible descriptors with a stable (provider, id) cursor and keeps listVisible complete', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const providers = ['svc-a', 'svc-b', 'svc-c', 'svc-d', 'svc-e'];
    for (const provider of providers) {
      await store.upsert(oauthDescriptorInput({ provider }));
    }

    const first = await store.listVisiblePage(USER_ID, { limit: 2 });
    expect(first.items.map(item => item.provider)).toEqual(['svc-a', 'svc-b']);
    expect(first.nextCursor).not.toBeNull();

    const second = await store.listVisiblePage(USER_ID, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map(item => item.provider)).toEqual(['svc-c', 'svc-d']);

    const third = await store.listVisiblePage(USER_ID, { limit: 2, cursor: second.nextCursor });
    expect(third.items.map(item => item.provider)).toEqual(['svc-e']);
    expect(third.nextCursor).toBeNull();

    await expect(store.listVisible(USER_ID)).resolves.toHaveLength(5);
    await expect(store.listVisiblePage(SECOND_USER_ID, { limit: 2 }))
      .resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('paginates without dropping rows whose provider ids sort differently under localeCompare vs code point', async () => {
    // `_`/`-` order differently under ICU localeCompare than by code point.
    // The sort comparator and the keyset cursor MUST agree or a boundary row
    // vanishes from every later page. These ids diverge between the two orders.
    const store = new InMemoryIntegrationDescriptorStore();
    const providers = ['a-n', 'a560', 'a7m', 'a_d3w', 'a_kdr', 'a_x'];
    for (const provider of providers) {
      await store.upsert(oauthDescriptorInput({ provider }));
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await store.listVisiblePage(USER_ID, { limit: 2, cursor });
      collected.push(...page.items.map(item => item.provider));
      cursor = page.nextCursor;
    } while (cursor);

    // Every id appears exactly once across the paged walk — none skipped.
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect([...collected].sort(byName)).toEqual([...providers].sort(byName));
    expect(new Set(collected).size).toBe(providers.length);
    await expect(store.listVisible(USER_ID)).resolves.toHaveLength(providers.length);
  });

  it('resolves curated strictly over a same-provider BYO descriptor', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    // BYO authored first, curated seeded second — order must not decide the winner.
    await store.upsert(oauthDescriptorInput({ provider: 'shared', apiHosts: ['byo.example.com'] }));
    await store.upsert({
      ...oauthDescriptorInput({ provider: 'shared', apiHosts: ['curated.example.com'] }),
      ownership: 'curated',
      ownerUserId: null,
    });

    const resolved = await store.findVisibleByProvider(USER_ID, 'shared');
    expect(resolved).toMatchObject({ ownership: 'curated', apiHosts: ['curated.example.com'] });
    await expect(store.findCuratedByProvider('shared')).resolves.toMatchObject({
      ownership: 'curated',
      ownerUserId: null,
      apiHosts: ['curated.example.com'],
    });
  });

  it('does not resolve a same-provider BYO descriptor as curated', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    await store.upsert(oauthDescriptorInput({ provider: 'shared' }));

    await expect(store.findCuratedByProvider('shared')).resolves.toBeNull();
  });

  it('rejects invalid pagination limits and cursors', async () => {
    const store = new InMemoryIntegrationDescriptorStore();

    await expect(store.listVisiblePage(USER_ID, { limit: 0 })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { limit: 101 })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { limit: 1.5 })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { cursor: 'garbage' })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.listVisiblePage(USER_ID, { cursor: 'svc-a:not-a-uuid' })).rejects.toThrow(ConsoleStoreValidationError);
  });

  it('scopes findById to the BYO owner and fails closed everywhere else', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const byo = await store.upsert(oauthDescriptorInput());
    const curated = await store.upsert(oauthDescriptorInput({
      provider: 'shared-svc',
      ownership: 'curated' as const,
      ownerUserId: null,
    }));

    await expect(store.findById(byo.id, USER_ID)).resolves.toMatchObject({
      id: byo.id,
      ownership: 'byo',
      ownerUserId: USER_ID,
    });
    // Non-owner, curated-by-id, and unknown id are indistinguishable: null.
    await expect(store.findById(byo.id, SECOND_USER_ID)).resolves.toBeNull();
    await expect(store.findById(curated.id, USER_ID)).resolves.toBeNull();
    await expect(store.findById(DESCRIPTOR_ID, USER_ID)).resolves.toBeNull();
    await expect(store.findById('not-a-uuid', USER_ID)).rejects.toThrow(ConsoleStoreValidationError);
  });

  it('deletes only owned BYO descriptors', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const byo = await store.upsert(oauthDescriptorInput());
    const curated = await store.upsert(oauthDescriptorInput({
      provider: 'shared-svc',
      ownership: 'curated' as const,
      ownerUserId: null,
    }));

    await expect(store.delete(byo.id, SECOND_USER_ID)).resolves.toBe(false);
    await expect(store.delete(curated.id, USER_ID)).resolves.toBe(false);
    await expect(store.listVisible(USER_ID)).resolves.toHaveLength(2);

    await expect(store.delete(byo.id, USER_ID)).resolves.toBe(true);
    await expect(store.delete(byo.id, USER_ID)).resolves.toBe(false);
    await expect(store.findVisibleByProvider(USER_ID, 'gmail')).resolves.toBeNull();
    await expect(store.listVisible(USER_ID)).resolves.toHaveLength(1);
  });

  it('validates descriptor ownership, hosts, URLs, and auth strategy shape', async () => {
    const store = new InMemoryIntegrationDescriptorStore();

    await expect(store.upsert(oauthDescriptorInput({
      ownerUserId: null,
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(oauthDescriptorInput({
      apiHosts: ['localhost'],
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(oauthDescriptorInput({
      apiHosts: ['api.company.corp'],
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(oauthDescriptorInput({
      apiHosts: ['API.Example.com'],
    }))).rejects.toThrow('apiHosts must contain unique canonical hostnames');
    await expect(store.upsert(oauthDescriptorInput({
      apiHosts: ['api.example.com', 'api.example.com'],
    }))).rejects.toThrow('apiHosts must contain unique canonical hostnames');
    const baseOauth = oauthDescriptorInput().oauth;
    if (!baseOauth) throw new Error('fixture oauth missing');
    await expect(store.upsert(oauthDescriptorInput({
      oauth: {
        ...baseOauth,
        tokenUrl: 'http://oauth2.googleapis.com/token',
      },
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert({
      ...oauthDescriptorInput(),
      authStrategy: 'static_api_key',
    })).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert({
      provider: 'airtable',
      ownership: 'byo',
      ownerUserId: USER_ID,
      displayName: 'Airtable',
      category: 'database',
      authStrategy: 'static_api_key',
      apiHosts: ['api.airtable.com'],
      staticApiKey: { injection: { location: 'header', name: 'Authorization', valuePrefix: 'Bearer ' } },
      clientSecretCiphertext: null,
      credentialKeyVersion: null,
      operationPromotion: {},
      createdAt: NOW,
      updatedAt: NOW,
    })).resolves.toMatchObject({ provider: 'airtable' });
  });

  it('keeps legacy private-suffix descriptors readable without permitting new writes', async () => {
    const base = oauthDescriptorInput();
    if (!base.oauth) throw new Error('fixture oauth missing');
    const legacyRecord = {
      id: DESCRIPTOR_ID,
      ...base,
      apiHosts: ['api.company.corp'],
      oauth: {
        ...base.oauth,
        authorizationUrl: 'https://auth.company.corp/authorize',
        tokenUrl: 'https://auth.company.corp/token',
      },
    };
    const store = new InMemoryIntegrationDescriptorStore([legacyRecord]);

    await expect(store.listVisible(USER_ID)).resolves.toEqual([
      expect.objectContaining({ id: DESCRIPTOR_ID, apiHosts: ['api.company.corp'] }),
    ]);
    await expect(store.upsert({ ...base, apiHosts: ['api.company.corp'] }))
      .rejects.toThrow(ConsoleStoreValidationError);
  });

  it('validates basic static-key injection: fixed Authorization header, no prefix', async () => {
    const store = new InMemoryIntegrationDescriptorStore();
    const basicInput = (injection: { location: 'basic'; name: string; valuePrefix: string | null }) => ({
      provider: 'twilio',
      ownership: 'byo' as const,
      ownerUserId: USER_ID,
      displayName: 'Twilio',
      category: 'messaging',
      authStrategy: 'static_api_key' as const,
      apiHosts: ['api.twilio.example'],
      staticApiKey: { injection },
      clientSecretCiphertext: null,
      credentialKeyVersion: null,
      operationPromotion: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(store.upsert(basicInput({ location: 'basic', name: 'Authorization', valuePrefix: null })))
      .resolves.toMatchObject({ staticApiKey: { injection: { location: 'basic' } } });
    await expect(store.upsert(basicInput({ location: 'basic', name: 'X-Custom', valuePrefix: null })))
      .rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(basicInput({ location: 'basic', name: 'Authorization', valuePrefix: 'Basic ' })))
      .rejects.toThrow(ConsoleStoreValidationError);
  });

  it.each(['\ud800', '\udc00'])('rejects malformed Unicode in stored static-key injection descriptors', async malformed => {
    const store = new InMemoryIntegrationDescriptorStore();
    const input = (name: string, valuePrefix: string | null) => ({
      provider: 'airtable',
      ownership: 'byo' as const,
      ownerUserId: USER_ID,
      displayName: 'Airtable',
      category: 'database',
      authStrategy: 'static_api_key' as const,
      apiHosts: ['api.airtable.example'],
      staticApiKey: { injection: { location: 'query' as const, name, valuePrefix } },
      clientSecretCiphertext: null,
      credentialKeyVersion: null,
      operationPromotion: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    await expect(store.upsert(input(`key${malformed}`, null))).rejects.toThrow('well-formed Unicode');
    await expect(store.upsert(input('key', `prefix${malformed}`))).rejects.toThrow('well-formed Unicode');
  });
});

describe('InMemoryIntegrationOpenApiSpecStore', () => {
  it('stores and clones OpenAPI specs', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    const created = await store.upsert(openApiSpecInput());

    (created.spec.paths as Record<string, unknown>).tampered = true;

    await expect(store.findByDescriptorId(DESCRIPTOR_ID)).resolves.toMatchObject({
      descriptorId: DESCRIPTOR_ID,
      specHash: SPEC_HASH,
      spec: {
        openapi: '3.1.0',
        paths: {},
      },
    });
  });

  it('deletes specs by descriptor id and reports whether one existed', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();
    await store.upsert(openApiSpecInput());

    await expect(store.deleteByDescriptorId(DESCRIPTOR_ID)).resolves.toBe(true);
    await expect(store.findByDescriptorId(DESCRIPTOR_ID)).resolves.toBeNull();
    await expect(store.deleteByDescriptorId(DESCRIPTOR_ID)).resolves.toBe(false);
    await expect(store.deleteByDescriptorId('not-a-uuid')).rejects.toThrow(ConsoleStoreValidationError);
  });

  it('rejects invalid OpenAPI specs and non-HTTPS source URLs', async () => {
    const store = new InMemoryIntegrationOpenApiSpecStore();

    await expect(store.upsert(openApiSpecInput({
      spec: { swagger: '2.0', paths: {} },
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(openApiSpecInput({
      sourceUrl: 'http://example.com/openapi.json',
    }))).rejects.toThrow(ConsoleStoreValidationError);
    await expect(store.upsert(openApiSpecInput({
      specHash: 'not-a-hash',
    }))).rejects.toThrow(ConsoleStoreValidationError);
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('claims once, blocks concurrent execution, replays completion, and rejects mismatch', async () => {
    const store = new InMemoryIdempotencyStore();

    const first = await store.claim(idempotencyIdentity());
    expect(first.kind).toBe('claimed');
    expect((await store.claim(idempotencyIdentity())).kind).toBe('in_progress');
    if (first.kind !== 'claimed') throw new Error('fixture claim not acquired');
    await store.complete(first.claim, BODYLESS_COMPLETION);
    expect((await store.claim(idempotencyIdentity())).kind).toBe('replay');
    expect((await store.claim(idempotencyIdentity({
      requestFingerprint: hash(10),
    })))).toEqual({ kind: 'mismatch', mismatchField: 'request_body_fingerprint' });
    expect((await store.claim(idempotencyIdentity({
      httpMethod: 'DELETE',
    })))).toEqual({ kind: 'mismatch', mismatchField: 'http_method' });
    expect((await store.claim(idempotencyIdentity({
      canonicalTarget: '/api/v1/me/sessions/revoke/other',
    })))).toEqual({ kind: 'mismatch', mismatchField: 'canonical_request_target' });
  });

  it('permits reuse of either pending or completed keys only after retention expiration', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.claim(idempotencyIdentity({ expiresAt: FIVE_MINUTES }));

    const replacement = idempotencyIdentity({
      requestFingerprint: hash(10),
      createdAt: THIRTY_MINUTES,
      expiresAt: ONE_HOUR,
    });
    expect((await store.claim(replacement)).kind).toBe('claimed');
  });

  it('accepts only mutating v1 requests retained for at most 24 hours', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.claim(idempotencyIdentity({ httpMethod: 'GET' })))
      .rejects.toThrow('mutating routes');
    await expect(store.claim(idempotencyIdentity({ canonicalTarget: '/legacy/revoke' })))
      .rejects.toThrow('/api/v1');
    await expect(store.claim(idempotencyIdentity({ requestFingerprint: Buffer.alloc(0) })))
      .rejects.toThrow('32-byte digest');
  });

  it('finds retained records and deletes expired responses', async () => {
    const store = new InMemoryIdempotencyStore();
    const claimed = await store.claim(idempotencyIdentity());
    if (claimed.kind !== 'claimed') throw new Error('fixture claim not acquired');
    await store.complete(claimed.claim, BODYLESS_COMPLETION);

    expect(await store.find(hash(1), idempotencyIdentity().idempotencyKey, FIVE_MINUTES))
      .toMatchObject({ responseStatus: 204 });
    expect(await store.sweepExpired(ONE_HOUR)).toBe(1);
    expect(await store.find(hash(1), idempotencyIdentity().idempotencyKey, ONE_HOUR)).toBeNull();
  });

  it('rejects completion by a stale or foreign claim token', async () => {
    const store = new InMemoryIdempotencyStore();
    const claimed = await store.claim(idempotencyIdentity());
    if (claimed.kind !== 'claimed') throw new Error('fixture claim not acquired');

    await expect(store.complete({
      ...claimed.claim,
      claimId: 'bbe7c4c5-b59e-4bd0-9f8d-c892577ba944',
    }, BODYLESS_COMPLETION)).rejects.toThrow('not active');
  });

  it('isolates equal keys by browser session and sweeps pending claims', async () => {
    const store = new InMemoryIdempotencyStore();

    expect((await store.claim(idempotencyIdentity())).kind).toBe('claimed');
    expect((await store.claim(idempotencyIdentity({
      consoleSessionIdHash: hash(8),
    }))).kind).toBe('claimed');
    expect(await store.sweepExpired(ONE_HOUR)).toBe(2);
  });
});

describe('InMemoryConsoleFactorStore', () => {
  it('stores principal-owned TOTP status without exposing seed material', async () => {
    const store = new InMemoryConsoleFactorStore();
    const source = totpFactor();
    await store.createTotpFactor(source, [hash(11), hash(12)]);
    source.secretCiphertext.fill(0);

    expect(await store.getTotpStatus(USER_ID)).toEqual({
      enrolled: true,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: null,
      lastUsedAt: null,
      backupCodesRemaining: 2,
    });

    const asRecord = await store.getActiveTotpFactorForAs(USER_ID);
    expect(asRecord?.secretCiphertext).toEqual(Buffer.from('encrypted-totp-seed'));
  });

  it('permits only one active TOTP factor per principal and allows re-enrollment after disable', async () => {
    const store = new InMemoryConsoleFactorStore();
    await store.createTotpFactor(totpFactor(), [hash(11)]);

    await expect(store.createTotpFactor(totpFactor({
      factorId: '7acb0d42-8772-4326-a08f-f816b59fc176',
    }), [hash(12)])).rejects.toThrow('active TOTP factor already exists');

    expect(await store.disableActiveTotp(USER_ID, FOUR_MINUTES)).toBe(true);
    expect(await store.getTotpStatus(USER_ID)).toEqual({
      enrolled: false,
      factorType: 'totp',
      enrolledAt: NOW,
      disabledAt: FOUR_MINUTES,
      lastUsedAt: null,
      backupCodesRemaining: 0,
    });

    await expect(store.createTotpFactor(totpFactor({
      factorId: '7acb0d42-8772-4326-a08f-f816b59fc176',
      enrolledAt: FIVE_MINUTES,
    }), [hash(12)])).resolves.toBeUndefined();
    expect((await store.getTotpStatus(USER_ID)).enrolled).toBe(true);
  });

  it('marks proof use only for the active owner factor', async () => {
    const store = new InMemoryConsoleFactorStore();
    await store.createTotpFactor(totpFactor(), [hash(11)]);

    expect(await store.markTotpUsed(USER_ID, FACTOR_ID, FIVE_MINUTES)).toBe(true);
    expect((await store.getTotpStatus(USER_ID)).lastUsedAt).toEqual(FIVE_MINUTES);
    expect(await store.markTotpUsed('718c692b-d62b-418b-a495-8255e125ff51', FACTOR_ID, FIVE_MINUTES)).toBe(false);
    expect(await store.disableActiveTotp(USER_ID, FIVE_MINUTES)).toBe(true);
    expect(await store.markTotpUsed(USER_ID, FACTOR_ID, FIVE_MINUTES)).toBe(false);
  });

  it('atomically consumes active backup codes once', async () => {
    const store = new InMemoryConsoleFactorStore();
    await store.createTotpFactor(totpFactor(), [hash(11), hash(12)]);

    expect(await store.consumeBackupCode(USER_ID, FACTOR_ID, hash(11), FIVE_MINUTES)).toBe(true);
    expect(await store.consumeBackupCode(USER_ID, FACTOR_ID, hash(11), FIVE_MINUTES)).toBe(false);
    expect(await store.consumeBackupCode(USER_ID, FACTOR_ID, hash(12), BEFORE_NOW)).toBe(false);
    expect(await store.disableActiveTotp(USER_ID, FIVE_MINUTES)).toBe(true);
    expect(await store.consumeBackupCode(USER_ID, FACTOR_ID, hash(12), FIVE_MINUTES)).toBe(false);
  });

  it('rejects plaintext-sized invalid factor material', async () => {
    const store = new InMemoryConsoleFactorStore();

    await expect(store.createTotpFactor(totpFactor({ secretCiphertext: Buffer.alloc(0) }), [hash(11)]))
      .rejects.toThrow('encrypted ciphertext');
    await expect(store.createTotpFactor(totpFactor(), [Buffer.from('backup-code')]))
      .rejects.toThrow('32-byte keyed hash');
  });
});

describe('InMemoryConsoleIdentityResolver', () => {
  it('resolves canonical enabled principals and fails closed for disabled or unmapped subjects', async () => {
    const resolver = new InMemoryConsoleIdentityResolver([{
      sub: 'enabled',
      userId: USER_ID,
      disabledAt: null,
      authzVersion: 3,
    }, {
      sub: 'disabled',
      userId: USER_ID,
      disabledAt: NOW,
      authzVersion: 4,
    }]);

    await expect(resolver.resolveEnabledPrincipal('enabled')).resolves.toMatchObject({
      userId: USER_ID,
      authzVersion: 3,
    });
    await expect(resolver.resolveEnabledPrincipal('disabled')).resolves.toBeNull();
    await expect(resolver.resolveEnabledPrincipal('missing')).resolves.toBeNull();
  });
});

describe('InMemoryConsoleAccountAdminStore', () => {
  it('projects principal metadata only and manages active role history', async () => {
    const store = new InMemoryConsoleAccountAdminStore([
      principal(),
      principal({
        userId: SECOND_USER_ID,
        primarySub: 'github_user-8',
        username: 'bob',
        roles: ['admin'],
        accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
      }),
    ]);

    const grant = await store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: null,
      grantedAt: FIVE_MINUTES,
    });

    expect(grant).toMatchObject({ userId: USER_ID, role: 'account_admin', revokedAt: null });
    await expect(store.grantRole({
      userId: USER_ID,
      role: 'account_admin',
      grantedByUserId: null,
      grantedAt: FIVE_MINUTES,
    })).rejects.toThrow('already active');
    expect(await store.listActiveRoles(USER_ID)).toEqual(['account_admin']);
    expect((await store.findPrincipal(USER_ID))?.roles).toEqual(['account_admin']);
    expect((await store.findPrincipalByAccountCorrelationId(ACCOUNT_CORRELATION_ID))?.userId)
      .toBe(USER_ID);
    expect((await store.findPrincipal(USER_ID))?.authzVersion).toBe(2);

    const revoked = await store.revokeRole({
      userId: USER_ID,
      role: 'account_admin',
      revokedByUserId: USER_ID,
      revokedAt: THIRTY_MINUTES,
    });

    expect(revoked).toMatchObject({ role: 'account_admin', revokedAt: THIRTY_MINUTES });
    expect(await store.listActiveRoles(USER_ID)).toEqual([]);
    expect((await store.findPrincipal(USER_ID))?.authzVersion).toBe(3);
  });

  it('counts only enabled account administrators and bumps security version on disablement', async () => {
    const store = new InMemoryConsoleAccountAdminStore([
      principal({ roles: ['account_admin'] }),
      principal({
        userId: SECOND_USER_ID,
        primarySub: 'github_user-8',
        username: 'bob',
        roles: ['admin'],
        accountCorrelationId: '11df9917-b534-4014-a03f-e2eb1f0c6fef',
      }),
    ]);

    expect(await store.countEnabledAccountsAdmins()).toBe(2);
    expect(await store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES }))
      .toMatchObject({ userId: USER_ID, disabledAt: FIVE_MINUTES, authzVersion: 2 });
    expect(await store.countEnabledAccountsAdmins()).toBe(1);
    expect(await store.disablePrincipal({ userId: USER_ID, disabledAt: THIRTY_MINUTES })).toBeNull();
    expect(await store.enablePrincipal({ userId: USER_ID, enabledAt: THIRTY_MINUTES }))
      .toMatchObject({ userId: USER_ID, disabledAt: null, authzVersion: 3 });
  });

  it('rejects missing principals and prevents orphaning the last accounts administrator', async () => {
    const store = new InMemoryConsoleAccountAdminStore([principal({ roles: ['account_admin'] })]);

    await expect(store.grantRole({
      userId: SECOND_USER_ID,
      role: 'operator',
      grantedByUserId: USER_ID,
      grantedAt: FIVE_MINUTES,
    })).rejects.toThrow('principal does not exist');
    await expect(store.revokeRole({
      userId: SECOND_USER_ID,
      role: 'operator',
      revokedByUserId: USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toBeNull();
    await expect(store.revokeRole({
      userId: USER_ID,
      role: 'account_admin',
      revokedByUserId: USER_ID,
      revokedAt: FIVE_MINUTES,
    })).resolves.toBeNull();
    await expect(store.disablePrincipal({ userId: USER_ID, disabledAt: FIVE_MINUTES })).resolves.toBeNull();
  });
});

describe('InMemoryConsoleAccountAllowlistStore', () => {
  it('normalizes active duplicates while preserving removal history', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();

    const created = await store.add({
      kind: 'email',
      value: ' Alice@Example.Test ',
      note: 'initial',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    });

    expect(created).toMatchObject({
      kind: 'email',
      normalizedValue: ALICE_EMAIL,
      displayValue: 'Alice@Example.Test',
      note: 'initial',
      createdByUserId: USER_ID,
      revokedAt: null,
    });
    await expect(store.add({
      kind: 'email',
      value: ALICE_EMAIL,
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('already exists');

    await expect(store.update({ id: created.id, note: null })).resolves.toMatchObject({ note: null });
    await expect(store.remove({
      id: created.id,
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    })).resolves.toMatchObject({
      id: created.id,
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    });
    await expect(store.findActive(created.id)).resolves.toBeNull();
    await expect(store.add({
      kind: 'email',
      value: ALICE_EMAIL,
      createdByUserId: USER_ID,
      createdAt: THIRTY_MINUTES,
    })).resolves.toMatchObject({ normalizedValue: ALICE_EMAIL, revokedAt: null });
    await expect(store.listActive()).resolves.toHaveLength(1);
  });

  it('preserves github_id values exactly and leaves note unchanged when omitted', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();

    const created = await store.add({
      kind: 'github_id',
      value: '00123',
      note: 'numeric id',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    });
    await expect(store.add({
      kind: 'github_id',
      value: '123',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).resolves.toMatchObject({ normalizedValue: '123' });
    await expect(store.update({ id: created.id })).resolves.toMatchObject({
      id: created.id,
      normalizedValue: '00123',
      note: 'numeric id',
    });
  });

  it('matches active sign-in identities without treating revoked entries as authority', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();

    const email = await store.add({
      kind: 'email',
      value: ' Alice@Example.Test ',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    });
    await store.add({
      kind: 'github_username',
      value: 'Mick',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    });

    await expect(store.hasActiveEntries()).resolves.toBe(true);
    await expect(store.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(true);
    await expect(store.matchesIdentity({ githubUsername: 'mick' })).resolves.toBe(true);
    await expect(store.matchesIdentity({ githubId: '123' })).resolves.toBe(false);

    await store.remove({
      id: email.id,
      revokedByUserId: SECOND_USER_ID,
      revokedAt: THIRTY_MINUTES,
    });
    await expect(store.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(false);
  });

  it('validates allowlist inputs before storing entries', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();

    await expect(store.add({
      kind: 'github_id',
      value: ' ',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('value must be non-empty');
    await expect(store.add({
      kind: 'email',
      value: 'not-an-email',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('valid email');
    await expect(store.add({
      kind: 'github_username',
      value: 'alice example',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('valid GitHub username');
    await expect(store.add({
      kind: 'github_id',
      value: 'abc',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('numeric GitHub id');
    await expect(store.update({ id: 'not-a-uuid', note: 'x' })).rejects.toThrow('id must be a UUID');
    await expect(store.remove({
      id: USER_ID,
      revokedByUserId: 'not-a-uuid',
      revokedAt: FIVE_MINUTES,
    })).rejects.toThrow('revokedByUserId must be a UUID');
  });

  it('rejects non-ASCII GitHub usernames instead of rewriting confusables', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();

    await expect(store.add({
      kind: 'github_username',
      value: 'ｍick',
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('valid GitHub username');
  });

  it('preserves distinct Unicode email principals while canonicalizing NFC', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore();
    const cyrillicAlice = '\u0430lice@example.test';
    const entry = await store.add({
      kind: 'email',
      value: cyrillicAlice,
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
    });

    expect(entry.displayValue).toBe(cyrillicAlice);
    expect(entry.normalizedValue).toBe(cyrillicAlice);
    await expect(store.matchesIdentity({ email: cyrillicAlice })).resolves.toBe(true);
    await expect(store.matchesIdentity({ email: 'alice@example.test' })).resolves.toBe(false);
    await expect(store.matchesIdentity({ email: '\u0410lice@example.test' })).resolves.toBe(false);
  });

  it('uses the preserved display identity for legacy Unicode-cased rows', async () => {
    const store = new InMemoryConsoleAccountAllowlistStore([{
      id: FACTOR_ID,
      kind: 'email',
      normalizedValue: '\u00e4lice@example.test',
      displayValue: '\u00c4lice@example.test',
      note: null,
      createdByUserId: USER_ID,
      createdAt: FIVE_MINUTES,
      revokedByUserId: null,
      revokedAt: null,
    }]);

    await expect(store.matchesIdentity({ email: '\u00c4lice@example.test' })).resolves.toBe(true);
    await expect(store.matchesIdentity({ email: '\u00e4lice@example.test' })).resolves.toBe(false);
    await expect(store.add({
      kind: 'email',
      value: '\u00c4lice@example.test',
      createdByUserId: USER_ID,
      createdAt: THIRTY_MINUTES,
    })).rejects.toThrow('already exists');
  });
});

describe('InMemoryConsoleSecurityInvalidationStore', () => {
  it('appends durable-ordered invalidation events and advances replica cursors monotonically', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();

    const event = await store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 2,
      reason: 'admin_disabled',
      payload: { revokedSessions: 2 },
      createdAt: FIVE_MINUTES,
      createdByUserId: SECOND_USER_ID,
    });
    const second = await store.appendEvent({
      kind: 'console_session_revoked',
      urgency: 'eventual',
      userId: null,
      consoleSessionIdHash: hash(1),
      reason: 'user_logout',
      createdAt: THIRTY_MINUTES,
    });

    expect(event.sequenceId).toBe(1);
    expect(second.sequenceId).toBe(2);
    expect(await store.listEventsAfter(0)).toHaveLength(2);

    await store.recordReplicaCursor('replica-a', 2, THIRTY_MINUTES);
    await store.recordReplicaCursor('replica-a', 1, THIRTY_MINUTES);
    expect(await store.getReplicaCursor('replica-a')).toBe(2);
    expect(await store.listEventsAfter(2)).toEqual([]);
    await expect(store.listEventsAfter(-1)).rejects.toThrow('non-negative integer');
    await expect(store.listEventsAfter(0, 1001)).rejects.toThrow('between 1 and 1000');
  });

  it('tracks live leases and idempotent event acknowledgements', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    const event = await store.appendEvent({
      kind: 'admin_factor_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      reason: 'factor_disabled',
      createdAt: FIVE_MINUTES,
    });

    await store.acquireReplicaLease({
      replicaId: 'replica-b',
      renewedAt: FIVE_MINUTES,
      leaseUntil: THIRTY_MINUTES,
    });
    await store.acquireReplicaLease({
      replicaId: 'replica-a',
      renewedAt: BEFORE_NOW,
      leaseUntil: FIVE_MINUTES,
    });
    expect(await store.listLiveReplicaIds(new Date('2026-05-26T12:06:00.000Z'))).toEqual(['replica-b']);

    await store.acknowledgeEvent(event.eventId, 'replica-b', FIVE_MINUTES);
    await store.acknowledgeEvent(event.eventId, 'replica-b', THIRTY_MINUTES);
    expect(await store.listAcknowledgedReplicaIds(event.eventId)).toEqual(['replica-b']);
  });

  it('rejects invalid event inputs before durable append', async () => {
    const store = new InMemoryConsoleSecurityInvalidationStore();
    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: null,
      reason: 'admin_disabled',
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('userId is required');
    await expect(store.appendEvent({
      kind: 'console_session_revoked',
      urgency: 'eventual',
      userId: null,
      consoleSessionIdHash: Buffer.from('raw-session'),
      reason: 'user_logout',
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('32-byte keyed hash');
    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      authzVersion: 0,
      reason: 'admin_disabled',
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('positive integer');
    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      reason: 'x'.repeat(201),
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('at most 200');
    await expect(store.appendEvent({
      kind: 'principal_disabled',
      urgency: 'acknowledged',
      userId: USER_ID,
      reason: 'admin_disabled',
      payload: { secret: 'not allowed' },
      createdAt: FIVE_MINUTES,
    })).rejects.toThrow('not allowed');
  });
});

describe('InMemoryRuntimeSessionControlStore', () => {
  it('registers, heartbeats, lists, and closes runtime presence without exposing stale leases', async () => {
    const store = new InMemoryRuntimeSessionControlStore();

    const presence = await store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });

    expect(presence).toMatchObject({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      requestCount: 0,
      errorCount: 0,
      status: 'active',
    });
    await expect(store.findPresence(RUNTIME_SESSION_ID, NOW)).resolves.toMatchObject({
      clientInfo: { name: 'Dollhouse CLI', version: '1.0.0' },
    });
    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: FOUR_MINUTES,
      requestCount: 3,
      errorCount: 1,
      leaseUntil: THIRTY_MINUTES,
    })).resolves.toMatchObject({
      kind: 'updated',
      presence: {
        requestCount: 3,
        errorCount: 1,
        leaseUntil: THIRTY_MINUTES,
      },
    });
    await expect(store.listPresenceByUser(USER_ID, { now: FIVE_MINUTES })).resolves.toHaveLength(1);
    expect((await store.listOperationalPresence({ now: FIVE_MINUTES })).items).toHaveLength(1);
    await expect(store.findPresence(RUNTIME_SESSION_ID, THIRTY_MINUTES)).resolves.toBeNull();
    await expect(store.findPresence(RUNTIME_SESSION_ID, ONE_HOUR)).resolves.toBeNull();

    const closing = await store.markPresenceClosing(RUNTIME_SESSION_ID, THIRTY_MINUTES);
    expect(closing).toMatchObject({ status: 'closing', closedAt: THIRTY_MINUTES });
    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: THIRTY_MINUTES,
      requestCount: 4,
      errorCount: 1,
      leaseUntil: ONE_HOUR,
    })).resolves.toEqual({ kind: 'lost', reason: 'closing' });
    await expect(store.listPresenceByUser(USER_ID, { now: FIVE_MINUTES })).resolves.toEqual([]);
    await expect(store.sweepStalePresence(ONE_HOUR)).resolves.toBe(1);
    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: ONE_HOUR,
      requestCount: 5,
      errorCount: 1,
      leaseUntil: new Date(ONE_HOUR.getTime() + 1_000),
    })).resolves.toEqual({ kind: 'lost', reason: 'missing' });
  });

  it('uses last registration wins semantics and hides mixed invisible runtime presence rows', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    await store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: THIRTY_MINUTES,
    });
    await store.registerPresence({
      sessionId: RUNTIME_SESSION_ID,
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-b',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: FIVE_MINUTES,
      leaseUntil: ONE_HOUR,
    });
    await store.registerPresence({
      sessionId: 'mcp-session-expired',
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    });

    await expect(store.heartbeatPresence({
      sessionId: RUNTIME_SESSION_ID,
      replicaId: 'replica-a',
      lastActiveAt: THIRTY_MINUTES,
      requestCount: 5,
      errorCount: 0,
      leaseUntil: ONE_HOUR,
    })).resolves.toEqual({ kind: 'lost', reason: 'replica_mismatch' });
    await expect(store.heartbeatPresence({
      sessionId: 'missing-session',
      replicaId: 'replica-a',
      lastActiveAt: THIRTY_MINUTES,
      requestCount: 1,
      errorCount: 0,
      leaseUntil: ONE_HOUR,
    })).resolves.toEqual({ kind: 'lost', reason: 'missing' });
    await expect(store.listPresenceByUser(USER_ID, { now: THIRTY_MINUTES })).resolves.toEqual([
      expect.objectContaining({ sessionId: RUNTIME_SESSION_ID, replicaId: 'replica-b' }),
    ]);
    await expect(store.sweepStalePresence(FIVE_MINUTES)).resolves.toBe(0);
    await expect(store.sweepStalePresence(THIRTY_MINUTES)).resolves.toBe(1);
    await expect(store.listOperationalPresence({ now: THIRTY_MINUTES })).resolves.toEqual({
      items: [expect.objectContaining({ sessionId: RUNTIME_SESSION_ID, replicaId: 'replica-b' })],
      nextCursor: null,
    });
  });

  it('persists pending termination commands and idempotent acknowledgements', async () => {
    const store = new InMemoryRuntimeSessionControlStore();

    const command = await store.createTerminationCommand({
      commandId: RUNTIME_COMMAND_ID,
      sessionId: RUNTIME_SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'admin_terminated',
      requestedAt: NOW,
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    });

    expect(command).toMatchObject({
      commandId: RUNTIME_COMMAND_ID,
      kind: 'terminate_session',
      sessionId: RUNTIME_SESSION_ID,
      targetReplicaId: 'replica-a',
      requestedBy: { kind: 'admin', userId: SECOND_USER_ID },
    });
    await expect(store.listPendingCommandsForReplica('replica-a')).resolves.toEqual([command]);
    await expect(store.acknowledgeCommand({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
    })).resolves.toBe(true);
    await expect(store.acknowledgeCommand({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-b',
      acknowledgedAt: THIRTY_MINUTES,
      result: 'failed',
      errorCode: 'late_duplicate',
    })).resolves.toBe(false);
    await expect(store.listPendingCommandsForReplica('replica-a')).resolves.toEqual([]);
    await expect(store.getCommandAck(RUNTIME_COMMAND_ID)).resolves.toEqual({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'terminated',
      errorCode: null,
    });
  });

  it('rejects malformed runtime-control input at the store boundary', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    await expect(store.registerPresence({
      sessionId: '',
      userId: USER_ID,
      accountCorrelationId: ACCOUNT_CORRELATION_ID,
      replicaId: 'replica-a',
      transport: RUNTIME_TRANSPORT,
      startedAt: NOW,
      lastActiveAt: NOW,
      leaseUntil: FIVE_MINUTES,
    })).rejects.toThrow('sessionId must be non-empty');
    await expect(store.createTerminationCommand({
      commandId: RUNTIME_COMMAND_ID,
      sessionId: RUNTIME_SESSION_ID,
      targetReplicaId: 'replica-a',
      reason: 'admin_terminated',
      requestedAt: NOW,
      requestedBy: { kind: 'system', userId: USER_ID },
    })).rejects.toThrow('system requester');
    await expect(store.acknowledgeCommand({
      commandId: RUNTIME_COMMAND_ID,
      replicaId: 'replica-a',
      acknowledgedAt: FIVE_MINUTES,
      result: 'failed',
    })).rejects.toThrow('errorCode is required');
  });
});
