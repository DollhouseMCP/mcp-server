import { describe, expect, it } from '@jest/globals';

import {
  ConsoleStoreValidationError,
  InMemoryConsoleSessionStore,
  InMemoryIdempotencyStore,
  InMemoryLoginTransactionStore,
} from '../../../../src/web-console/stores/index.js';
import { InMemoryConsoleIdentityResolver } from '../../../../src/web-console/identity/index.js';
import type { ConsoleSessionRecord } from '../../../../src/web-console/stores/IConsoleSessionStore.js';
import type { ConsoleLoginTransaction } from '../../../../src/web-console/stores/ILoginTransactionStore.js';
import type { IdempotencyRecord } from '../../../../src/web-console/stores/IIdempotencyStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
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

function idempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    consoleSessionIdHash: hash(1),
    idempotencyKey: 'a51d7564-c85e-4e11-b319-dbc156d26f70',
    httpMethod: 'POST',
    canonicalTarget: '/api/v1/me/sessions/revoke',
    requestFingerprint: hash(9),
    responseStatus: 204,
    responseBody: null,
    createdAt: NOW,
    expiresAt: ONE_HOUR,
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
      authTime: NOW,
    }, FIVE_MINUTES)).rejects.toThrow('timestamps are inconsistent');
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
  it('returns stored response for identical retry and rejects mismatched retry identity', async () => {
    const store = new InMemoryIdempotencyStore();

    expect((await store.saveCompleted(idempotencyRecord())).kind).toBe('created');
    expect((await store.saveCompleted(idempotencyRecord())).kind).toBe('replay');
    expect((await store.saveCompleted(idempotencyRecord({
      requestFingerprint: hash(10),
    }))).kind).toBe('mismatch');
  });

  it('permits reuse of a key once its retained response has expired', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.saveCompleted(idempotencyRecord({ expiresAt: FIVE_MINUTES }));

    const replacement = idempotencyRecord({
      requestFingerprint: hash(10),
      createdAt: THIRTY_MINUTES,
      expiresAt: ONE_HOUR,
    });
    expect((await store.saveCompleted(replacement)).kind).toBe('created');
  });

  it('accepts only mutating v1 requests retained for at most 24 hours', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.saveCompleted(idempotencyRecord({ httpMethod: 'GET' })))
      .rejects.toThrow('mutating routes');
    await expect(store.saveCompleted(idempotencyRecord({ canonicalTarget: '/legacy/revoke' })))
      .rejects.toThrow('/api/v1');
    await expect(store.saveCompleted(idempotencyRecord({ requestFingerprint: Buffer.alloc(0) })))
      .rejects.toThrow('32-byte digest');
  });

  it('finds retained records and deletes expired responses', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.saveCompleted(idempotencyRecord());

    expect(await store.find(hash(1), idempotencyRecord().idempotencyKey, FIVE_MINUTES))
      .toMatchObject({ responseStatus: 204 });
    expect(await store.sweepExpired(ONE_HOUR)).toBe(1);
    expect(await store.find(hash(1), idempotencyRecord().idempotencyKey, ONE_HOUR)).toBeNull();
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
