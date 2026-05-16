import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { eq } from 'drizzle-orm';

import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { createSessionIdResolver, createUserIdResolver } from '../../../src/database/UserContext.js';
import { withUserRead } from '../../../src/database/rls.js';
import { DatabaseAgentStateStore } from '../../../src/storage/DatabaseAgentStateStore.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { agentStates } from '../../../src/database/schema/agents.js';
import {
  cleanupAllTestData,
  cleanupTestAgentStates,
  closeTestDb,
  ensureTestUser,
  getTestDb,
  isDatabaseAvailable,
} from '../database/test-db-helpers.js';

let dbAvailable = false;

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    console.warn('Skipping AgentManager DB state tests — PostgreSQL not available');
  }
});

afterEach(async () => {
  if (dbAvailable) {
    const userId = await ensureTestUser();
    await cleanupTestAgentStates(userId);
    await cleanupAllTestData();
  }
});

afterAll(async () => {
  await closeTestDb();
});

describe('AgentManager DB-backed runtime state', () => {
  it('persists agent goals through agent_states and reloads them lazily', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-state-'));
    const tracker = new ContextTracker();
    const userIdResolver = createUserIdResolver(tracker);
    const sessionIdResolver = createSessionIdResolver(tracker);

    const createManager = (): AgentManager => {
      const fileLockManager = new FileLockManager();
      const fileOperations = new FileOperationsService(fileLockManager);
      const metadataService = new MetadataService();
      const portfolioManager = new PortfolioManager(fileOperations, { baseDir: tempDir });
      const validationRegistry = new ValidationRegistry(
        new ValidationService(),
        new TriggerValidationService(),
        metadataService,
      );

      return new AgentManager({
        portfolioManager,
        fileLockManager,
        baseDir: tempDir,
        fileOperationsService: fileOperations,
        validationRegistry,
        serializationService: new SerializationService(),
        metadataService,
        eventDispatcher: new ElementEventDispatcher(),
        storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), userIdResolver),
        stateStore: new DatabaseAgentStateStore(getTestDb(), userIdResolver, sessionIdResolver),
        contextTracker: tracker,
        getCurrentUserId: userIdResolver,
      });
    };

    const session = {
      userId,
      sessionId: 'agent-manager-db-state-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createManager();
        const created = await manager.create(
          'db-state-agent',
          'Persists runtime state in Postgres',
          'Use the provided objective as the active goal.',
          {
            goal: {
              template: '{objective}',
              parameters: [{ name: 'objective', type: 'string', required: true }],
            },
          },
        );
        expect(created.success).toBe(true);

        await manager.executeAgent('db-state-agent', { objective: 'remember me' });

        const rows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({
              sessionId: agentStates.sessionId,
              goals: agentStates.goals,
              stateVersion: agentStates.stateVersion,
            })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );

        expect(rows).toHaveLength(1);
        expect(rows[0].sessionId).toBe('agent-manager-db-state-test');
        expect(rows[0].stateVersion).toBeGreaterThanOrEqual(1);
        expect(rows[0].goals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ description: 'remember me' }),
          ]),
        );

        const reloadedManager = createManager();
        const reloaded = await reloadedManager.getAgentState({
          agentName: 'db-state-agent',
          includeDecisionHistory: true,
        });

        expect(reloaded.state.goals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ description: 'remember me' }),
          ]),
        );
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('isolates agent state between concurrent sessions for the same user and agent', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-state-isolation-'));
    const tracker = new ContextTracker();
    const userIdResolver = createUserIdResolver(tracker);
    const sessionIdResolver = createSessionIdResolver(tracker);

    const createManager = (): AgentManager => {
      const fileLockManager = new FileLockManager();
      const fileOperations = new FileOperationsService(fileLockManager);
      const metadataService = new MetadataService();
      const portfolioManager = new PortfolioManager(fileOperations, { baseDir: tempDir });
      const validationRegistry = new ValidationRegistry(
        new ValidationService(),
        new TriggerValidationService(),
        metadataService,
      );

      return new AgentManager({
        portfolioManager,
        fileLockManager,
        baseDir: tempDir,
        fileOperationsService: fileOperations,
        validationRegistry,
        serializationService: new SerializationService(),
        metadataService,
        eventDispatcher: new ElementEventDispatcher(),
        storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), userIdResolver),
        stateStore: new DatabaseAgentStateStore(getTestDb(), userIdResolver, sessionIdResolver),
        contextTracker: tracker,
        getCurrentUserId: userIdResolver,
      });
    };

    const sessionAlpha = {
      userId,
      sessionId: 'session-alpha',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };
    const sessionBeta = {
      userId,
      sessionId: 'session-beta',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session: sessionAlpha }, async () => {
        const manager = createManager();
        const created = await manager.create(
          'shared-state-agent',
          'Persists isolated runtime state in Postgres',
          'Use the provided objective as the active goal.',
          {
            goal: {
              template: '{objective}',
              parameters: [{ name: 'objective', type: 'string', required: true }],
            },
          },
        );
        expect(created.success).toBe(true);
        await manager.executeAgent('shared-state-agent', { objective: 'goal from alpha' });
      });

      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session: sessionBeta }, async () => {
        const manager = createManager();
        await manager.executeAgent('shared-state-agent', { objective: 'goal from beta' });
      });

      const rows = await withUserRead(getTestDb(), userId, (tx) =>
        tx
          .select({
            agentId: agentStates.agentId,
            sessionId: agentStates.sessionId,
            goals: agentStates.goals,
          })
          .from(agentStates)
          .where(eq(agentStates.userId, userId))
      );

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.agentId)).size).toBe(1);
      const alphaRow = rows.find((row) => row.sessionId === 'session-alpha');
      const betaRow = rows.find((row) => row.sessionId === 'session-beta');
      expect(alphaRow?.goals).toEqual(
        expect.arrayContaining([expect.objectContaining({ description: 'goal from alpha' })]),
      );
      expect(betaRow?.goals).toEqual(
        expect.arrayContaining([expect.objectContaining({ description: 'goal from beta' })]),
      );

      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session: sessionAlpha }, async () => {
        const manager = createManager();
        const state = await manager.getAgentState({ agentName: 'shared-state-agent' });
        expect(state.state.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'goal from alpha' })]),
        );
        expect(state.state.goals).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'goal from beta' })]),
        );
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
