import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { PathService } from '../../../src/paths/PathService.js';
import { PerUserPathResolver } from '../../../src/paths/PerUserPathResolver.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { FileStorageLayerFactory } from '../../../src/storage/FileStorageLayerFactory.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { ActivationMetricsTracker } from '../../../src/metrics/ActivationMetricsTracker.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { ElementNotFoundError } from '../../../src/utils/ErrorHandler.js';
import { elements } from '../../../src/database/schema/elements.js';
import { withUserContext } from '../../../src/database/rls.js';
import { createIntegrationContainer } from '../../helpers/integration-container.js';
import { cleanupAllTestData, closeTestDb, ensureTestUser, ensureTestUserB, getTestDb, isDatabaseAvailable } from './test-db-helpers.js';

const validContent = '---\nname: shared-skill\ndescription: Scoped skill fixture\nversion: 1.0.0\n---\nFollow these detailed instructions.\n';
const invalidContent = '---\nname: [unfinished\n---\n';

const databaseAvailable = await isDatabaseAvailable();
if (!databaseAvailable) {
  await closeTestDb();
  if (process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
}

for (const mode of ['filesystem', 'database'] as const) {
  const suite = mode === 'database' && !databaseAvailable ? describe.skip : describe;
  suite(`Invalid element records (${mode})`, () => {
    let env: Awaited<ReturnType<typeof createIntegrationContainer>>;
    let manager: SkillManager;
    let handler: ElementCRUDHandler;
    let tracker: ContextTracker;
    let paths: PathService;
    let userA: string;
    let userB: string;
    let identity: string;
    let errorUsers: string[];
    let unsubscribe: () => void;
    let dispatcher: ElementEventDispatcher;
    let emissions: jest.SpiedFunction<ElementEventDispatcher['emitAsync']>;

    function asUser<T>(userId: string, action: () => Promise<T>): Promise<T> {
      const session = {
        userId, sessionId: randomUUID(), tenantId: null,
        transport: 'http' as const, createdAt: Date.now(),
      };
      return tracker.runAsync(tracker.createSessionContext('llm-request', session), action);
    }

    beforeEach(async () => {
      env = await createIntegrationContainer();
      const container = env.container;
      tracker = container.resolve('ContextTracker');
      userA = mode === 'database' ? await ensureTestUser() : 'alice';
      userB = mode === 'database' ? await ensureTestUserB() : 'bob';
      const currentUser = () => tracker.getSessionContext()?.userId ?? 'system';
      paths = new PathService({
        userResolver: new PerUserPathResolver(env.portfolioDir),
        packageLocator: new PackageResourceLocator(),
        userIdResolver: currentUser,
      });
      const fileOperationsService = container.resolve<FileOperationsService>('FileOperationsService');
      const portfolioManager = new PortfolioManager(
        fileOperationsService,
        { baseDir: env.portfolioDir },
        { pathService: paths, contextTracker: tracker },
      );
      await portfolioManager.initialize();
      await Promise.all([userA, userB].map(user =>
        mkdir(paths.getUserElementDir(ElementType.SKILL, user), { recursive: true })));
      configureManagers(portfolioManager, fileOperationsService, currentUser);
      await seedDefinitions();
      errorUsers = [];
      dispatcher = container.resolve<ElementEventDispatcher>('ElementEventDispatcher');
      emissions = jest.spyOn(dispatcher, 'emitAsync');
      unsubscribe = dispatcher.on('element:load:error', payload => { errorUsers.push(payload.userId ?? 'system'); });
    });

    function configureManagers(
      portfolioManager: PortfolioManager,
      fileOperationsService: FileOperationsService,
      currentUser: () => string,
    ) {
      const container = env.container;
      manager = new SkillManager({
        portfolioManager,
        fileOperationsService,
        fileLockManager: container.resolve('FileLockManager'),
        metadataService: container.resolve('MetadataService'),
        serializationService: container.resolve('SerializationService'),
        validationRegistry: container.resolve('ValidationRegistry'),
        eventDispatcher: container.resolve('ElementEventDispatcher'),
        contextTracker: tracker,
        getCurrentUserId: currentUser,
        activationMetricsTracker: new ActivationMetricsTracker(currentUser),
        storageLayerFactory: mode === 'database'
          ? new DatabaseStorageLayerFactory(getTestDb(), () => tracker.getSessionContext()?.userId ?? userA)
          : new FileStorageLayerFactory(fileOperationsService, {},
            type => () => paths.getUserElementDir(type as ElementType)),
      });
      handler = new ElementCRUDHandler(
        manager,
        container.resolve('TemplateManager'),
        container.resolve('TemplateRenderer'),
        container.resolve('AgentManager'),
        container.resolve('MemoryManager'),
        container.resolve('EnsembleManager'),
        container.resolve('PersonaManager'),
        portfolioManager,
        container.resolve('InitializationService'),
        container.resolve('PersonaIndicatorService'),
        fileOperationsService,
        container.resolve('ElementQueryService'),
        container.resolve('ValidationRegistry'),
        new ActivationMetricsTracker(currentUser),
      );
    }

    async function seedDefinitions() {
      if (mode === 'database') {
        identity = await new DatabaseStorageLayer(getTestDb(), () => userA, ElementType.SKILL)
          .writeContent(ElementType.SKILL, 'shared-skill', validContent,
            { author: userA, version: '1.0.0', description: 'Scoped skill fixture', tags: [], visibility: 'private' });
      } else {
        identity = 'shared-skill.md';
      }
      for (const user of [userA, userB]) {
        const content = validContent.replace('shared-skill', 'healthy-skill');
        if (mode === 'database') {
          await new DatabaseStorageLayer(getTestDb(), () => user, ElementType.SKILL)
            .writeContent(ElementType.SKILL, 'healthy-skill', content,
              { author: user, version: '1.0.0', description: 'Healthy fixture', tags: [], visibility: 'private' });
        } else {
          await writeFile(path.join(paths.getUserElementDir(ElementType.SKILL, user), 'healthy-skill.md'), content);
        }
      }
      await writeDefinition(userA, invalidContent);
    }

    afterEach(async () => {
      unsubscribe?.();
      jest.restoreAllMocks();
      await manager?.dispose();
      await env?.dispose();
      if (mode === 'database') await cleanupAllTestData();
    });
    afterAll(async () => {
      if (mode === 'database') await closeTestDb();
    });

    async function writeDefinition(userId: string, content: string, shared = false) {
      if (mode === 'database') {
        // A owns this row; B can read the same identity only through public visibility.
        await withUserContext(getTestDb(), userA, tx => tx.update(elements)
          .set({ rawContent: content, visibility: shared ? 'public' : 'private' }).where(eq(elements.id, identity)));
      } else {
        await writeFile(path.join(paths.getUserElementDir(ElementType.SKILL, userId), identity), content);
      }
    }

    async function expectFailure(action: () => Promise<unknown>, emitsError = true) {
      let observed!: () => void;
      const event = new Promise<void>(resolve => { observed = resolve; });
      const off = dispatcher.on('element:load:error', payload => {
        if (payload.filePath === identity) observed();
      });
      const before = emissions.mock.calls.length;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(action()).rejects.toThrow();
        const queued = emissions.mock.calls.slice(before).filter(([name]) => name === 'element:load:error');
        expect(queued).toHaveLength(emitsError ? 1 : 0);
        if (emitsError) {
          await Promise.race([event, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out awaiting element:load:error')), 2000);
          })]);
        }
      } finally {
        clearTimeout(timer);
        off();
      }
    }

    async function failLoad(userId: string, emitsError = true) {
      await expectFailure(() => asUser(userId, () => manager.load(identity)), emitsError);
    }

    it('reports invalid details and counts only for the current user', async () => {
      await failLoad(userA);
      await asUser(userA, async () => {
        const record = manager.getInvalidElement(identity);
        expect(record).toBeDefined();
        const response = await handler.getElementDetails(identity, 'skills');
        expect(response.content[0].text).toContain('Skill Invalid');
        expect(response.content[0].text).toContain(record!.reason);
        expect(await handler.listElements('skills')).toMatchObject({ warnings: { invalid_elements_count: 1 } });
      });
      await asUser(userB, async () => {
        expect(manager.getInvalidElement(identity)).toBeUndefined();
        expect(manager.getInvalidElements()).toEqual([]);
        await expect(handler.getElementDetails(identity, 'skills')).rejects.toBeInstanceOf(ElementNotFoundError);
        expect(await handler.listElements('skills')).not.toHaveProperty('warnings');
      });
    });

    it('keeps the other namespace record when both recorded the same relative identifier', async () => {
      await writeDefinition(userB, invalidContent, true);
      await failLoad(userA);
      await failLoad(userB);
      const original = await asUser(userA, async () => manager.getInvalidElement(identity));
      // A public database row has the same storage identity for both readers.
      await writeDefinition(userB, validContent, true);
      await asUser(userB, async () => {
        expect((await manager.load(identity)).metadata.name).toBe('shared-skill');
        expect(manager.getInvalidElements()).toEqual([]);
      });
      await asUser(userA, async () => expect(manager.getInvalidElement(identity)).toEqual(original));
    });

    it('emits the first error per namespace and re-emits after successful recovery', async () => {
      await writeDefinition(userB, invalidContent, true);
      await failLoad(userA);
      await failLoad(userA, false);
      expect(errorUsers).toEqual([userA]);
      await failLoad(userB);
      await failLoad(userB, false);
      expect(errorUsers).toEqual([userA, userB]);
      await writeDefinition(userB, validContent, true);
      await asUser(userB, () => manager.load(identity));
      await writeDefinition(userB, invalidContent, true);
      await failLoad(userB);
      await failLoad(userA, false);
      expect(errorUsers).toEqual([userA, userB, userB]);
    });

    it('keeps system failures separate from a subsequent caller failure', async () => {
      if (mode === 'filesystem') {
        await mkdir(manager['elementDir'], { recursive: true });
        await writeFile(path.join(manager['elementDir'], identity), invalidContent);
      }
      await expectFailure(() => manager.load(identity));
      const systemRecord = manager.getInvalidElement(identity);
      expect(systemRecord).toBeDefined();
      await asUser(userA, async () => expect(manager.getInvalidElements()).toEqual([]));
      await failLoad(userA);
      await asUser(userA, async () => expect(manager.getInvalidElement(identity)).toBeDefined());
      expect(manager.getInvalidElement(identity)).toEqual(systemRecord);
      expect(errorUsers).toEqual(['system', userA]);
    });

    it('clears a missing definition record only when its owner loads it', async () => {
      await writeDefinition(userB, invalidContent, true);
      await failLoad(userA);
      await failLoad(userA, false);
      await failLoad(userB);
      if (mode === 'database') {
        await withUserContext(getTestDb(), userA, tx => tx.delete(elements).where(eq(elements.id, identity)));
      } else {
        await unlink(path.join(paths.getUserElementDir(ElementType.SKILL, userA), identity));
      }
      await failLoad(userA);
      await asUser(userA, async () => expect(manager.getInvalidElements()).toEqual([]));
      await asUser(userB, async () => expect(manager.getInvalidElements()).toHaveLength(1));
      expect(errorUsers).toEqual([userA, userB, userA]);
    });

    it.each(['manager', 'cache'] as const)('clears records and repeated-error history through %s reset', async reset => {
      await writeDefinition(userB, invalidContent, true);
      await failLoad(userA);
      await failLoad(userA, false);
      await failLoad(userB);
      await failLoad(userB, false);
      if (reset === 'manager') manager.clearCache();
      else manager['_cache'].clear();
      await asUser(userA, async () => expect(manager.getInvalidElements()).toEqual([]));
      await asUser(userB, async () => expect(manager.getInvalidElements()).toEqual([]));
      await failLoad(userA);
      await failLoad(userB);
      expect(errorUsers).toEqual([userA, userB, userA, userB]);
    });
  });
}
