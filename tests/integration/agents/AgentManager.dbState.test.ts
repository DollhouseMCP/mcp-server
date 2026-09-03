/// <reference types="node" />

import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { agentStates } from '../../../src/database/schema/agents.js';
import { elements } from '../../../src/database/schema/elements.js';
import {
  cleanupAllTestData,
  cleanupTestAgentStates,
  closeTestDb,
  ensureTestUser,
  getTestDb,
  isDatabaseAvailable,
} from '../database/test-db-helpers.js';

const DB_STATE_AGENT_NAME = 'db-state-agent';

let dbAvailable = false;

function createDbAgentManager(tempDir: string, tracker: ContextTracker): AgentManager {
  const fileLockManager = new FileLockManager();
  const fileOperations = new FileOperationsService(fileLockManager);
  const metadataService = new MetadataService();
  const portfolioManager = new PortfolioManager(fileOperations, { baseDir: tempDir });
  const validationRegistry = new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService,
  );
  const userIdResolver = createUserIdResolver(tracker);
  const sessionIdResolver = createSessionIdResolver(tracker);

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
}

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
        const manager = createDbAgentManager(tempDir, tracker);
        const created = await manager.create(
          DB_STATE_AGENT_NAME,
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

        await manager.executeAgent(DB_STATE_AGENT_NAME, { objective: 'remember me' });

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

        const reloadedManager = createDbAgentManager(tempDir, tracker);
        const reloaded = await reloadedManager.getAgentState({
          agentName: DB_STATE_AGENT_NAME,
          includeDecisionHistory: true,
        });

        expect(reloaded.state.goals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ description: 'remember me' }),
          ]),
        );

        const recoveryState = await reloadedManager.getAgentStateForRecovery({
          agentName: DB_STATE_AGENT_NAME,
        });
        const activeGoal = recoveryState.state.goals.find((goal) => goal.status === 'in_progress');
        expect(activeGoal).toBeDefined();
        if (!activeGoal) {
          throw new Error('Expected an active recovery goal');
        }

        await reloadedManager.completeAgentGoalForRecovery({
          agentName: DB_STATE_AGENT_NAME,
          goalId: activeGoal.id,
          outcome: 'failure',
          summary: 'Recovery-path integration test',
        });

        const completedState = await reloadedManager.getAgentStateForRecovery({
          agentName: DB_STATE_AGENT_NAME,
        });
        expect(completedState.state.goals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: activeGoal.id, status: 'failed' }),
          ]),
        );
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('deletes DB-backed agents and their UUID-keyed runtime state by canonical filename', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-delete-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-delete-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createDbAgentManager(tempDir, tracker);
        const created = await manager.create(
          'db-delete-agent',
          'Deletes its runtime state with the element',
          'Use the provided objective as the active goal.',
          {
            goal: {
              template: '{objective}',
              parameters: [{ name: 'objective', type: 'string', required: true }],
            },
          },
        );
        expect(created.success).toBe(true);
        await manager.executeAgent('db-delete-agent', { objective: 'delete me' });

        const beforeDelete = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(beforeDelete).toHaveLength(1);

        await manager.delete('db-delete-agent.md');

        expect(await manager.read('db-delete-agent')).toBeNull();
        const afterDelete = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(afterDelete).toEqual([]);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps case/canonical-colliding agents isolated by exact name and durable UUID', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-identity-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-identity-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    const firstName = 'Case_Sensitive-Agent';
    const secondName = 'case-sensitive-agent';
    const ambiguousName = 'Case Sensitive Agent';

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const seedingManager = createDbAgentManager(tempDir, tracker);
        const created = await seedingManager.create(
          firstName,
          'First canonical-collision agent',
          'Use the provided objective as the active goal.',
          {
            goal: {
              template: '{objective}',
              parameters: [{ name: 'objective', type: 'string', required: true }],
            },
          },
        );
        expect(created.success).toBe(true);
        if (!created.element) {
          throw new Error('Expected the first DB identity test agent to be created');
        }

        const secondContent = (await seedingManager.exportElement(created.element))
          .replace(/^name:.*$/mu, `name: ${secondName}`)
          .replace('First canonical-collision agent', 'Second canonical-collision agent');
        const directLayer = new DatabaseStorageLayer(
          getTestDb(),
          createUserIdResolver(tracker),
          'agents',
        );
        await directLayer.writeContent('agents', secondName, secondContent, {
          author: '',
          version: '1.0.0',
          description: 'Second canonical-collision agent',
          tags: [],
        });

        const manager = createDbAgentManager(tempDir, tracker);
        await expect(manager.read(firstName)).resolves.toMatchObject({
          metadata: expect.objectContaining({ name: firstName }),
        });
        await expect(manager.read(secondName)).resolves.toMatchObject({
          metadata: expect.objectContaining({ name: secondName }),
        });
        await expect(manager.read(ambiguousName)).resolves.toBeNull();
        await expect(manager.getAgentStateForRecovery({ agentName: ambiguousName }))
          .rejects.toThrow(/not found/iu);

        await manager.executeAgent(firstName, { objective: 'first identity goal' });
        await manager.executeAgent(secondName, { objective: 'second identity goal' });

        const elementRows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const firstId = elementRows.find((row) => row.name === firstName)?.id;
        const secondId = elementRows.find((row) => row.name === secondName)?.id;
        expect(firstId).toBeDefined();
        expect(secondId).toBeDefined();
        expect(firstId).not.toBe(secondId);

        const reloadedManager = createDbAgentManager(tempDir, tracker);
        const firstState = await reloadedManager.getAgentState({ agentName: firstName });
        const secondState = await reloadedManager.getAgentState({ agentName: secondName });
        expect(firstState.state.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'first identity goal' })]),
        );
        expect(firstState.state.goals).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'second identity goal' })]),
        );
        expect(secondState.state.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'second identity goal' })]),
        );

        const reclaimed = await reloadedManager.reclaimOrphanedAgentState({ agentName: firstName });
        expect(reclaimed?.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'first identity goal' })]),
        );
        expect(reclaimed?.goals).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'second identity goal' })]),
        );

        const recoveryState = await reloadedManager.getAgentStateForRecovery({ agentName: firstName });
        const activeGoal = recoveryState.state.goals.find((goal) => goal.status === 'in_progress');
        expect(activeGoal).toBeDefined();
        if (!activeGoal) {
          throw new Error('Expected an active goal for strict DB recovery');
        }
        await reloadedManager.completeAgentGoalForRecovery({
          agentName: firstName,
          goalId: activeGoal.id,
          outcome: 'success',
          summary: 'Complete only the exact requested DB agent',
        });

        const stateRows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ agentId: agentStates.agentId, goals: agentStates.goals })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        const firstRow = stateRows.find((row) => row.agentId === firstId);
        const secondRow = stateRows.find((row) => row.agentId === secondId);
        expect(firstRow?.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: activeGoal.id, status: 'completed' })]),
        );
        expect(secondRow?.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'second identity goal', status: 'in_progress' })]),
        );

        await reloadedManager.delete(`${secondName}.md`);
        await expect(reloadedManager.read(firstName)).resolves.toMatchObject({
          metadata: expect.objectContaining({ name: firstName }),
        });

        const remainingElementRows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        expect(remainingElementRows).toEqual([
          expect.objectContaining({ id: firstId, name: firstName }),
        ]);

        const remainingStateRows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(remainingStateRows.map((row) => row.agentId)).toEqual([firstId]);
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
      // Production HTTP sessions share the root AgentManager. Reuse one here
      // so this test catches session state leaking through its element cache.
      const manager = createDbAgentManager(tempDir, tracker);
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session: sessionAlpha }, async () => {
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
