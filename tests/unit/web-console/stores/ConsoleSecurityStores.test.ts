import { describe, expect, it } from '@jest/globals';

import {
  ConsoleStoreValidationError,
  InMemoryConsoleSessionStore,
  InMemoryConsoleFactorStore,
  InMemoryConsoleAccountAdminStore,
  InMemoryIdempotencyStore,
  InMemoryLoginTransactionStore,
  isUniqueViolation,
} from '../../../../src/web-console/stores/index.js';
import { InMemoryConsoleSecurityInvalidationStore } from '../../../../src/web-console/services/invalidation/index.js';
import { InMemoryConsoleIdentityResolver } from '../../../../src/web-console/identity/index.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { ConsoleTotpFactorRecord } from '../../../../src/web-console/stores/IConsoleFactorStore.js';
import type {
  IdempotencyCompletion,
  IdempotencyRequestIdentity,
} from '../../../../src/web-console/stores/IIdempotencyStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const FACTOR_ID = 'cd8f6d0e-7294-42bc-9e01-094890a820a8';
const BEFORE_NOW = new Date('2026-05-26T11:59:00.000Z');
const NOW = new Date('2026-05-26T12:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-26T12:05:00.000Z');
const FOUR_MINUTES = new Date('2026-05-26T12:04:00.000Z');
const THIRTY_MINUTES = new Date('2026-05-26T12:30:00.000Z');
const ONE_HOUR = new Date('2026-05-26T13:00:00.000Z');
const SELF_CAPABILITY = 'console:self' as const;
const ADMIN_ACR = 'urn:dollhouse:acr:admin';

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
    email: 'alice@example.test',
    emailVerified: true,
    authMethods: ['github'],
    roles: [] as const,
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: null,
    adminFactorEnrolled: false,
    accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
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
  });

  it('removes expired and consumed transient transactions', async () => {
    const store = new InMemoryLoginTransactionStore();
    await store.create(loginTransaction());
    await store.create(loginTransaction({ idHash: hash(6) }));
    await store.consume(hash(6), hash(4), FOUR_MINUTES);

    expect(await store.sweepExpired(FIVE_MINUTES)).toBe(2);
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
    expect((await store.findPrincipalByAccountCorrelationId('7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8'))?.userId)
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
