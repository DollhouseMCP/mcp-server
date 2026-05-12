/**
 * IOperatorConfigStore parity tests.
 *
 * Same suite runs against all three implementations (InMemory, Filesystem,
 * Postgres). A new backend that passes this suite is drop-in compatible
 * with every consumer of IOperatorConfigStore.
 *
 * Postgres backend gated on Docker Postgres reachability (same gate as
 * the auth storage parity tests: `DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1` in
 * CI; silent skip locally with a console notice).
 *
 * @since Phase 4.5 storage completion — Phase A
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { sql } from 'drizzle-orm';

import {
  InMemoryOperatorConfigStore,
  FilesystemOperatorConfigStore,
  type IOperatorConfigStore,
  type OperatorConfig,
} from '../../../src/storage/operatorConfig/index.js';
import { PostgresOperatorConfigStore } from '../../../src/storage/operatorConfig/PostgresOperatorConfigStore.js';
import { withSystemContext } from '../../../src/database/admin.js';
import { closeTestDb, getTestDb, isDatabaseAvailable } from '../database/test-db-helpers.js';

function makeConfig(overrides: Partial<OperatorConfig> = {}): Omit<OperatorConfig, 'updatedAt'> {
  return {
    enhancedIndexConfig: { enabled: true, limits: { maxEntries: 1000 } },
    consoleConfig: { port: 41715 },
    licenseConfig: { tier: 'community' },
    defaultsConfig: { defaultElementDir: '/var/dollhouse' },
    configVersion: 1,
    ...overrides,
  };
}

/**
 * The full contract suite. Each backend's describe block calls this so
 * assertions stay in lock-step across implementations.
 */
function runContractSuite(
  factory: () => Promise<IOperatorConfigStore>,
  cleanup: (store: IOperatorConfigStore) => Promise<void>,
): void {
  let store: IOperatorConfigStore;

  beforeEach(async () => {
    store = await factory();
  });

  afterEach(async () => {
    await cleanup(store);
  });

  describe('load() before save()', () => {
    it('returns the default config shape, not null', async () => {
      const result = await store.load();
      expect(result).not.toBeNull();
      expect(result.enhancedIndexConfig).toEqual({});
      expect(result.consoleConfig).toEqual({});
      expect(result.licenseConfig).toEqual({});
      expect(result.defaultsConfig).toEqual({});
      expect(result.configVersion).toBe(1);
    });

    it('returns a fresh copy each call (mutating one does not leak to the next)', async () => {
      const first = await store.load();
      (first.enhancedIndexConfig as Record<string, unknown>).poisoned = true;
      const second = await store.load();
      expect((second.enhancedIndexConfig as Record<string, unknown>).poisoned).toBeUndefined();
    });
  });

  describe('save() then load()', () => {
    it('round-trips every section verbatim', async () => {
      const cfg = makeConfig();
      await store.save(cfg);
      const loaded = await store.load();
      expect(loaded.enhancedIndexConfig).toEqual(cfg.enhancedIndexConfig);
      expect(loaded.consoleConfig).toEqual(cfg.consoleConfig);
      expect(loaded.licenseConfig).toEqual(cfg.licenseConfig);
      expect(loaded.defaultsConfig).toEqual(cfg.defaultsConfig);
      expect(loaded.configVersion).toBe(cfg.configVersion);
    });

    it('updatedAt is populated by save()', async () => {
      const before = Date.now();
      await store.save(makeConfig());
      const after = Date.now();
      const loaded = await store.load();
      expect(loaded.updatedAt).toBeGreaterThanOrEqual(before);
      expect(loaded.updatedAt).toBeLessThanOrEqual(after + 100); // small clock slop
    });

    it('second save replaces the first wholesale', async () => {
      await store.save(makeConfig({ consoleConfig: { port: 1111 } }));
      await store.save(makeConfig({ consoleConfig: { port: 2222 } }));
      const loaded = await store.load();
      expect((loaded.consoleConfig as Record<string, unknown>).port).toBe(2222);
    });

    it('preserves nested structures in jsonb sections', async () => {
      const cfg = makeConfig({
        enhancedIndexConfig: {
          telemetry: { enabled: false, batchSize: 50 },
          resources: { include: ['users', 'tags'], exclude: [] },
        },
      });
      await store.save(cfg);
      const loaded = await store.load();
      expect(loaded.enhancedIndexConfig).toEqual(cfg.enhancedIndexConfig);
    });

    it('handles empty section objects', async () => {
      const cfg = makeConfig({
        enhancedIndexConfig: {},
        consoleConfig: {},
        licenseConfig: {},
        defaultsConfig: {},
      });
      await store.save(cfg);
      const loaded = await store.load();
      expect(loaded.enhancedIndexConfig).toEqual({});
      expect(loaded.consoleConfig).toEqual({});
      expect(loaded.licenseConfig).toEqual({});
      expect(loaded.defaultsConfig).toEqual({});
    });

    it('caller-supplied updatedAt is ignored — storage stamps current time', async () => {
      const cfg = { ...makeConfig(), updatedAt: 0 };
      const before = Date.now();
      await store.save(cfg);
      const loaded = await store.load();
      expect(loaded.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('isolation between loads', () => {
    it('mutating a loaded copy does not affect the stored row', async () => {
      await store.save(makeConfig({ consoleConfig: { port: 3000 } }));
      const a = await store.load();
      (a.consoleConfig as Record<string, unknown>).port = 9999;
      const b = await store.load();
      expect((b.consoleConfig as Record<string, unknown>).port).toBe(3000);
    });
  });
}

// ── InMemory (always run) ──────────────────────────────────────────────

describe('IOperatorConfigStore contract: InMemoryOperatorConfigStore', () => {
  runContractSuite(
    async () => new InMemoryOperatorConfigStore(),
    async () => { /* GC'd with the instance. */ },
  );
});

// ── Filesystem (always run) ────────────────────────────────────────────

describe('IOperatorConfigStore contract: FilesystemOperatorConfigStore', () => {
  runContractSuite(
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcfg-fs-'));
      return new FilesystemOperatorConfigStore({ rootDir: dir });
    },
    async (store) => {
      const fsStore = store as FilesystemOperatorConfigStore;
      // Access via cast — rootDir is private; we know the type at the suite level.
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
      '[storage-parity] Skipping PostgresOperatorConfigStore suite — local Docker Postgres unreachable. ' +
      'Run `docker compose -f docker/docker-compose.db.yml up -d` to enable.',
    );
  }
});

afterAll(async () => {
  if (pgAvailable) await closeTestDb();
});

const pgRequired = process.env.DOLLHOUSE_REQUIRE_PG_AUTH_TESTS === '1';
const describePg = pgRequired ? describe : describe.skip;

describePg('IOperatorConfigStore contract: PostgresOperatorConfigStore', () => {
  const reset = async () => {
    const db = getTestDb();
    await withSystemContext(db, async (tx) => {
      await tx.execute(sql`DELETE FROM operator_settings`);
    });
  };

  beforeAll(() => {
    if (!pgAvailable) {
      throw new Error(
        'PostgresOperatorConfigStore parity tests required ' +
        '(DOLLHOUSE_REQUIRE_PG_AUTH_TESTS=1) but Postgres was not reachable. ' +
        'Run `docker compose -f docker/docker-compose.db.yml up -d` first.',
      );
    }
  });

  runContractSuite(
    async () => {
      await reset();
      return new PostgresOperatorConfigStore({ db: getTestDb() });
    },
    async () => {
      if (pgAvailable) await reset();
    },
  );
});

// ── Filesystem durability ──────────────────────────────────────────────

describe('FilesystemOperatorConfigStore — durable across instances', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opcfg-fs-restart-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('config survives a fresh instance pointed at the same directory', async () => {
    const a = new FilesystemOperatorConfigStore({ rootDir: dir });
    await a.save(makeConfig({ consoleConfig: { port: 41715 } }));

    const b = new FilesystemOperatorConfigStore({ rootDir: dir });
    const found = await b.load();
    expect((found.consoleConfig as Record<string, unknown>).port).toBe(41715);
  });

  it('tolerates ENOENT on first load (returns default)', async () => {
    const store = new FilesystemOperatorConfigStore({ rootDir: dir });
    const found = await store.load();
    expect(found.consoleConfig).toEqual({});
  });

  it('tolerates malformed JSON (logs warning, returns default)', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'operator-config.json'), '{not json');
    const store = new FilesystemOperatorConfigStore({ rootDir: dir });
    const found = await store.load();
    expect(found.consoleConfig).toEqual({});
  });
});
