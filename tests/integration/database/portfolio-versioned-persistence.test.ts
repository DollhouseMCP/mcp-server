import type { IWritableStorageLayer } from '../../../src/storage/IStorageLayer.js';
import { eq } from 'drizzle-orm';
import { elements, elementTags } from '../../../src/database/schema/elements.js';
import { memoryEntries } from '../../../src/database/schema/memories.js';
import { withUserContext, withUserRead } from '../../../src/database/rls.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { ensureTestUserB } from './test-db-helpers.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, getTestDb } from './test-db-helpers.js';
import { beforeAll, afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { CONSOLE_PORTFOLIO_ELEMENT_TYPES, PortfolioElementVersionConflictError } from '../../../src/web-console/stores/IPortfolioElementStore.js';

let USER_ID: string;
beforeAll(async () => { USER_ID = await ensureTestUser(); });
afterAll(async () => { await closeTestDb(); });
const NOW = new Date('2026-09-28T00:00:00Z');
const directories: string[] = [];
const disposables: { dispose(): void }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const manager of disposables.splice(0)) manager.dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  await cleanupAllTestData();
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'versioned-portfolio-'));
  directories.push(directory);
  const factory = new DatabaseStorageLayerFactory(getTestDb(), () => USER_ID);
  const storageLayers = new Map<string, IWritableStorageLayer>();
  const suite = createRealManagerSuite(directory, { storageLayerFactory: {
    createForElement(elementType, fileOptions) {
      const storage = factory.createForElement(elementType, fileOptions) as IWritableStorageLayer;
      storageLayers.set(elementType, storage);
      return storage;
    },
  } });
  const managers = { personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
    agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager };
  disposables.push(...Object.values(managers));
  return { directory, managers, storageLayers, store: new ManagerBackedPortfolioElementStore({ managers, getCurrentUserId: () => USER_ID }) };
}

describe.each(CONSOLE_PORTFOLIO_ELEMENT_TYPES)('PostgreSQL stored-byte portfolio contract: %s', type => {
  const input = { get userId() { return USER_ID; }, type, name: 'versioned-example', displayName: 'versioned-example',
    metadata: { description: 'Versioned example', goal: 'Assist carefully', elements: [], instructions: 'Apply careful review.' },
    tags: ['original'], content: 'Original reference body', now: NOW };

  it('returns the exact stored version and preserves it across a cache reload', async () => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const observation = await manager.readVersioned(created.name);
    expect(created.contentHash).toBe(createHash('sha256').update(observation.raw).digest('hex'));
    manager.clearCache();
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(created);
    const updated = await store.update({ ...input, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, tags: ['changed'] });
    expect(updated?.contentHash).not.toBe(created.contentHash);
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(updated);
    await expect(store.update({ ...input, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    await expect(store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(updated);
  });

  it('does not delete a concurrent edit after the versioned read', async () => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const original = manager.delete.bind(manager);
    jest.spyOn(manager, 'delete').mockImplementationOnce(async (...args) => {
      await store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
        expectedContentHash: created.contentHash, tags: ['concurrent'] });
      return original(...args);
    });
    await expect(store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect((await store.findByName(USER_ID, type, created.canonicalName))?.tags).toEqual(['concurrent']);
  });

  it('honors exclusive create when another writer wins after the existence check', async () => {
    const { store, managers } = fixture();
    const manager = managers[type];
    const original = manager.save.bind(manager);
    jest.spyOn(manager, 'save').mockImplementationOnce(async (...args) => {
      await store.create({ ...input, tags: ['winner'] });
      return original(...args);
    });
    await expect(store.create(input)).rejects.toThrow(/already exists/i);
    expect((await store.findByName(USER_ID, type, input.name))?.tags).toEqual(['winner']);
  });

  it('reports a delete racing the validation snapshot as stale', async () => {
    const { store, managers, storageLayers } = fixture();
    const created = await store.create(input);
    managers[type].clearCache();
    const storage = storageLayers.get(type)!;
    const read = storage.readContent.bind(storage);
    jest.spyOn(storage, 'readContent').mockImplementationOnce(async id => {
      await storage.deleteContentByIdentity(type, id);
      return read(id);
    });
    await expect(store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toBeNull();
  });

  it('does not grant public readers conditional write or delete access', async () => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const original = await managers[type].readVersioned(created.name);
    if (original.identity.kind !== 'database') throw new Error('Expected database identity');
    const identity = original.identity;
    await withUserContext(getTestDb(), USER_ID, tx => tx.update(elements).set({ visibility: 'public' }).where(eq(elements.id, identity.id)));
    const otherUser = await ensureTestUserB();
    const reader = type === 'memories'
      ? new DatabaseMemoryStorageLayer(getTestDb(), () => otherUser)
      : new DatabaseStorageLayer(getTestDb(), () => otherUser, type);
    expect(await reader.readVersioned(identity.id)).toEqual(original);
    await expect(reader.writeContent(type, created.name, original.raw, { author: 'test', version: '1.0.0', description: 'Test', tags: ['intruder'] },
      { expectedIdentity: identity, expectedVersion: original.version })).rejects.toMatchObject({ code: 'ESTALE' });
    await expect(reader.deleteContentByIdentity(type, identity.id, identity, original.version)).rejects.toMatchObject({ code: 'ESTALE' });
    expect(await managers[type].readVersioned(created.name)).toEqual(original);
  });

  it.each(['delete', 'edit'] as const)('does not overwrite a concurrent %s after the store read', async race => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const original = manager.importElement.bind(manager);
    jest.spyOn(manager, 'importElement').mockImplementationOnce(async (...args) => {
      if (race === 'delete') await store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
        expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW });
      else await store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
        expectedContentHash: created.contentHash, tags: ['concurrent'] });
      return original(...args);
    });
    await expect(store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
      expectedContentHash: created.contentHash, tags: ['losing'] })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    const current = await store.findByName(USER_ID, type, created.canonicalName);
    if (race === 'delete') expect(current).toBeNull();
    else expect(current?.tags).toEqual(['concurrent']);
  });
});

it('preserves a skill reference body through console import and save', async () => {
  const { store } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'reference-example', displayName: null,
    metadata: { description: 'Reference example', instructions: 'Review carefully.' }, content: 'My original reference', tags: [], now: NOW });
  expect(created.content.trim()).toBe('My original reference');
  const updated = await store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'My edited reference', now: NOW });
  expect(updated?.content.trim()).toBe('My edited reference');
  expect((await store.findByName(USER_ID, 'skills', created.canonicalName))?.content.trim()).toBe('My edited reference');
});

it('keeps memory tags and entries unchanged when a conditional write loses', async () => {
  const { store, managers } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'memories', name: 'conditional-memory', displayName: null,
    metadata: { description: 'Conditional memory' }, content: 'Original entry', tags: ['original'], now: NOW });
  const observation = await managers.memories.readVersioned(created.name);
  if (observation.identity.kind !== 'database') throw new Error('Expected database identity');
  const id = observation.identity.id;
  const snapshot = () => withUserRead(getTestDb(), USER_ID, async tx => ({
    tags: await tx.select().from(elementTags).where(eq(elementTags.elementId, id)),
    entries: await tx.select().from(memoryEntries).where(eq(memoryEntries.memoryId, id)),
  }));
  const before = await snapshot();
  expect(before.entries).toHaveLength(1);
  const storage = new DatabaseMemoryStorageLayer(getTestDb(), () => USER_ID);
  await expect(storage.writeContent('memories', created.name, observation.raw.replace('Original entry', 'Losing entry'),
    { author: 'test', version: '1.0.0', description: 'Test', tags: ['losing'] }, { expectedIdentity: observation.identity, expectedVersion: '0'.repeat(64) })).rejects.toMatchObject({ code: 'ESTALE' });
  expect(await snapshot()).toEqual(before);
  expect(await storage.readVersioned(id)).toEqual(observation);
});
