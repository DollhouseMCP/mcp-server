/**
 * Integration tests for DatabaseStorageLayer.
 * Tests the full element CRUD path against real Docker PostgreSQL.
 */

import { jest } from '@jest/globals';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import type { DatabaseStorageIdentity } from '../../../src/storage/IStorageLayer.js';
import { buildSkillContent, cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB, fixedUserId, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

class InspectableSkillManager extends SkillManager {
  afterRead?: () => Promise<void>;
  afterWrite?: () => Promise<void>;

  protected override async afterSave(): Promise<void> {
    await this.afterWrite?.();
  }

  protected override async afterLoad(): Promise<void> {
    await this.afterRead?.();
  }

  cached(identity: string) {
    return this.getCachedElementByStorageIdentity(identity);
  }
}

class CleanupUserSwitchingStorageLayer extends DatabaseStorageLayer {
  beforeCleanup?: () => void;

  protected override removeIndexById(id: string, userId?: string): void {
    this.beforeCleanup?.();
    super.removeIndexById(id, userId);
  }
}

class SerializationConflictStorageLayer extends DatabaseStorageLayer {
  readonly firstResolution: Promise<void>;
  resolveAttempts = 0;
  private signalFirstResolution!: () => void;
  private releaseFirstResolution!: () => void;
  private readonly firstResolutionReleased: Promise<void>;

  constructor(...args: ConstructorParameters<typeof DatabaseStorageLayer>) {
    super(...args);
    this.firstResolution = new Promise(resolve => { this.signalFirstResolution = resolve; });
    this.firstResolutionReleased = new Promise(resolve => { this.releaseFirstResolution = resolve; });
  }

  release(): void {
    this.releaseFirstResolution();
  }

  protected override async resolveIdentityInTransaction(
    tx: DrizzleTx,
    userId: string,
    elementType: string,
    identifier: string,
  ): Promise<DatabaseStorageIdentity | undefined> {
    const identity = await super.resolveIdentityInTransaction(
      tx,
      userId,
      elementType,
      identifier,
    );
    this.resolveAttempts += 1;
    if (this.resolveAttempts === 1) {
      this.signalFirstResolution();
      await this.firstResolutionReleased;
    }
    return identity;
  }
}

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping DatabaseStorageLayer tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) await cleanupAllTestData();
});

afterAll(async () => {
  await closeTestDb();
});

describe('DatabaseStorageLayer', () => {
  // ── writeContent + readContent ────────────────────────────────────

  it('should write and read back content with byte-for-byte fidelity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('round-trip-skill', {
      description: 'Tests round-trip fidelity',
      tags: ['test', 'roundtrip'],
    });

    const elementId = await layer.writeContent('skills', 'round-trip-skill', content, {
      author: 'test-author', version: '1.0.0',
      description: 'Tests round-trip fidelity', tags: ['test', 'roundtrip'],
    });

    expect(elementId).toBeTruthy();
    expect(typeof elementId).toBe('string');

    // Read back and verify byte-for-byte fidelity
    const readBack = await layer.readContent(elementId);
    expect(readBack).toBe(content);
  });

  it('should update an existing element on conflict', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const contentV1 = buildSkillContent('update-skill', { version: '1.0.0' });
    const id1 = await layer.writeContent('skills', 'update-skill', contentV1, {
      author: 'test-author', version: '1.0.0', description: 'v1', tags: [],
    });

    const contentV2 = buildSkillContent('update-skill', { version: '2.0.0' });
    const id2 = await layer.writeContent('skills', 'update-skill', contentV2, {
      author: 'test-author', version: '2.0.0', description: 'v2', tags: [],
    });

    // Same element, same ID (upsert, not duplicate)
    expect(id2).toBe(id1);

    // Read back should return v2 content
    const readBack = await layer.readContent(id2);
    expect(readBack).toBe(contentV2);
  });

  it('should use the caller-provided name over frontmatter name', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    // Frontmatter says "yaml-name", caller says "caller-name"
    const content = buildSkillContent('yaml-name');
    const elementId = await layer.writeContent('skills', 'caller-name', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Should be findable by the caller-provided name
    expect(layer.getPathByName('caller-name')).toBe(elementId);
  });

  // ── deleteContent ─────────────────────────────────────────────────

  it('keeps delete cleanup pinned when the ambient user changes after commit', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    let currentUserId = userIdA;
    const layer = new CleanupUserSwitchingStorageLayer(
      getTestDb(),
      () => currentUserId,
      'skills',
    );
    const content = buildSkillContent('shared-delete-name');

    const idA = await layer.writeContent('skills', 'shared-delete-name', content, {
      author: '', version: '', description: '', tags: [],
    });
    currentUserId = userIdB;
    const idB = await layer.writeContent('skills', 'shared-delete-name', content, {
      author: '', version: '', description: '', tags: [],
    });

    currentUserId = userIdA;
    layer.beforeCleanup = () => { currentUserId = userIdB; };
    await layer.deleteContentByIdentity('skills', 'shared-delete-name');

    currentUserId = userIdA;
    expect(layer.getPathByName('shared-delete-name')).toBeUndefined();
    currentUserId = userIdB;
    expect(layer.getPathByName('shared-delete-name')).toBe(idB);
    expect(idA).not.toBe(idB);
  });

  it('retries a real PostgreSQL serialization conflict through Drizzle', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const userResolver = fixedUserId(userId);
    const deletingLayer = new SerializationConflictStorageLayer(
      getTestDb(),
      userResolver,
      'skills',
    );
    const updatingLayer = new DatabaseStorageLayer(getTestDb(), userResolver, 'skills');
    const original = buildSkillContent('serialization-target', { description: 'original' });
    await updatingLayer.writeContent('skills', 'serialization-target', original, {
      author: '', version: '1.0.0', description: 'original', tags: [],
    });

    const deletion = deletingLayer.deleteContentByIdentity('skills', 'serialization-target');
    await deletingLayer.firstResolution;
    const updated = buildSkillContent('serialization-target', { description: 'concurrent' });
    try {
      await updatingLayer.writeContent('skills', 'serialization-target', updated, {
        author: '', version: '1.0.1', description: 'concurrent', tags: [],
      });
    } finally {
      deletingLayer.release();
    }

    await expect(deletion).resolves.toMatchObject({ name: 'serialization-target' });
    expect(deletingLayer.resolveAttempts).toBeGreaterThanOrEqual(2);
    await expect(deletingLayer.resolveContentIdentity('skills', 'serialization-target'))
      .resolves.toBeUndefined();
  });

  it('should delete an element by name', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('delete-me');
    await layer.writeContent('skills', 'delete-me', content, {
      author: '', version: '', description: '', tags: [],
    });

    expect(layer.getPathByName('delete-me')).toBeDefined();

    await layer.deleteContent('skills', 'delete-me');

    expect(layer.getPathByName('delete-me')).toBeUndefined();
  });

  it('should return ENOENT when reading a deleted element', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const content = buildSkillContent('will-delete');
    const elementId = await layer.writeContent('skills', 'will-delete', content, {
      author: '', version: '', description: '', tags: [],
    });

    await layer.deleteContent('skills', 'will-delete');

    await expect(layer.readContent(elementId)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // ── scan ──────────────────────────────────────────────────────────

  it('should detect added elements on first scan', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'scan-a', buildSkillContent('scan-a'), {
      author: '', version: '', description: '', tags: [],
    });
    await layer.writeContent('skills', 'scan-b', buildSkillContent('scan-b'), {
      author: '', version: '', description: '', tags: [],
    });

    // New layer instance — no prior state
    const freshLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const diff = await freshLayer.scan();

    expect(diff.added).toHaveLength(2);
    expect(diff.modified).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('should detect removals on full scan after invalidate', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const db = getTestDb();
    const layer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'will-remove', buildSkillContent('will-remove'), {
      author: '', version: '', description: '', tags: [],
    });

    // Initial scan populates the index
    await layer.scan();
    expect(layer.getPathByName('will-remove')).toBeDefined();

    // Simulate external deletion: delete from DB directly via a DIFFERENT
    // layer instance (bypassing this layer's index update)
    const externalLayer = new DatabaseStorageLayer(db, fixedUserId(userId), 'skills');
    await externalLayer.deleteContent('skills', 'will-remove');

    // Invalidate to force full scan — should detect the external removal
    layer.invalidate();
    const diff = await layer.scan();

    expect(diff.removed).toHaveLength(1);
    expect(layer.getPathByName('will-remove')).toBeUndefined();
  });

  describe('refresh cache freshness (#2799)', () => {
    let manager: InspectableSkillManager;
    let layer: DatabaseStorageLayer;
    let externalLayer: DatabaseStorageLayer;
    let userId: string;
    let directory: string;
    const metadata = { author: 'test', version: '1.0.0', description: 'cache test', tags: [] };

    beforeEach(async () => {
      if (!dbAvailable) return;
      userId = await ensureTestUser();
      layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
      externalLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
      directory = await mkdtemp(join(tmpdir(), 'db-refresh-cache-'));
      const fileLockManager = new FileLockManager();
      const fileOperationsService = new FileOperationsService(fileLockManager);
      const portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: directory });
      await portfolioManager.initialize();
      const metadataService = new MetadataService();
      manager = new InspectableSkillManager({
        portfolioManager, fileLockManager, fileOperationsService, metadataService,
        validationRegistry: new ValidationRegistry(
          new ValidationService(), new TriggerValidationService(), metadataService,
        ),
        serializationService: new SerializationService(),
        eventDispatcher: new ElementEventDispatcher(),
        getCurrentUserId: fixedUserId(userId),
        storageLayerFactory: { createForElement: () => layer },
      });
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      manager?.dispose();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function seedAndLoad(name: string) {
      const id = await externalLayer.writeContent('skills', name, buildSkillContent(name), metadata);
      await manager.refreshIndex();
      const element = await manager.load(id);
      expect(manager.cached(id)).toBe(element);
      return { id, element };
    }

    it('preserves cached X and reports no modifications after an unchanged refresh', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      const scan = jest.spyOn(layer, 'scan');

      await manager.refreshIndex();

      expect(await scan.mock.results[0].value).toEqual({
        added: [], modified: [], removed: [], unchanged: [x.id],
      });
      expect(manager.cached(x.id)).toBe(x.element);
    });

    it('evicts only externally updated X, including changes within one millisecond', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      const y = await seedAndLoad('cache-y');
      // Pin two distinct PostgreSQL versions that collapse to the same JS Date.
      await withUserContext(getTestDb(), userId, tx => tx.update(elements).set({
        updatedAt: sql`'2026-01-01 00:00:00.123001+00'::timestamptz`,
      }).where(eq(elements.id, x.id)));
      await manager.refreshIndex();
      await manager.load(x.id);
      const cachedY = await manager.load(y.id);
      const scan = jest.spyOn(layer, 'scan');
      await withUserContext(getTestDb(), userId, tx => tx.update(elements).set({
        rawContent: buildSkillContent('cache-x', { description: 'external update' }),
        updatedAt: sql`'2026-01-01 00:00:00.123002+00'::timestamptz`,
      }).where(eq(elements.id, x.id)));

      await manager.refreshIndex();

      expect(await scan.mock.results[0].value).toEqual({
        added: [], modified: [x.id], removed: [], unchanged: [y.id],
      });
      expect(manager.cached(x.id)).toBeUndefined();
      expect(manager.cached(y.id)).toBe(cachedY);
      expect((await manager.load(x.id)).metadata.description).toBe('external update');
      await manager.refreshIndex();
      expect(manager.cached(x.id)).toBeDefined();
    });

    it('does not cache an in-flight V1 load after refresh has observed V2 (#32)', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      let release!: () => void;
      let signalRead!: () => void;
      const paused = new Promise<void>(resolve => { signalRead = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      manager.afterRead = async () => {
        manager.afterRead = undefined;
        signalRead();
        await resumed;
      };
      const staleLoad = manager.load(x.id);
      await paused;
      try {
        await externalLayer.writeContent('skills', 'cache-x',
          buildSkillContent('cache-x', { description: 'V2' }), metadata);
        await manager.refreshIndex();
        expect(manager.cached(x.id)).toBeUndefined();
      } finally {
        release();
        await staleLoad;
      }
      await manager.refreshIndex();
      expect(manager.cached(x.id)).toBeUndefined();
      expect((await manager.load(x.id)).metadata.description).toBe('V2');
      expect(manager.cached(x.id)?.metadata.description).toBe('V2');
    });

    it('evicts the old UUID on incremental same-name replacement (#33)', async () => {
      if (!dbAvailable) return;
      const old = await seedAndLoad('cache-x');
      await externalLayer.deleteContent('skills', 'cache-x');
      const replacement = await externalLayer.writeContent('skills', 'cache-x',
        buildSkillContent('cache-x', { description: 'replacement' }), metadata);
      await withUserContext(getTestDb(), userId, tx => tx.update(elements).set({
        updatedAt: sql`NOW() + interval '1 second'`,
      }).where(eq(elements.id, replacement)));
      const scan = jest.spyOn(layer, 'scan');

      await manager.list();

      expect(await scan.mock.results[0].value).toEqual({
        added: [replacement], modified: [], removed: [old.id], unchanged: [],
      });
      expect(manager.cached(old.id)).toBeUndefined();
      expect(manager.cached(replacement)?.metadata.description).toBe('replacement');
      await manager.refreshIndex();
      expect(manager.cached(old.id)).toBeUndefined();
    });

    it('evicts cached X after its storage index state is reset (#34 A)', async () => {
      if (!dbAvailable) return;
      const id = await externalLayer.writeContent('skills', 'cache-x', buildSkillContent('cache-x'), metadata);
      await layer.scan();
      await manager.load(id);
      layer.clear(); // Same loss of per-user scan state as index LRU pruning.
      expect(layer.hasCompletedScan()).toBe(false);
      await externalLayer.writeContent('skills', 'cache-x',
        buildSkillContent('cache-x', { description: 'V2' }), metadata);
      await manager.refreshIndex();
      expect(manager.cached(id)).toBeUndefined();
      expect((await manager.load(id)).metadata.description).toBe('V2');
    });

    it('evicts X loaded by UUID before the first scan (#34 B)', async () => {
      if (!dbAvailable) return;
      const id = await externalLayer.writeContent('skills', 'cache-x', buildSkillContent('cache-x'), metadata);
      await manager.load(id);
      expect(layer.hasCompletedScan()).toBe(false);
      await externalLayer.writeContent('skills', 'cache-x',
        buildSkillContent('cache-x', { description: 'V2' }), metadata);
      await manager.refreshIndex();
      expect(manager.cached(id)).toBeUndefined();
      expect((await manager.load(id)).metadata.description).toBe('V2');
    });

    it('fences an unknown-UUID load when the first scan observes V2 (#34 C)', async () => {
      if (!dbAvailable) return;
      const id = await externalLayer.writeContent('skills', 'cache-x', buildSkillContent('cache-x'), metadata);
      expect(layer.hasCompletedScan()).toBe(false);
      let release!: () => void;
      let signalRead!: () => void;
      const paused = new Promise<void>(resolve => { signalRead = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      manager.afterRead = async () => {
        manager.afterRead = undefined;
        signalRead();
        await resumed;
      };
      const staleLoad = manager.load(id);
      await paused;
      try {
        await externalLayer.writeContent('skills', 'cache-x',
          buildSkillContent('cache-x', { description: 'V2' }), metadata);
        await manager.refreshIndex();
      } finally {
        release();
        await staleLoad;
      }
      await manager.refreshIndex();
      expect(manager.cached(id)).toBeUndefined();
      expect((await manager.load(id)).metadata.description).toBe('V2');
    });

    it('audit: evicts a deleted cached UUID after losing its index history', async () => {
      if (!dbAvailable) return;
      const id = await externalLayer.writeContent('skills', 'cache-x', buildSkillContent('cache-x'), metadata);
      await layer.scan();
      await manager.load(id);
      layer.clear();
      await externalLayer.deleteContent('skills', 'cache-x');
      await manager.refreshIndex();
      await manager.refreshIndex();
      expect(manager.cached(id)).toBeUndefined();
    });

    it.each(['summaries', 'indexed paths', 'name resolution'] as const)('audit: %s cannot consume a version change without cache invalidation', async reader => {
      if (!dbAvailable) return;
      const id = await externalLayer.writeContent('skills', 'cache-x', buildSkillContent('cache-x'), metadata);
      await manager.load(id);
      expect(layer.hasCompletedScan()).toBe(false);
      await externalLayer.writeContent('skills', 'cache-x',
        buildSkillContent('cache-x', { description: 'V2' }), metadata);
      if (reader === 'summaries') await manager.listSummaries();
      else if (reader === 'indexed paths') await layer.getIndexedPaths();
      else await manager.findByName('missing-name');
      await manager.refreshIndex();
      expect(manager.cached(id)).toBeUndefined();
    });

    it('keeps sequential own writes visible to the next scan without recording their version', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      x.element.metadata.description = 'own V2';
      await manager.save(x.element, x.id);
      const scan = jest.spyOn(layer, 'scan');
      await manager.refreshIndex();
      expect((await scan.mock.results[0].value).modified).toEqual([x.id]);
      expect(manager.cached(x.id)).toBeUndefined();
      expect((await manager.load(x.id)).metadata.description).toBe('own V2');
    });

    it('evicts an own deletion from the manager cache and storage index', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      await manager.delete(x.id);
      await manager.refreshIndex();
      expect(manager.cached(x.id)).toBeUndefined();
      expect(layer.getNameById(x.id)).toBeUndefined();
      await expect(layer.readContent(x.id)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('audit: a paused own save cannot publish behind a newer scanned version', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      x.element.metadata.description = 'own V2';
      let release!: () => void;
      let signalWrite!: () => void;
      const paused = new Promise<void>(resolve => { signalWrite = resolve; });
      const resumed = new Promise<void>(resolve => { release = resolve; });
      manager.afterWrite = async () => {
        manager.afterWrite = undefined;
        signalWrite();
        await resumed;
      };
      const staleSave = manager.save(x.element, x.id);
      await paused;
      try {
        await externalLayer.writeContent('skills', 'cache-x',
          buildSkillContent('cache-x', { description: 'external V3' }), metadata);
        await manager.refreshIndex();
      } finally {
        release();
        await staleSave;
      }
      await manager.refreshIndex();
      expect(manager.cached(x.id)).toBeUndefined();
      expect((await manager.load(x.id)).metadata.description).toBe('external V3');
    });

    it('evicts externally deleted X and preserves unchanged Y during a full refresh', async () => {
      if (!dbAvailable) return;
      const x = await seedAndLoad('cache-x');
      const y = await seedAndLoad('cache-y');
      await manager.load(x.id);
      const scan = jest.spyOn(layer, 'scan');
      await externalLayer.deleteContent('skills', 'cache-x');

      await manager.refreshIndex();

      expect(await scan.mock.results[0].value).toEqual({
        added: [], modified: [], removed: [x.id], unchanged: [y.id],
      });
      expect(manager.cached(x.id)).toBeUndefined();
      expect(manager.cached(y.id)).toBe(y.element);
      expect(layer.getNameById(x.id)).toBeUndefined();
    });
  });

  it('tracks renamed and replaced rows by UUID across full refreshes', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const external = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };
    const original = await external.writeContent('skills', 'original', buildSkillContent('original'), metadata);
    await layer.scan();
    await withUserContext(getTestDb(), userId, tx => tx.update(elements).set({
      name: 'renamed', updatedAt: sql`NOW()`,
    }).where(eq(elements.id, original)));
    layer.invalidate();
    expect((await layer.scan()).modified).toEqual([original]);
    expect(layer.getPathByName('original')).toBeUndefined();
    expect(layer.getPathByName('renamed')).toBe(original);

    await external.deleteContent('skills', 'renamed');
    const replacement = await external.writeContent('skills', 'renamed', buildSkillContent('renamed'), metadata);
    layer.invalidate();
    expect(await layer.scan()).toEqual({
      added: [replacement], modified: [], removed: [original], unchanged: [],
    });
    expect(layer.getNameById(original)).toBeUndefined();
    expect(layer.getPathByName('renamed')).toBe(replacement);
    layer.invalidate();
    expect((await layer.scan()).unchanged).toEqual([replacement]);
    layer.clear();
    expect((await layer.scan()).added).toEqual([replacement]);
  });

  it('classifies both identities before applying externally swapped names', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };
    const first = await layer.writeContent('skills', 'first', buildSkillContent('first'), metadata);
    const second = await layer.writeContent('skills', 'second', buildSkillContent('second'), metadata);
    await layer.scan();
    await withUserContext(getTestDb(), userId, async tx => {
      await tx.update(elements).set({ name: 'temporary' }).where(eq(elements.id, first));
      await tx.update(elements).set({ name: 'first', updatedAt: sql`NOW()` }).where(eq(elements.id, second));
      await tx.update(elements).set({ name: 'second', updatedAt: sql`NOW()` }).where(eq(elements.id, first));
    });
    layer.invalidate();
    const diff = await layer.scan();
    expect(diff.added).toEqual([]);
    expect(diff.modified).toHaveLength(2);
    expect(diff.modified).toEqual(expect.arrayContaining([first, second]));
    expect(layer.getPathByName('first')).toBe(second);
    expect(layer.getPathByName('second')).toBe(first);
    layer.invalidate();
    expect((await layer.scan()).modified).toEqual([]);
  });

  it('keeps row versions isolated per user and detects incremental updates', async () => {
    if (!dbAvailable) return;
    const userA = await ensureTestUser();
    const userB = await ensureTestUserB();
    let currentUser = userA;
    const layer = new DatabaseStorageLayer(getTestDb(), () => currentUser, 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };
    const idA = await layer.writeContent('skills', 'shared-version', buildSkillContent('shared-version'), metadata);
    await layer.scan();
    currentUser = userB;
    const idB = await layer.writeContent('skills', 'shared-version', buildSkillContent('shared-version'), metadata);
    await layer.scan();
    currentUser = userA;
    layer.invalidate();
    expect((await layer.scan()).unchanged).toEqual([idA]);
    // Future database timestamp deterministically crosses the existing JS watermark.
    await withUserContext(getTestDb(), userA, tx => tx.update(elements).set({
      updatedAt: sql`NOW() + interval '1 second'`,
    }).where(eq(elements.id, idA)));
    expect((await layer.scan()).modified).toEqual([idA]);
    expect((await layer.scan()).modified).toEqual([]);
    currentUser = userB;
    layer.invalidate();
    expect(await layer.scan()).toEqual({ added: [], modified: [], removed: [], unchanged: [idB] });
  });

  // ── listSummaries ─────────────────────────────────────────────────

  it('should list summaries with correct metadata and tags', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'listed-skill', buildSkillContent('listed-skill', {
      description: 'A listed skill',
      author: 'tester',
      version: '3.0.0',
      tags: ['alpha', 'beta'],
    }), {
      author: 'tester', version: '3.0.0',
      description: 'A listed skill', tags: ['alpha', 'beta'],
    });

    const summaries = await layer.listSummaries();

    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.name).toBe('listed-skill');
    expect(s.description).toBe('A listed skill');
    expect(s.author).toBe('tester');
    expect(s.version).toBe('3.0.0');
    expect(s.tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(s.sizeBytes).toBeGreaterThan(0);
    expect(s.mtimeMs).toBeGreaterThan(0);
  });

  it('should not list elements from a different element type', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const skillLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const agentLayer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'agents');

    await skillLayer.writeContent('skills', 'only-skill', buildSkillContent('only-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    const agentSummaries = await agentLayer.listSummaries();
    expect(agentSummaries).toHaveLength(0);
  });

  // ── getPathByName + getNameById ───────────────────────────────────

  it('should maintain bidirectional name-to-id index', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const elementId = await layer.writeContent('skills', 'indexed-skill', buildSkillContent('indexed-skill'), {
      author: '', version: '', description: '', tags: [],
    });

    expect(layer.getPathByName('indexed-skill')).toBe(elementId);
    expect(layer.getNameById(elementId)).toBe('indexed-skill');
  });

  it('should require an exact name when multiple rows share a canonical identity', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    const firstName = 'Case_Sensitive-Skill';
    const secondName = 'case-sensitive-skill';
    const firstId = await layer.writeContent('skills', firstName, buildSkillContent(firstName), {
      author: '', version: '', description: '', tags: [],
    });
    const secondId = await layer.writeContent('skills', secondName, buildSkillContent(secondName), {
      author: '', version: '', description: '', tags: [],
    });

    expect(layer.getPathByName(firstName)).toBe(firstId);
    expect(layer.getPathByName(secondName)).toBe(secondId);
    expect(layer.getPathByName('Case-Sensitive-Skill')).toBeUndefined();
  });

  it('resolves a UUID-shaped exact name when no row has that ID', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const uuidName = '11111111-1111-4111-8111-111111111111';
    const namedId = await layer.writeContent(
      'skills', uuidName, buildSkillContent(uuidName),
      { author: '', version: '', description: '', tags: [] },
    );

    await expect(layer.resolveContentIdentity('skills', uuidName))
      .resolves.toEqual({ id: namedId, name: uuidName });
  });

  it('rejects an identifier that is both one row ID and another row exact name', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };
    const idRow = await layer.writeContent(
      'skills', 'uuid-owner', buildSkillContent('uuid-owner'), metadata,
    );
    const namedRow = await layer.writeContent(
      'skills', idRow, buildSkillContent(idRow), metadata,
    );

    await expect(layer.deleteContentByIdentity('skills', idRow))
      .rejects.toMatchObject({ code: 'EAMBIGUOUS' });
    await expect(layer.readContent(idRow)).resolves.toContain('name: uuid-owner');
    await expect(layer.readContent(namedRow)).resolves.toContain(`name: ${idRow}`);
  });

  it('keeps scan state and name indexes isolated when one layer serves multiple users', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    let currentUserId = userIdA;
    const layer = new DatabaseStorageLayer(getTestDb(), () => currentUserId, 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };

    const sharedA = await layer.writeContent(
      'skills', 'shared-name', buildSkillContent('shared-name'),
      { ...metadata, visibility: 'public' },
    );
    const canonicalA = await layer.writeContent(
      'skills', 'Canonical_Sibling', buildSkillContent('Canonical_Sibling'),
      { ...metadata, visibility: 'public' },
    );
    await layer.scan();
    expect(layer.hasCompletedScan()).toBe(true);

    currentUserId = userIdB;
    expect(layer.hasCompletedScan()).toBe(false);
    expect(layer.getPathByName('shared-name')).toBeUndefined();
    const sharedB = await layer.writeContent(
      'skills', 'shared-name', buildSkillContent('shared-name'), metadata,
    );
    const canonicalB = await layer.writeContent(
      'skills', 'canonical-sibling', buildSkillContent('canonical-sibling'), metadata,
    );
    expect(layer.getPathByName('shared-name')).toBe(sharedB);
    expect(layer.getPathByName('Canonical_Sibling')).toBe(canonicalB);

    currentUserId = userIdA;
    expect(layer.getPathByName('shared-name')).toBe(sharedA);
    expect(layer.getPathByName('canonical-sibling')).toBe(canonicalA);
  });

  it('keeps canonical identity resolution selective with unrelated persisted rows', async () => {
    if (!dbAvailable) return;
    const userIdA = await ensureTestUser();
    const userIdB = await ensureTestUserB();
    const db = getTestDb();
    const skillsA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'skills');
    const agentsA = new DatabaseStorageLayer(db, fixedUserId(userIdA), 'agents');
    const skillsB = new DatabaseStorageLayer(db, fixedUserId(userIdB), 'skills');
    const metadata = { author: '', version: '', description: '', tags: [] };

    const intendedId = await skillsA.writeContent(
      'skills', 'Target_Name', buildSkillContent('Target_Name'), metadata,
    );
    await skillsA.writeContent(
      'skills', 'target-names', buildSkillContent('target-names'), metadata,
    );
    await agentsA.writeContent(
      'agents', 'Target_Name', buildSkillContent('Target_Name'), metadata,
    );
    await skillsB.writeContent(
      'skills', 'Target_Name', buildSkillContent('Target_Name'),
      { ...metadata, visibility: 'public' },
    );

    await expect(skillsA.resolveContentIdentity('skills', 'target-name'))
      .resolves.toEqual({ id: intendedId, name: 'Target_Name' });
  });

  // ── clear / invalidate ────────────────────────────────────────────

  it('should clear all state', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');

    await layer.writeContent('skills', 'clear-test', buildSkillContent('clear-test'), {
      author: '', version: '', description: '', tags: [],
    });

    layer.clear();

    expect(layer.getPathByName('clear-test')).toBeUndefined();
    expect(layer.hasCompletedScan()).toBe(false);
  });

  // ── body content extraction ───────────────────────────────────────

  it('should extract body content from frontmatter', async () => {
    if (!dbAvailable) return;
    const userId = await ensureTestUser();
    const layer = new DatabaseStorageLayer(getTestDb(), fixedUserId(userId), 'skills');
    const db = getTestDb();

    const content = buildSkillContent('body-test');
    const elementId = await layer.writeContent('skills', 'body-test', content, {
      author: '', version: '', description: '', tags: [],
    });

    // Query body_content via RLS-scoped transaction
    const { withUserRead } = await import('../../../src/database/rls.js');
    const { elements: elemTable } = await import('../../../src/database/schema/elements.js');
    const { eq: eqOp } = await import('drizzle-orm');
    const rows = await withUserRead(db, userId, async (tx) =>
      tx.select({ bodyContent: elemTable.bodyContent }).from(elemTable).where(eqOp(elemTable.id, elementId))
    );

    expect(rows[0].bodyContent).toContain('This is the body content for body-test');
  });
});
