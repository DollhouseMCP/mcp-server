import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { PathService } from '../../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../src/config/indicator-config.js';
import { FileStorageLayerFactory, defaultMemoryFileFilter } from '../../../src/storage/FileStorageLayerFactory.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB, getTestDb, isDatabaseAvailable } from '../database/test-db-helpers.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const personaName = 'shared-persona';

describe.each(['filesystem', 'database'] as const)('Persona lookup scope (%s)', mode => {
  let manager: PersonaManager;
  let tracker: ContextTracker;
  let paths: PathService;
  let tempDir: string;
  let userA: string;
  let userB: string;
  let dbAvailable = false;
  const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  function asUser<T>(userId: string, action: () => Promise<T>): Promise<T> {
    const session = { userId, sessionId: randomUUID(), tenantId: null, transport: 'http' as const, createdAt: Date.now() };
    return tracker.runAsync(tracker.createSessionContext('llm-request', session), action);
  }

  beforeAll(async () => {
    if (mode === 'database') {
      dbAvailable = await isDatabaseAvailable();
      if (!dbAvailable && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
    }
  });

  beforeEach(async () => {
    if (mode === 'database' && !dbAvailable) return;
    tracker = new ContextTracker();
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'persona-lookup-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
    userA = mode === 'database' ? await ensureTestUser() : 'alice';
    userB = mode === 'database' ? await ensureTestUserB() : 'bob';
    const currentUser = () => {
      const userId = tracker.getSessionContext()?.userId;
      if (!userId) throw new Error('A caller context is required');
      return userId;
    };
    paths = new PathService({
      userResolver: new PerUserPathResolver(tempDir),
      packageLocator: new PackageResourceLocator(),
      userIdResolver: currentUser,
    });
    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: tempDir }, { pathService: paths, contextTracker: tracker });
    await portfolioManager.initialize();
    for (const user of [userA, userB]) {
      await mkdir(paths.getUserElementDir(ElementType.PERSONA, user), { recursive: true });
    }
    const metadataService = new MetadataService();
    manager = new PersonaManager({
      portfolioManager, fileLockManager, fileOperationsService, metadataService,
      serializationService: new SerializationService(),
      validationRegistry: new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadataService),
      eventDispatcher: new ElementEventDispatcher(),
      indicatorConfig: DEFAULT_INDICATOR_CONFIG,
      contextTracker: tracker,
      getCurrentUserId: currentUser,
      storageLayerFactory: mode === 'database'
        ? new DatabaseStorageLayerFactory(getTestDb(), currentUser)
        : new FileStorageLayerFactory(fileOperationsService,
          { indexDebounceMs: 2000, fileFilter: defaultMemoryFileFilter },
          type => () => paths.getUserElementDir(type as ElementType)),
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    manager?.dispose();
    if (mode === 'database' && dbAvailable) await cleanupAllTestData();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    if (originalPortfolioDir === undefined) delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    else process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
  });

  afterAll(async () => {
    if (mode === 'database') await closeTestDb();
  });

  async function seed(userId: string) {
    const id = randomUUID();
    const instructions = `Instructions for ${userId}`;
    const content = `---\nname: ${personaName}\ndescription: Persona for ${userId}\nunique_id: ${id}\ntype: persona\nversion: 1.0.0\n---\n${instructions}\n`;
    if (mode === 'database') {
      const layer = new DatabaseStorageLayer(getTestDb(), () => userId, 'personas');
      await layer.writeContent('personas', personaName, content, {
        author: userId, version: '1.0.0', description: `Persona for ${userId}`, tags: [], visibility: 'private',
      });
    } else {
      const directory = paths.getUserElementDir(ElementType.PERSONA, userId);
      expect(directory).toBe(path.join(tempDir, 'users', userId, 'portfolio', 'personas'));
      await writeFile(path.join(directory, `${personaName}.md`), content);
    }
    return { id, instructions };
  }

  function pauseFirstLookup() {
    const entered = deferred();
    const release = deferred();
    const original = manager.findByName.bind(manager);
    const lookup = jest.spyOn(manager, 'findByName').mockImplementation(async identifier => {
      entered.resolve();
      await release.promise;
      return original(identifier);
    });
    return { entered, release, lookup };
  }

  it.each([
    { label: 'both users own the name', ownsA: true, ownsB: true },
    { label: 'only the first user owns the name', ownsA: true, ownsB: false },
    { label: 'only the second user owns the name', ownsA: false, ownsB: true },
  ])('resolves each caller independently when $label', async ({ ownsA, ownsB }) => {
    if (mode === 'database' && !dbAvailable) return;
    const expectedA = ownsA ? await seed(userA) : undefined;
    const expectedB = ownsB ? await seed(userB) : undefined;
    const barrier = pauseFirstLookup();
    const first = asUser(userA, () => manager.findPersonaAsync(personaName));
    await barrier.entered.promise;
    const second = asUser(userB, () => manager.findPersonaAsync(personaName));
    barrier.release.resolve();
    const [resultA, resultB] = await Promise.all([first, second]);
    expect(resultA?.id).toBe(expectedA?.id);
    expect(resultA?.instructions.trim()).toBe(expectedA?.instructions);
    expect(resultB?.id).toBe(expectedB?.id);
    expect(resultB?.instructions.trim()).toBe(expectedB?.instructions);
    expect(barrier.lookup).toHaveBeenCalledTimes(2);
    if (expectedA && expectedB) expect(resultA).not.toBe(resultB);
  });

  it('shares one lookup across two sessions of the same user', async () => {
    if (mode === 'database' && !dbAvailable) return;
    const expected = await seed(userA);
    const storageRead = mode === 'database'
      ? jest.spyOn(DatabaseStorageLayer.prototype, 'readContent')
      : jest.spyOn(FileOperationsService.prototype, 'readElementFile');
    const barrier = pauseFirstLookup();
    const first = asUser(userA, () => manager.findPersonaAsync(personaName));
    await barrier.entered.promise;
    const second = asUser(userA, () => manager.findPersonaAsync(personaName));
    barrier.release.resolve();
    const [resultA, resultB] = await Promise.all([first, second]);
    expect(resultA?.id).toBe(expected.id);
    expect(resultA?.instructions.trim()).toBe(expected.instructions);
    expect(resultB).toBe(resultA);
    expect(barrier.lookup).toHaveBeenCalledTimes(1);
    expect(storageRead).toHaveBeenCalledTimes(1);
  });
});
