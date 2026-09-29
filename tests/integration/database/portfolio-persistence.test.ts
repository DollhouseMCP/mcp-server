import { elements } from '../../../src/database/schema/elements.js';
import type { IWritableStorageLayer } from '../../../src/storage/IStorageLayer.js';
import { eq } from 'drizzle-orm';
import { withUserRead } from '../../../src/database/rls.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, getTestDb } from './test-db-helpers.js';
import { beforeAll, afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-persistence-'));
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

describe.each(CONSOLE_PORTFOLIO_ELEMENT_TYPES)('PostgreSQL portfolio persistence: %s', type => {
  const input = { get userId() { return USER_ID; }, type, name: 'persistence-example', displayName: 'persistence-example',
    metadata: { description: 'Persistence example', goal: 'Assist carefully', elements: [], instructions: 'Apply careful review.' },
    tags: ['original'], content: 'Original reference body', now: NOW };

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


it('preserves projection hash preconditions for skill updates and deletes', async () => {
  const { store } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'hash-guard', displayName: null,
    metadata: { description: 'Hash guard', instructions: 'Review carefully.' }, content: 'Original reference', tags: [], now: NOW });
  const updated = await store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Edited reference', now: NOW });
  expect(updated?.contentHash).not.toBe(created.contentHash);
  expect(await store.findByName(USER_ID, 'skills', created.canonicalName)).toEqual(updated);
  await expect(store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Stale edit', now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
  await expect(store.delete({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
  expect(await store.findByName(USER_ID, 'skills', created.canonicalName)).toEqual(updated);
  await expect(store.delete({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: updated!.contentHash, now: NOW })).resolves.toBeTruthy();
});

it.each([false, true])('does not insert or overwrite a replacement after deletion (recreate=%s)', async recreate => {
  const { store, storageLayers } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'identity-guard', displayName: null,
    metadata: { description: 'Identity guard', instructions: 'Review carefully.' }, content: 'Original reference', tags: [], now: NOW });
  const storage = storageLayers.get('skills')!;
  const identity = await storage.resolveContentIdentity('skills', created.name);
  expect(identity).toBeDefined();
  const write = storage.writeContent.bind(storage);
  let replacementId: string | undefined;
  jest.spyOn(storage, 'writeContent').mockImplementationOnce(async (type, name, content, metadata, options) => {
    expect(options?.expectedIdentity).toEqual(identity);
    await storage.deleteContentByIdentity(type, identity!.id);
    if (recreate) replacementId = await write(type, name, content.replace('Edited reference', 'Replacement reference'),
      { ...metadata, tags: ['replacement'] }, { exclusive: true });
    return write(type, name, content, metadata, options);
  });
  await expect(store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Edited reference', now: NOW })).resolves.toBeNull();
  const rows = await withUserRead(getTestDb(), USER_ID, tx => tx.select().from(elements).where(eq(elements.name, created.name)));
  expect(rows).toHaveLength(recreate ? 1 : 0);
  if (recreate) {
    expect(rows[0].id).toBe(replacementId);
    expect(rows[0].id).not.toBe(identity!.id);
    expect(rows[0].rawContent).toContain('Replacement reference');
    expect(rows[0].rawContent).not.toContain('Edited reference');
  }
});
