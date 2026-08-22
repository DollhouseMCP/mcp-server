/**
 * ISigningKeyStore parity tests.
 *
 * Same suite runs against all three implementations (InMemory, Filesystem,
 * Postgres). Postgres backend gated on Docker Postgres reachability via
 * `DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1`.
 *
 * The central concern is rotation semantics: at most one active key per
 * kind, audit trail of rotated keys preserved, and the partial unique
 * index (Postgres) catches concurrent rotation races.
 *
 * @since Phase 4.5 storage completion — Phase D
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import {
  InMemorySigningKeyStore,
  FilesystemSigningKeyStore,
  type ISigningKeyStore,
  type SigningKeyWrite,
} from '../../../src/storage/signingKeys/index.js';
import { PostgresSigningKeyStore } from '../../../src/storage/signingKeys/PostgresSigningKeyStore.js';
import { SigningKeyPayloadEncryption } from '../../../src/storage/signingKeys/signingKeyPayloadEncryption.js';
import { AeadSecretEncryptionService } from '../../../src/web-console/security/SecretEncryption.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { authSigningKeys } from '../../../src/database/schema/index.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from '../database/test-db-helpers.js';
import { crashFilesystemGuardOwner } from '../../helpers/crashFilesystemGuardOwner.js';
import type { FilesystemProcessIncarnation } from '../../../src/security/filesystemInterprocessGuard.js';

let kidCounter = 0;
const GENERATION_A = 'a'.repeat(43);
const GENERATION_B = 'b'.repeat(43);

function modeTransition(
  replacements: readonly SigningKeyWrite[],
  options: { expected?: string; target?: string; transitionId?: string } = {},
) {
  return {
    replacements,
    transitionId: options.transitionId ?? randomUUID(),
    expectedGenerationFingerprint: options.expected,
    targetGenerationFingerprint: options.target ?? GENERATION_A,
  };
}
function freshKid(prefix: string = 'kid'): string {
  kidCounter++;
  return `${prefix}-${Date.now()}-${kidCounter}`;
}

function makeJwksWrite(overrides: Partial<SigningKeyWrite> = {}): SigningKeyWrite {
  return {
    kid: freshKid('jwk'),
    kind: 'jwks',
    payload: {
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      x: 'test-x-coord',
      y: 'test-y-coord',
      d: 'test-d-private',
    },
    ...overrides,
  };
}

function makeCookieWrite(overrides: Partial<SigningKeyWrite> = {}): SigningKeyWrite {
  return {
    kid: freshKid('cookie'),
    kind: 'cookie',
    payload: {
      secret: 'YmFzZTY0LWVuY29kZWQtc2VjcmV0',
      length: 32,
    },
    ...overrides,
  };
}

function makeInviteWrite(overrides: Partial<SigningKeyWrite> = {}): SigningKeyWrite {
  return {
    kid: freshKid('invite'),
    kind: 'invite',
    payload: {
      secret: 'aW52aXRlLXNlY3JldC1iYXNlNjQ=',
      length: 32,
    },
    ...overrides,
  };
}

async function seedSigningKeyProcessLock(
  rootDir: string,
  incarnation: FilesystemProcessIncarnation,
): Promise<void> {
  const now = Date.now();
  await fs.writeFile(path.join(rootDir, '.signing-keys.lock'), JSON.stringify({
    ownerToken: randomUUID(),
    pid: process.pid,
    host: os.hostname(),
    incarnation,
    state: 'held',
    createdAt: now,
    updatedAt: now,
  }), { mode: 0o600 });
}

function testPayloadEncryption(): SigningKeyPayloadEncryption {
  return new SigningKeyPayloadEncryption(
    new AeadSecretEncryptionService({ keyId: 'storage-parity', key: Buffer.alloc(32, 0x31) }),
    'storage-parity',
  );
}

function runContractSuite(
  factory: () => Promise<ISigningKeyStore>,
  cleanup: (store: ISigningKeyStore) => Promise<void>,
): void {
  let store: ISigningKeyStore;

  beforeEach(async () => {
    store = await factory();
  });

  afterEach(async () => {
    await cleanup(store);
  });

  describe('getActive() / getByKid() / listByKind()', () => {
    it('getActive returns null when no key of that kind exists', async () => {
      expect(await store.getActive('jwks')).toBeNull();
      expect(await store.getActive('cookie')).toBeNull();
    });

    it('getByKid returns null for unknown kid', async () => {
      expect(await store.getByKid('does-not-exist')).toBeNull();
    });

    it('listByKind returns empty when no keys exist', async () => {
      expect(await store.listByKind('jwks')).toEqual([]);
      expect(await store.listByKind('cookie')).toEqual([]);
    });

    it('after rotate, getActive returns the new key', async () => {
      const write = makeJwksWrite();
      await store.rotate(write);
      const active = await store.getActive('jwks');
      expect(active?.kid).toBe(write.kid);
      expect(active?.active).toBe(true);
      expect(active?.kind).toBe('jwks');
      expect(active?.payload).toEqual(write.payload);
    });

    it('after rotate, getByKid finds the key', async () => {
      const write = makeJwksWrite();
      await store.rotate(write);
      const found = await store.getByKid(write.kid);
      expect(found?.kid).toBe(write.kid);
    });

    it('createdAt is populated on rotate', async () => {
      const write = makeJwksWrite();
      const before = Date.now();
      await store.rotate(write);
      const after = Date.now();
      const found = await store.getByKid(write.kid);
      expect(found?.createdAt).toBeGreaterThanOrEqual(before);
      expect(found?.createdAt).toBeLessThanOrEqual(after + 100);
      expect(found?.rotatedAt).toBeUndefined();
    });

    it('assertActiveKey rejects a stale prebinding after rotation', async () => {
      const first = makeInviteWrite();
      await store.rotate(first);
      await expect(store.assertActiveKey(first.kid, 'invite')).resolves.toMatchObject({ kid: first.kid });
      await store.rotate(makeInviteWrite());
      await expect(store.assertActiveKey(first.kid, 'invite')).rejects.toThrow(/no longer the active/u);
    });
  });

  describe('rotate() semantics', () => {
    it('marks the previous active key inactive when rotating', async () => {
      const oldKey = makeJwksWrite();
      const newKey = makeJwksWrite();
      await store.rotate(oldKey);
      await store.rotate(newKey);

      const oldFound = await store.getByKid(oldKey.kid);
      expect(oldFound?.active).toBe(false);
      expect(oldFound?.rotatedAt).toBeGreaterThan(0);

      const active = await store.getActive('jwks');
      expect(active?.kid).toBe(newKey.kid);
    });

    it('does not affect keys of other kinds', async () => {
      const jwks = makeJwksWrite();
      const cookie = makeCookieWrite();
      const invite = makeInviteWrite();
      await store.rotate(jwks);
      await store.rotate(cookie);
      await store.rotate(invite);

      // Rotating jwks again should NOT mark the HMAC keys inactive.
      const newJwks = makeJwksWrite();
      await store.rotate(newJwks);

      const cookieFound = await store.getByKid(cookie.kid);
      expect(cookieFound?.active).toBe(true);
      const inviteFound = await store.getByKid(invite.kid);
      expect(inviteFound?.active).toBe(true);
    });

    it('supports invite keys as an independent active kind', async () => {
      const oldInvite = makeInviteWrite();
      const newInvite = makeInviteWrite();
      await store.rotate(oldInvite);
      await store.rotate(newInvite);

      expect((await store.getByKid(oldInvite.kid))?.active).toBe(false);
      const active = await store.getActive('invite');
      expect(active?.kid).toBe(newInvite.kid);
      expect(active?.payload).toEqual(newInvite.payload);
    });

    it('throws when rotating with a duplicate kid', async () => {
      const write = makeJwksWrite();
      await store.rotate(write);
      await expect(store.rotate(write)).rejects.toThrow(/kid/);
    });

    it('listByKind returns active and rotated keys, ordered by createdAt desc', async () => {
      const k1 = makeJwksWrite();
      await store.rotate(k1);
      // small wait to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
      const k2 = makeJwksWrite();
      await store.rotate(k2);
      await new Promise((r) => setTimeout(r, 5));
      const k3 = makeJwksWrite();
      await store.rotate(k3);

      const list = await store.listByKind('jwks');
      expect(list.length).toBe(3);
      // newest first
      expect(list[0].kid).toBe(k3.kid);
      expect(list[1].kid).toBe(k2.kid);
      expect(list[2].kid).toBe(k1.kid);
      // only k3 is active
      expect(list[0].active).toBe(true);
      expect(list[1].active).toBe(false);
      expect(list[2].active).toBe(false);
    });
  });

  describe('transitionAuthorizationMode()', () => {
    it('retires every still-verifying ring and installs all applicable replacements atomically', async () => {
      const original = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];
      for (const write of original) await store.rotate(write);
      const graceKeys = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];
      for (const write of graceKeys) await store.rotate(write);
      const replacements = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];

      const result = await store.transitionAuthorizationMode(modeTransition(replacements));

      expect(result.retired.map(key => key.kid).sort()).toEqual(
        [...original, ...graceKeys].map(write => write.kid).sort(),
      );
      for (const write of [...original, ...graceKeys]) {
        await expect(store.getByKid(write.kid)).resolves.toMatchObject({ active: false });
        expect((await store.getByKid(write.kid))?.retiredAt).toEqual(expect.any(Number));
      }
      for (const replacement of replacements) {
        await expect(store.getActive(replacement.kind)).resolves.toMatchObject({ kid: replacement.kid });
      }
    });

    it('retires an operator-managed kind without installing a store replacement', async () => {
      const oldJwks = makeJwksWrite();
      const oldCookie = makeCookieWrite();
      const oldInvite = makeInviteWrite();
      await store.rotate(oldJwks);
      await store.rotate(oldCookie);
      await store.rotate(oldInvite);

      await store.transitionAuthorizationMode(modeTransition([makeJwksWrite(), makeInviteWrite()]));

      expect((await store.getByKid(oldCookie.kid))?.retiredAt).toEqual(expect.any(Number));
      await expect(store.getActive('cookie')).resolves.toBeNull();
      await expect(store.getActive('jwks')).resolves.not.toBeNull();
      await expect(store.getActive('invite')).resolves.not.toBeNull();
    });

    it('rolls back the complete transition when replacement validation fails', async () => {
      const originals = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];
      for (const write of originals) await store.rotate(write);
      const before = await signingKeySnapshot(store);

      await expect(store.transitionAuthorizationMode(modeTransition([
          makeJwksWrite({ kid: originals[0].kid }),
          makeCookieWrite(),
          makeInviteWrite(),
      ]))).rejects.toThrow(/fresh kids|already exists/i);

      await expect(signingKeySnapshot(store)).resolves.toEqual(before);
    });

    it('serializes concurrent transitions without exposing a mixed active generation', async () => {
      await store.rotate(makeJwksWrite());
      await store.rotate(makeCookieWrite());
      await store.rotate(makeInviteWrite());
      const first = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];
      const second = [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()];
      const firstTransitionId = randomUUID();
      const secondTransitionId = randomUUID();

      const results = await Promise.all([
        store.transitionAuthorizationMode(modeTransition(first, { transitionId: firstTransitionId })),
        store.transitionAuthorizationMode(modeTransition(second, { transitionId: secondTransitionId })),
      ]);

      const activeKids = await Promise.all(
        (['jwks', 'cookie', 'invite'] as const).map(async kind => (await store.getActive(kind))?.kid),
      );
      expect([first.map(write => write.kid), second.map(write => write.kid)])
        .toContainEqual(activeKids);
      expect([...new Set(results.map(result => result.transitionId))]).toHaveLength(1);
      expect([firstTransitionId, secondTransitionId]).toContain(results[0].transitionId);
      expect(results.filter(result => result.alreadyApplied)).toHaveLength(1);
    });

    it('rejects a transition whose expected generation lost the race', async () => {
      await store.rotate(makeJwksWrite());
      await store.rotate(makeCookieWrite());
      await store.rotate(makeInviteWrite());
      await store.transitionAuthorizationMode(modeTransition(
        [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()],
        { target: GENERATION_A },
      ));

      await expect(store.transitionAuthorizationMode(modeTransition(
        [makeJwksWrite(), makeCookieWrite(), makeInviteWrite()],
        { expected: GENERATION_B, target: 'c'.repeat(43) },
      ))).rejects.toThrow(/active generation changed/u);
    });
  });

  describe('pruneRotatedBefore()', () => {
    it('removes only inactive keys with rotatedAt < cutoff', async () => {
      const k1 = makeJwksWrite();
      await store.rotate(k1);
      await new Promise((r) => setTimeout(r, 10));
      const k2 = makeJwksWrite();
      await store.rotate(k2); // k1 now rotated

      // small pause to ensure rotatedAt of k1 is in the past
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = Date.now();

      const removed = await store.pruneRotatedBefore(cutoff);
      expect(removed).toBe(1); // only k1 (rotated, before cutoff)
      expect(await store.getByKid(k1.kid)).toBeNull();
      expect(await store.getByKid(k2.kid)).not.toBeNull();
    });

    it('never removes an active key, even if its createdAt is ancient', async () => {
      const k = makeJwksWrite();
      await store.rotate(k);
      const removed = await store.pruneRotatedBefore(Date.now() + 1_000_000);
      expect(removed).toBe(0);
      expect(await store.getByKid(k.kid)).not.toBeNull();
    });

    it('returns 0 when nothing is eligible', async () => {
      const k = makeJwksWrite();
      await store.rotate(k);
      const removed = await store.pruneRotatedBefore(0);
      expect(removed).toBe(0);
    });
  });

  describe('retire() / delete()', () => {
    it('retires an active key so no active key remains for that kind', async () => {
      const write = makeCookieWrite();
      await store.rotate(write);
      const retired = await store.retire(write.kid, Date.now());

      expect(retired).toMatchObject({ kid: write.kid, active: false });
      expect(retired?.retiredAt).toBeGreaterThan(0);
      expect(await store.getActive('cookie')).toBeNull();
    });

    it('requires retirement before ordinary hard delete and removes key material after retire', async () => {
      const write = makeInviteWrite();
      await store.rotate(write);

      expect(await store.delete(write.kid)).toBe(false);
      await store.retire(write.kid, Date.now());
      expect(await store.delete(write.kid)).toBe(true);
      expect(await store.getByKid(write.kid)).toBeNull();
    });

    it('supports emergency force delete for inactive compromised material', async () => {
      const oldKey = makeJwksWrite();
      const activeKey = makeJwksWrite();
      await store.rotate(oldKey);
      await store.rotate(activeKey);

      expect(await store.delete(oldKey.kid)).toBe(false);
      expect(await store.delete(oldKey.kid, { force: true })).toBe(true);
      expect(await store.getByKid(oldKey.kid)).toBeNull();
      expect((await store.getActive('jwks'))?.kid).toBe(activeKey.kid);
    });

    it('preserves the original retirement and rotation timestamps on repeated retirement', async () => {
      const write = makeInviteWrite();
      await store.rotate(write);
      const firstAt = Date.now() - 10_000;
      const secondAt = Date.now();

      await store.retire(write.kid, firstAt);
      const twiceRetired = await store.retire(write.kid, secondAt);

      expect(twiceRetired?.rotatedAt).toBe(firstAt);
      expect(twiceRetired?.retiredAt).toBe(firstAt);
    });
  });

  describe('isolation', () => {
    it('mutating a returned key does not affect the stored row', async () => {
      const write = makeJwksWrite();
      await store.rotate(write);
      const a = await store.getActive('jwks');
      if (!a) throw new Error('expected active signing key');
      a.payload.x = 'tampered';
      const b = await store.getActive('jwks');
      expect(b?.payload.x).toBe('test-x-coord');
    });
  });
}

async function signingKeySnapshot(store: ISigningKeyStore): Promise<unknown> {
  const keys = (await Promise.all(
    (['jwks', 'cookie', 'invite'] as const).map(kind => store.listByKind(kind)),
  )).flat();
  return keys.sort((left, right) => left.kid.localeCompare(right.kid));
}

// ── InMemory ───────────────────────────────────────────────────────────

describe('ISigningKeyStore contract: InMemorySigningKeyStore', () => {
  runContractSuite(
    () => Promise.resolve(new InMemorySigningKeyStore()),
    async () => { /* GC'd. */ },
  );
});

// ── Filesystem ────────────────────────────────────────────────────────

describe('ISigningKeyStore contract: FilesystemSigningKeyStore', () => {
  runContractSuite(
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signkeys-fs-'));
      return new FilesystemSigningKeyStore({ rootDir: dir });
    },
    async (store) => {
      const fsStore = store as FilesystemSigningKeyStore;
      const rootDir = (fsStore as unknown as { rootDir: string }).rootDir;
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  );
});

// ── Postgres (gated) ───────────────────────────────────────────────────

let pgAvailable = false;
beforeAll(async () => {
  pgAvailable = await isDatabaseAvailable();
  if (!pgAvailable) {
    console.warn(
      '[storage-parity] Skipping PostgresSigningKeyStore suite — local Docker Postgres unreachable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

async function resetPostgresSigningKeys(): Promise<void> {
  const db = getTestAdminDb();
  await withSystemContext(db, async tx => {
    await tx.execute(sql`DELETE FROM auth_signing_keys`);
  });
}

describePg('ISigningKeyStore contract: PostgresSigningKeyStore', () => {
  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'PostgresSigningKeyStore parity tests required ' +
        '(DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) but Postgres was not reachable.',
      );
    }
  });

  runContractSuite(
    async () => {
      await resetPostgresSigningKeys();
      return new PostgresSigningKeyStore({
        db: getTestAdminDb(),
        payloadEncryption: testPayloadEncryption(),
      });
    },
    async () => {
      if (pgAvailable) await resetPostgresSigningKeys();
    },
  );
});

describePg('PostgresSigningKeyStore — encryption at rest', () => {
  beforeEach(async () => {
    await resetPostgresSigningKeys();
  });

  afterEach(async () => {
    if (pgAvailable) await resetPostgresSigningKeys();
  });

  it('never stores a new private signing payload as plaintext JSON', async () => {
    const db = getTestAdminDb();
    const store = new PostgresSigningKeyStore({
      db,
      payloadEncryption: testPayloadEncryption(),
    });
    const write = makeJwksWrite();
    await store.rotate(write);

    const [row] = await withSystemContext(db, tx =>
      tx.select({ payload: authSigningKeys.payload }).from(authSigningKeys));
    expect(row.payload).toMatchObject({
      format: 'dollhouse-signing-key-aead-v1',
      ciphertext: expect.any(String),
    });
    expect(JSON.stringify(row.payload)).not.toContain('test-d-private');
    await expect(store.getByKid(write.kid)).resolves.toMatchObject({ payload: write.payload });
  });

  it('rewraps a legacy plaintext row only during explicit exclusive migration', async () => {
    const db = getTestAdminDb();
    const kid = freshKid('legacy-cookie');
    const legacyPayload = { secret: 'legacy-cookie-secret', length: 32 };
    await withSystemContext(db, tx => tx.insert(authSigningKeys).values({
      kid,
      kind: 'cookie',
      payload: legacyPayload,
      active: true,
      createdAt: new Date(),
    }));
    const store = new PostgresSigningKeyStore({
      db,
      payloadEncryption: testPayloadEncryption(),
    });

    await expect(store.getByKid(kid)).resolves.toMatchObject({ payload: legacyPayload });
    const [afterRead] = await withSystemContext(db, tx =>
      tx.select({ payload: authSigningKeys.payload })
        .from(authSigningKeys)
        .where(sql`${authSigningKeys.kid} = ${kid}`));
    expect(afterRead.payload).toEqual(legacyPayload);
    await expect(store.rewrapPayloadsUnderExclusiveLock()).resolves.toBeGreaterThanOrEqual(1);
    const [rewrapped] = await withSystemContext(db, tx =>
      tx.select({ payload: authSigningKeys.payload })
        .from(authSigningKeys)
        .where(sql`${authSigningKeys.kid} = ${kid}`));
    expect(rewrapped.payload).toMatchObject({ format: 'dollhouse-signing-key-aead-v1' });
    expect(JSON.stringify(rewrapped.payload)).not.toContain('legacy-cookie-secret');
  });

  it('rewraps a retained-master-key envelope only during explicit exclusive migration', async () => {
    const db = getTestAdminDb();
    const kid = freshKid('retained-cookie');
    const payload = { secret: 'retained-cookie-secret', length: 32 };
    const oldKey = { keyId: 'master-v1', key: Buffer.alloc(32, 0x41) };
    const activeKey = { keyId: 'master-v2', key: Buffer.alloc(32, 0x42) };
    const oldEncryption = new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService(oldKey),
      oldKey.keyId,
    );
    await withSystemContext(db, tx => tx.insert(authSigningKeys).values({
      kid,
      kind: 'cookie',
      payload: oldEncryption.encrypt(payload, 'cookie', kid),
      active: true,
      createdAt: new Date(),
    }));
    const rotatedEncryption = new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService(activeKey, [oldKey]),
      activeKey.keyId,
    );
    const store = new PostgresSigningKeyStore({ db, payloadEncryption: rotatedEncryption });

    await expect(store.getByKid(kid)).resolves.toMatchObject({ payload });
    const [afterRead] = await withSystemContext(db, tx =>
      tx.select({ payload: authSigningKeys.payload })
        .from(authSigningKeys)
        .where(sql`${authSigningKeys.kid} = ${kid}`));
    expect(rotatedEncryption.decrypt(afterRead.payload, 'cookie', kid).rewrapRequired).toBe(true);
    await expect(store.rewrapPayloadsUnderExclusiveLock()).resolves.toBeGreaterThanOrEqual(1);
    const [rewrapped] = await withSystemContext(db, tx =>
      tx.select({ payload: authSigningKeys.payload })
        .from(authSigningKeys)
        .where(sql`${authSigningKeys.kid} = ${kid}`));
    expect(rotatedEncryption.decrypt(rewrapped.payload, 'cookie', kid).rewrapRequired).toBe(false);
  });
});

// ── Filesystem durability ──────────────────────────────────────────────

describe('FilesystemSigningKeyStore — durable across instances', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signkeys-fs-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('active key survives a fresh instance pointed at the same directory', async () => {
    const a = new FilesystemSigningKeyStore({ rootDir: dir });
    const write = makeJwksWrite();
    await a.rotate(write);

    const b = new FilesystemSigningKeyStore({ rootDir: dir });
    const found = await b.getActive('jwks');
    expect(found?.kid).toBe(write.kid);
  });

  it('rotation history survives a fresh instance', async () => {
    const a = new FilesystemSigningKeyStore({ rootDir: dir });
    const k1 = makeJwksWrite();
    await a.rotate(k1);
    // Brief delay to ensure k2.createdAt > k1.createdAt — Date.now() has
    // millisecond resolution and back-to-back rotations can collide,
    // making listByKind's sort-by-createdAt-desc indeterminate.
    await new Promise((r) => setTimeout(r, 5));
    const k2 = makeJwksWrite();
    await a.rotate(k2);

    const b = new FilesystemSigningKeyStore({ rootDir: dir });
    const list = await b.listByKind('jwks');
    expect(list.length).toBe(2);
    expect(list[0].kid).toBe(k2.kid);
    expect(list[0].active).toBe(true);
    expect(list[1].kid).toBe(k1.kid);
    expect(list[1].active).toBe(false);
  });

  it('repairs directory and final key-file permissions on every write', async () => {
    if (process.platform === 'win32') return;
    await fs.chmod(dir, 0o755);
    const store = new FilesystemSigningKeyStore({ rootDir: dir });
    await store.rotate(makeCookieWrite());

    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, 'signing-keys.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes rotations across independent store instances without losing either key', async () => {
    const a = new FilesystemSigningKeyStore({ rootDir: dir });
    const b = new FilesystemSigningKeyStore({ rootDir: dir });
    const first = makeJwksWrite();
    const second = makeJwksWrite();

    await Promise.all([a.rotate(first), b.rotate(second)]);

    const keys = await a.listByKind('jwks');
    expect(keys.map(key => key.kid).sort()).toEqual([first.kid, second.kid].sort());
    expect(keys.filter(key => key.active)).toHaveLength(1);
  });

  it('recovers the signing-key guard after its operating-system process is killed', async () => {
    if (process.platform === 'win32') return;
    const guardPath = path.join(dir, '.signing-keys.lock.guard');
    await crashFilesystemGuardOwner(guardPath);

    const store = new FilesystemSigningKeyStore({ rootDir: dir });
    const write = makeCookieWrite();
    await expect(store.rotate(write)).resolves.toMatchObject({ kid: write.kid });
    await expect(store.getActive('cookie')).resolves.toMatchObject({ kid: write.kid });
    await expect(fs.access(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reclaims a signing-key process lock after PID reuse in the same boot', async () => {
    const currentIncarnation = {
      source: 'linux-proc' as const,
      bootId: 'current-boot',
      processStartId: 'current-process-start',
    };
    await seedSigningKeyProcessLock(dir, {
      source: 'linux-proc',
      bootId: currentIncarnation.bootId,
      processStartId: 'previous-process-start',
    });
    const store = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        processIncarnationProvider: async () => currentIncarnation,
      },
    });

    const write = makeCookieWrite();
    await expect(store.rotate(write)).resolves.toMatchObject({ kid: write.kid });
  });

  it('reclaims a signing-key process lock after reboot with a reused PID', async () => {
    const currentIncarnation = {
      source: 'linux-proc' as const,
      bootId: 'current-boot',
      processStartId: 'reused-process-start',
    };
    await seedSigningKeyProcessLock(dir, {
      source: 'linux-proc',
      bootId: 'previous-boot',
      processStartId: currentIncarnation.processStartId,
    });
    const store = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        processIncarnationProvider: async () => currentIncarnation,
      },
    });

    const write = makeInviteWrite();
    await expect(store.rotate(write)).resolves.toMatchObject({ kid: write.kid });
  });

  it('does not expose the process lock until its complete inode is ready', async () => {
    let temporaryReady!: () => void;
    let allowPublication!: () => void;
    const ready = new Promise<void>(resolve => { temporaryReady = resolve; });
    const publicationGate = new Promise<void>(resolve => { allowPublication = resolve; });
    const store = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        beforeInitialPublish: async temporaryPath => {
          const parsed = JSON.parse(await fs.readFile(temporaryPath, 'utf8')) as Record<string, unknown>;
          expect(parsed).toMatchObject({ state: 'held', pid: process.pid, host: os.hostname() });
          if (process.platform !== 'win32') {
            expect((await fs.stat(temporaryPath)).mode & 0o777).toBe(0o600);
          }
          temporaryReady();
          await publicationGate;
        },
      },
    });

    const rotation = store.rotate(makeCookieWrite());
    await ready;
    await expect(fs.access(path.join(dir, '.signing-keys.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    allowPublication();
    await rotation;
  });

  it('does not let a contender publish while the exact-instance guard owner is paused', async () => {
    let firstReady!: () => void;
    let allowFirst!: () => void;
    const ready = new Promise<void>(resolve => { firstReady = resolve; });
    const gate = new Promise<void>(resolve => { allowFirst = resolve; });
    const firstWrite = makeCookieWrite();
    const secondWrite = makeCookieWrite();
    const first = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        beforeInitialPublish: async () => {
          firstReady();
          await gate;
        },
      },
    });
    const second = new FilesystemSigningKeyStore({ rootDir: dir });

    const firstRotation = first.rotate(firstWrite);
    await ready;
    let secondSettled = false;
    const secondRotation = second.rotate(secondWrite)
      .finally(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    allowFirst();
    await Promise.all([firstRotation, secondRotation]);
    expect((await first.listByKind('cookie')).map(key => key.kid).sort())
      .toEqual([firstWrite.kid, secondWrite.kid].sort());
  });

  it('cleans an interrupted initial publication and permits the next writer', async () => {
    const interrupted = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        beforeInitialPublish: async () => { throw new Error('simulated lock publication interruption'); },
      },
    });

    await expect(interrupted.rotate(makeCookieWrite()))
      .rejects.toThrow('simulated lock publication interruption');
    await expect(fs.access(path.join(dir, '.signing-keys.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(dir)).filter(name => name.includes('.signing-keys.lock.'))).toEqual([]);

    const replacement = new FilesystemSigningKeyStore({ rootDir: dir });
    await expect(replacement.rotate(makeCookieWrite())).resolves.toBeDefined();
  });

  it.each(['', '{"ownerToken":"partial"'])(
    'reclaims a stale malformed legacy process lock (%j)',
    async malformed => {
      const lockPath = path.join(dir, '.signing-keys.lock');
      await fs.writeFile(lockPath, malformed, { mode: 0o600 });
      const stale = new Date(Date.now() - 31_000);
      await fs.utimes(lockPath, stale, stale);

      const store = new FilesystemSigningKeyStore({ rootDir: dir });
      await expect(store.rotate(makeCookieWrite())).resolves.toBeDefined();
    },
  );

  it('leaves the canonical lock available after an interrupted release cleanup', async () => {
    const firstWrite = makeCookieWrite();
    const interrupted = new FilesystemSigningKeyStore({
      rootDir: dir,
      processLockHooks: {
        afterReleaseRename: async () => { throw new Error('simulated release interruption'); },
      },
    });

    await expect(interrupted.rotate(firstWrite)).rejects.toThrow('simulated release interruption');
    await expect(fs.access(path.join(dir, '.signing-keys.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const replacement = new FilesystemSigningKeyStore({ rootDir: dir });
    const secondWrite = makeCookieWrite();
    await expect(replacement.rotate(secondWrite)).resolves.toBeDefined();
    expect((await replacement.listByKind('cookie')).map(key => key.kid).sort())
      .toEqual([firstWrite.kid, secondWrite.kid].sort());
  });

  it('does not steal a held filesystem lease based on age alone', async () => {
    type StoreInternals = {
      canTakeOverProcessLock(snapshot: {
        record: {
          ownerToken: string;
          pid: number;
          host: string;
          incarnation: null;
          state: 'held';
          createdAt: number;
          updatedAt: number;
        };
        mtimeMs: number;
        device: number;
        inode: number;
      }): Promise<boolean>;
    };
    const store = new FilesystemSigningKeyStore({ rootDir: dir }) as unknown as StoreInternals;
    const staleTime = Date.now() - 10 * 60 * 1000;
    await expect(store.canTakeOverProcessLock({
      record: {
        ownerToken: 'live-owner',
        pid: process.pid,
        host: os.hostname(),
        incarnation: null,
        state: 'held',
        createdAt: staleTime,
        updatedAt: staleTime,
      },
      mtimeMs: staleTime,
      device: 1,
      inode: 1,
    })).resolves.toBe(false);
  });

  it('quarantines malformed state and refuses to replace it implicitly', async () => {
    const keyPath = path.join(dir, 'signing-keys.json');
    const quarantinePath = `${keyPath}.corrupt`;
    const malformed = '{"private":"must-not-be-overwritten"';
    await fs.writeFile(keyPath, malformed, { mode: 0o600 });
    const store = new FilesystemSigningKeyStore({ rootDir: dir });

    await expect(store.getActive('jwks')).rejects.toThrow(/corrupt/u);
    await expect(store.rotate(makeJwksWrite())).rejects.toThrow(/corrupt/u);
    await expect(fs.access(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(quarantinePath, 'utf8')).resolves.toBe(malformed);
    expect((await fs.readdir(dir)).filter(name => name.includes('.corrupt')))
      .toEqual(['signing-keys.json.corrupt']);
  });

  it('fails closed on structurally invalid key records instead of accepting valid JSON', async () => {
    const keyPath = path.join(dir, 'signing-keys.json');
    const quarantinePath = `${keyPath}.corrupt`;
    const malformed = JSON.stringify([{
      kid: 'active-and-retired',
      kind: 'jwks',
      payload: { privateKey: 'preserve-this-material' },
      active: true,
      createdAt: Date.now(),
      retiredAt: Date.now(),
    }]);
    await fs.writeFile(keyPath, malformed, { mode: 0o600 });
    const store = new FilesystemSigningKeyStore({ rootDir: dir });

    await expect(store.listByKind('jwks')).rejects.toThrow(/active and retired/u);
    await expect(store.listByKind('jwks')).rejects.toThrow(/remains quarantined/u);
    await expect(store.rotate(makeJwksWrite())).rejects.toThrow(/remains quarantined/u);
    await expect(fs.access(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(quarantinePath, 'utf8')).resolves.toBe(malformed);
    expect((await fs.readdir(dir)).filter(name => name.includes('.corrupt')))
      .toEqual(['signing-keys.json.corrupt']);
  });
});
