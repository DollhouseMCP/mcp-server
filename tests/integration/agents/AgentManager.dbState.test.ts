/// <reference types="node" />

import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
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
import { withUserContext, withUserRead } from '../../../src/database/rls.js';
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

  it('keeps canonical-alias execution name-keyed to the same database row', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-save-identity-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-save-identity-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createDbAgentManager(tempDir, tracker);
        const rawName = 'Database_Save-Agent';
        expect((await manager.create(
          rawName,
          'Database identity remains name-keyed',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);

        const before = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        expect(before).toHaveLength(1);

        await manager.executeAgent('database-save-agent', { objective: 'preserve the row identity' });

        const after = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const states = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(after).toEqual(before);
        expect(after[0]?.name).toBe(rawName);
        expect(states).toEqual([{ agentId: before[0]?.id }]);
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
        const agentId = beforeDelete[0]?.agentId;
        expect(agentId).toBeDefined();
        if (!agentId) throw new Error('Expected the DB delete fixture UUID');
        const cachedAgent = await manager.read('db-delete-agent');
        expect(cachedAgent).not.toBeNull();

        await manager.delete('db-delete-agent.md');

        expect(await manager.read('db-delete-agent')).toBeNull();
        expect(await manager.findByStorageIdentity(agentId)).toBeUndefined();
        await expect(manager.activateAgentByStorageIdentity({ kind: 'database', value: agentId }))
          .resolves.toMatchObject({ success: false });
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

  it('fails closed when a stale canonical delete alias becomes ambiguous externally', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-stale-delete-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-stale-delete-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };
    const firstName = 'Stale_Alias-Agent';
    const secondName = 'stale-alias-agent';

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const staleManager = createDbAgentManager(tempDir, tracker);
        expect((await staleManager.create(
          firstName,
          'First externally-colliding agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);
        await staleManager.executeAgent(firstName, { objective: 'preserve first state' });

        const externalManager = createDbAgentManager(tempDir, tracker);
        expect((await externalManager.create(
          secondName,
          'Second externally-colliding agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);
        await externalManager.executeAgent(secondName, { objective: 'preserve second state' });

        await expect(staleManager.delete('Stale Alias Agent.md')).rejects.toThrow(/not found|ambiguous/iu);

        const remainingDefinitions = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const remainingStates = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(new Set(remainingDefinitions.map(row => row.name))).toEqual(new Set([firstName, secondName]));
        expect(new Set(remainingStates.map(row => row.agentId))).toEqual(
          new Set(remainingDefinitions.map(row => row.id)),
        );
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed for stale ordinary and strict reads after an external canonical insert', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-stale-read-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-stale-read-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };
    const firstName = 'Stale_Read-Agent';
    const secondName = 'stale-read-agent';
    const ambiguousName = 'Stale Read Agent';

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const staleManager = createDbAgentManager(tempDir, tracker);
        expect((await staleManager.create(
          firstName,
          'First stale-read agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);
        await staleManager.executeAgent(firstName, { objective: 'first state only' });
        await staleManager.refreshIndex();

        const externalManager = createDbAgentManager(tempDir, tracker);
        expect((await externalManager.create(
          secondName,
          'Second stale-read agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);
        await externalManager.executeAgent(secondName, { objective: 'second state only' });

        const [ordinaryRead, strictRead] = await Promise.allSettled([
          staleManager.read(ambiguousName),
          staleManager.getAgentStateForRecovery({ agentName: ambiguousName }),
        ]);
        expect({ ordinaryRead, strictRead }).toEqual({
          ordinaryRead: { status: 'fulfilled', value: null },
          strictRead: { status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/not found/iu) }) },
        });
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a canonical sibling is inserted during delete authorization', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-delete-race-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-delete-race-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };
    const firstName = 'Delete_Race-Agent';
    const secondName = 'delete-race-agent';

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createDbAgentManager(tempDir, tracker);
        const created = await manager.create(
          firstName,
          'First delete-race agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        );
        expect(created.success).toBe(true);
        if (!created.element) throw new Error('Expected delete-race fixture');
        await manager.executeAgent(firstName, { objective: 'preserve state during ambiguous delete' });
        const siblingContent = (await manager.exportElement(created.element))
          .replace(/^name:.*$/mu, `name: ${secondName}`)
          .replace('First delete-race agent', 'Second delete-race agent');
        const externalLayer = new DatabaseStorageLayer(getTestDb(), createUserIdResolver(tracker), 'agents');

        (manager as unknown as {
          canDelete: () => Promise<{ allowed: boolean }>;
        }).canDelete = async () => {
          await externalLayer.writeContent('agents', secondName, siblingContent, {
            author: '',
            version: '1.0.0',
            description: 'Second delete-race agent',
            tags: [],
          });
          return { allowed: true };
        };

        let deletionError: unknown;
        try {
          await manager.delete('Delete Race Agent.md');
        } catch (error) {
          deletionError = error;
        }
        const remainingDefinitions = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const remainingStates = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );

        expect({
          deletionError: deletionError instanceof Error ? deletionError.message : deletionError,
          names: remainingDefinitions.map(row => row.name).sort(),
          stateIds: remainingStates.map(row => row.agentId),
        }).toEqual({
          deletionError: expect.stringMatching(/not found|ambiguous/iu),
          names: [firstName, secondName].sort(),
          stateIds: [expect.any(String)],
        });
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('fails a lifecycle save when the validated database identity is replaced before write', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-write-race-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-write-race-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };
    const agentName = 'Write_Race-Agent';

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createDbAgentManager(tempDir, tracker);
        const created = await manager.create(
          agentName,
          'Original write-race agent',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        );
        expect(created.success).toBe(true);
        if (!created.element) throw new Error('Expected write-race fixture');

        const execution = await manager.executeAgent(agentName, { objective: 'original goal' });
        const originalIdentity = await manager.resolveExecutionIdentity(agentName);
        expect(originalIdentity.kind).toBe('database');
        const replacementContent = (await manager.exportElement(created.element))
          .replace('Original write-race agent', 'Replacement write-race agent');
        const storageLayer = (manager as unknown as {
          storageLayer: DatabaseStorageLayer;
        }).storageLayer;
        const originalWrite = storageLayer.writeContent.bind(storageLayer);
        let signalWriteReached!: () => void;
        let releaseWrite!: () => void;
        const writeReached = new Promise<void>(resolve => { signalWriteReached = resolve; });
        const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
        let held = false;
        const writeSpy = jest.spyOn(storageLayer, 'writeContent').mockImplementation(async (...args) => {
          if (!held) {
            held = true;
            signalWriteReached();
            await writeReleased;
          }
          return originalWrite(...args);
        });

        const stepSave = manager.recordAgentStep({
          agentName,
          goalId: execution.goalId,
          stepDescription: 'Must remain attached to the original UUID',
          outcome: 'success',
          executionIdentity: originalIdentity,
        });
        await writeReached;

        const externalLayer = new DatabaseStorageLayer(
          getTestDb(),
          createUserIdResolver(tracker),
          'agents',
        );
        let replacementId: string;
        try {
          await externalLayer.deleteContentByIdentity('agents', agentName, {
            id: originalIdentity.value,
            name: agentName,
          });
          replacementId = await externalLayer.writeContent('agents', agentName, replacementContent, {
            author: '',
            version: '1.0.0',
            description: 'Replacement write-race agent',
            tags: [],
          });
        } finally {
          releaseWrite();
        }

        await expect(stepSave).rejects.toMatchObject({ code: 'ESTALE' });
        expect(replacementId).not.toBe(originalIdentity.value);
        await expect(externalLayer.readContent(replacementId)).resolves.toBe(replacementContent);
        const replacementStates = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.agentId, replacementId))
        );
        expect(replacementStates).toEqual([]);
        writeSpy.mockRestore();
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('deletes an exact UUID and only its cascaded state on a cold manager', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-cold-uuid-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-cold-uuid-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const seedingManager = createDbAgentManager(tempDir, tracker);
        for (const name of ['cold-uuid-target', 'cold-uuid-sibling']) {
          expect((await seedingManager.create(
            name,
            `Definition for ${name}`,
            'Use the objective.',
            { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
          )).success).toBe(true);
          await seedingManager.executeAgent(name, { objective: `${name} state` });
        }

        const beforeDefinitions = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const targetId = beforeDefinitions.find(row => row.name === 'cold-uuid-target')?.id;
        const siblingId = beforeDefinitions.find(row => row.name === 'cold-uuid-sibling')?.id;
        expect(targetId).toBeDefined();
        expect(siblingId).toBeDefined();
        if (!targetId || !siblingId) throw new Error('Expected both cold UUID fixtures');

        const coldManager = createDbAgentManager(tempDir, tracker);
        await coldManager.delete(targetId);

        const remainingDefinitions = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const remainingStates = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(remainingDefinitions.map(row => row.id)).toEqual([siblingId]);
        expect(remainingStates.map(row => row.agentId)).toEqual([siblingId]);
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves definition and state when a concurrent rename makes deletion affect zero rows', async () => {
    if (!dbAvailable) return;

    const userId = await ensureTestUser();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-manager-db-zero-delete-'));
    const tracker = new ContextTracker();
    const session = {
      userId,
      sessionId: 'agent-manager-db-zero-delete-test',
      tenantId: null,
      transport: 'http' as const,
      createdAt: Date.now(),
      roles: ['admin'],
    };

    try {
      await tracker.runAsync({ type: 'test', timestamp: Date.now(), session }, async () => {
        const manager = createDbAgentManager(tempDir, tracker);
        expect((await manager.create(
          'rename-during-delete',
          'Definition survives a zero-row delete',
          'Use the objective.',
          { goal: { template: '{objective}', parameters: [{ name: 'objective', type: 'string', required: true }] } },
        )).success).toBe(true);
        await manager.executeAgent('rename-during-delete', { objective: 'state must survive' });

        const definitionRows = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id }).from(elements).where(eq(elements.userId, userId))
        );
        const targetId = definitionRows[0]?.id;
        expect(targetId).toBeDefined();
        if (!targetId) throw new Error('Expected rename-during-delete fixture');

        (manager as unknown as {
          canDelete: () => Promise<{ allowed: boolean }>;
        }).canDelete = async () => {
          await withUserContext(getTestDb(), userId, tx =>
            tx.update(elements)
              .set({ name: 'renamed-before-delete' })
              .where(eq(elements.id, targetId))
          );
          return { allowed: true };
        };

        await expect(manager.delete(targetId)).rejects.toThrow(/not found/iu);

        const remainingDefinitions = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ id: elements.id, name: elements.name })
            .from(elements)
            .where(eq(elements.userId, userId))
        );
        const remainingStates = await withUserRead(getTestDb(), userId, tx =>
          tx.select({ agentId: agentStates.agentId })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        expect(remainingDefinitions).toEqual([{ id: targetId, name: 'renamed-before-delete' }]);
        expect(remainingStates).toEqual([{ agentId: targetId }]);
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

        const manager = createDbAgentManager(tempDir, tracker);
        await expect(manager.resolveExecutionIdentity(firstName)).resolves.toEqual({
          kind: 'database',
          value: firstId,
        });
        await expect(manager.resolveExecutionIdentity(secondName)).resolves.toEqual({
          kind: 'database',
          value: secondId,
        });
        let firstAgent: Awaited<ReturnType<AgentManager['read']>> = null;
        let secondAgent: Awaited<ReturnType<AgentManager['read']>> = null;
        const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        try {
          firstAgent = await manager.read(firstName);
          secondAgent = await manager.read(secondName);
          expect(firstAgent).toMatchObject({ metadata: expect.objectContaining({ name: firstName }) });
          expect(secondAgent).toMatchObject({ metadata: expect.objectContaining({ name: secondName }) });
          expect(firstAgent?.id).toBe(secondAgent?.id);
          expect(await manager.findByStorageIdentity(firstId as string)).toBe(firstAgent);
          expect(await manager.findByStorageIdentity(secondId as string)).toBe(secondAgent);
          expect(await manager.read(firstName)).toBe(firstAgent);
          expect(await manager.read(secondName)).toBe(secondAgent);
          await expect(manager.read(ambiguousName)).resolves.toBeNull();
          await expect(manager.getAgentStateForRecovery({ agentName: ambiguousName }))
            .rejects.toThrow(/not found/iu);

          await manager.executeAgent(firstName, { objective: 'first identity goal' });
          await manager.executeAgent(secondName, { objective: 'second identity goal' });
        } finally {
          dateNowSpy.mockRestore();
        }

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

        const recoveryState = await manager.getAgentStateForRecovery({ agentName: firstName });
        const activeGoal = recoveryState.state.goals.find((goal) => goal.status === 'in_progress');
        expect(activeGoal).toBeDefined();
        if (!activeGoal) throw new Error('Expected an active goal for strict DB recovery');
        await manager.completeAgentGoalForRecovery({
          agentName: firstName,
          goalId: activeGoal.id,
          outcome: 'success',
          summary: 'Complete only the exact requested DB agent',
        });
        expect(firstAgent?.getState().goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: activeGoal.id, status: 'completed' })]),
        );
        expect(secondAgent?.getState().goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'second identity goal', status: 'in_progress' })]),
        );

        const stateRows = await withUserRead(getTestDb(), userId, (tx) =>
          tx
            .select({ agentId: agentStates.agentId, goals: agentStates.goals })
            .from(agentStates)
            .where(eq(agentStates.userId, userId))
        );
        const firstRow = stateRows.find((row) => row.agentId === firstId);
        const secondRow = stateRows.find((row) => row.agentId === secondId);
        expect(firstRow?.goals).toEqual(
          expect.arrayContaining([expect.objectContaining({ description: 'first identity goal', status: 'completed' })]),
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
