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
import { sql } from 'drizzle-orm';

import {
  InMemorySigningKeyStore,
  FilesystemSigningKeyStore,
  type ISigningKeyStore,
  type SigningKeyWrite,
} from '../../../src/storage/signingKeys/index.js';
import { PostgresSigningKeyStore } from '../../../src/storage/signingKeys/PostgresSigningKeyStore.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { closeTestDb, getTestDb, isDatabaseAvailable } from '../database/test-db-helpers.js';

let kidCounter = 0;
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
      await store.rotate(jwks);
      await store.rotate(cookie);

      // Rotating jwks again should NOT mark the cookie key inactive.
      const newJwks = makeJwksWrite();
      await store.rotate(newJwks);

      const cookieFound = await store.getByKid(cookie.kid);
      expect(cookieFound?.active).toBe(true);
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

  describe('isolation', () => {
    it('mutating a returned key does not affect the stored row', async () => {
      const write = makeJwksWrite();
      await store.rotate(write);
      const a = await store.getActive('jwks');
      (a!.payload as Record<string, unknown>).x = 'tampered';
      const b = await store.getActive('jwks');
      expect((b!.payload as Record<string, unknown>).x).toBe('test-x-coord');
    });
  });
}

// ── InMemory ───────────────────────────────────────────────────────────

describe('ISigningKeyStore contract: InMemorySigningKeyStore', () => {
  runContractSuite(
    async () => new InMemorySigningKeyStore(),
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

describePg('ISigningKeyStore contract: PostgresSigningKeyStore', () => {
  const reset = async () => {
    const db = getTestDb();
    await withSystemContext(db, async (tx) => {
      await tx.execute(sql`DELETE FROM auth_signing_keys`);
    });
  };

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
      await reset();
      return new PostgresSigningKeyStore({ db: getTestDb() });
    },
    async () => {
      if (pgAvailable) await reset();
    },
  );
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
});
