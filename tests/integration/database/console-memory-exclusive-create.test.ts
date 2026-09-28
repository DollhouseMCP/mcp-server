import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PortfolioElementAlreadyExistsError } from '../../../src/web-console/stores/IPortfolioElementStore.js';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import {
  cleanupAllTestData,
  closeTestDb,
  ensureTestUser,
  fixedUserId,
  getTestDb,
  isDatabaseAvailable,
} from './test-db-helpers.js';

let databaseAvailable = false;
const cleanupDirs: string[] = [];
const NOW = new Date('2026-06-01T12:00:00.000Z');

beforeAll(async () => {
  databaseAvailable = await isDatabaseAvailable();
  if (!databaseAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') {
    throw new Error('Required PostgreSQL unavailable');
  }
});

afterEach(async () => {
  if (databaseAvailable) await cleanupAllTestData();
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(async () => { await closeTestDb(); });

describe('manager-backed console memory creation with PostgreSQL', () => {
  it('preserves an existing same-name memory', async () => {
    if (!databaseAvailable) return;
    const userId = await ensureTestUser();
    const { store } = createStore(userId);
    await store.create(input(userId, 'Existing DB Memory', 'original entry'));

    await expect(store.create(input(userId, 'Existing DB Memory', 'replacement entry'))).rejects.toThrow();
    const persisted = await store.findByName(userId, 'memories', 'existing-db-memory');
    expect(persisted?.content).toContain('original entry');
    expect(persisted?.content).not.toContain('replacement entry');
  });

  it('allows exactly one concurrent same-name create and preserves its content', async () => {
    if (!databaseAvailable) return;
    const userId = await ensureTestUser();
    const { store, manager } = createStore(userId);
    releaseFirstTwoListsTogether(manager);

    const results = await Promise.allSettled([
      store.create(input(userId, 'Racing DB Memory', 'first entry')),
      store.create(input(userId, 'Racing DB Memory', 'second entry')),
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.find(result => result.status === 'fulfilled');
    const loser = results.find(result => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason).toBeInstanceOf(PortfolioElementAlreadyExistsError);
    const expectedContent = winner === results[0] ? 'first entry' : 'second entry';
    const rejectedContent = winner === results[0] ? 'second entry' : 'first entry';
    const persisted = await store.findByName(userId, 'memories', 'racing-db-memory');
    expect(persisted?.content).toContain(expectedContent);
    expect(persisted?.content).not.toContain(rejectedContent);
  });
});

function createStore(userId: string): { store: ManagerBackedPortfolioElementStore; manager: MemoryManager } {
  const portfolioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-db-memory-'));
  cleanupDirs.push(portfolioDir);
  const suite = createRealManagerSuite(portfolioDir);
  const manager = new MemoryManager({
    portfolioManager: suite.portfolioManager,
    fileLockManager: suite.fileLockManager,
    fileOperationsService: suite.fileOperationsService,
    validationRegistry: suite.validationRegistry,
    serializationService: suite.serializationService,
    metadataService: suite.metadataService,
    eventDispatcher: new ElementEventDispatcher(),
    getCurrentUserId: fixedUserId(userId),
    storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), fixedUserId(userId)),
  });
  const store = new ManagerBackedPortfolioElementStore({
    managers: {
      personas: suite.personaManager,
      skills: suite.skillManager,
      templates: suite.templateManager,
      agents: suite.agentManager,
      memories: manager,
      ensembles: suite.ensembleManager,
    },
    getCurrentUserId: fixedUserId(userId),
  });
  return { store, manager };
}

function input(userId: string, name: string, content: string) {
  return {
    userId,
    type: 'memories' as const,
    name,
    displayName: name,
    metadata: { description: 'Console memory create' },
    content,
    tags: [],
    now: NOW,
  };
}

function releaseFirstTwoListsTogether(manager: MemoryManager): void {
  const originalList = manager.list.bind(manager);
  let waiting = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  manager.list = async options => {
    const result = await originalList(options);
    if (++waiting <= 2) {
      if (waiting === 2) release();
      await barrier;
    }
    return result;
  };
}
