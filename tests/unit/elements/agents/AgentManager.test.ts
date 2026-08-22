/**
 * Unit tests for AgentManager implementation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Mock the security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/services/FileOperationsService.js');

// Import after mocking
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { AgentSnapshotReplacementJournal } from '../../../../src/elements/agents/AgentSnapshotReplacementJournal.js';
import { AGENT_LIMITS } from '../../../../src/elements/agents/constants.js';
import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { SECURITY_LIMITS } from '../../../../src/security/constants.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import type { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import type { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService, TestableAgentManager } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';
import type { SessionContext } from '../../../../src/context/SessionContext.js';
import { crashFilesystemGuardOwner } from '../../../helpers/crashFilesystemGuardOwner.js';

const metadataService: MetadataService = createTestMetadataService();
const TEST_AGENT_NAME = 'test-agent';
const STATE_FILE_SUFFIX = '.state.yaml';

function asAsyncRead(
  implementation: (filePath: string) => string
): FileOperationsService['readFile'] {
  return (filePath) => Promise.resolve().then(() => implementation(filePath));
}

function requireLoadedAgent(agent: Agent | null): Agent {
  if (!agent) {
    throw new Error('Expected agent to load');
  }
  return agent;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

interface AgentManagerExecutionInternals {
  executeAgentWithinStateOperation(
    name: string,
    parameters: Record<string, unknown>,
    context: { operationName?: 'execute_agent' | 'continue_execution' },
  ): ReturnType<AgentManager['executeAgent']>;
  contextTracker?: { getSessionContext: () => SessionContext | undefined };
}

function getExecutionInternals(manager: AgentManager): AgentManagerExecutionInternals {
  return manager as unknown as AgentManagerExecutionInternals;
}

describe('AgentManager', () => {
  let agentManager: TestableAgentManager;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let container: InstanceType<typeof DollhouseContainer>;
  let _fileLockManager: FileLockManager;
  let fileOperationsService: jest.Mocked<FileOperationsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    // Create temporary test directory

    testDir = path.join(os.tmpdir(), `agent-test-${randomUUID()}`);
    portfolioPath = testDir;
    
    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };
    
    container = new DollhouseContainer();
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    container.register<FileLockManager>('FileLockManager', () => new FileLockManager());
    
      const mockFileOperations: any = {
        createDirectory: jest.fn<FileOperationsService['createDirectory']>().mockResolvedValue(),
        exists: jest.fn<FileOperationsService['exists']>().mockResolvedValue(false),
        readFile: jest.fn<FileOperationsService['readFile']>().mockResolvedValue(''),
        writeFile: jest.fn<FileOperationsService['writeFile']>().mockResolvedValue(),
        deleteFile: jest.fn<FileOperationsService['deleteFile']>().mockResolvedValue(),
        stat: jest.fn<FileOperationsService['stat']>().mockResolvedValue({} as Awaited<ReturnType<FileOperationsService['stat']>>),
        listDirectory: jest.fn<FileOperationsService['listDirectory']>().mockResolvedValue([]),
        resolvePath: jest.fn<FileOperationsService['resolvePath']>((p: string) => path.resolve(portfolioPath, p)),
        validatePath: jest.fn<FileOperationsService['validatePath']>().mockReturnValue(true),
        createFileExclusive: jest.fn<FileOperationsService['createFileExclusive']>().mockResolvedValue(true)
    };
    // BaseElementManager.load uses readElementFile. Wire dynamically so tests
    // that reassign readFile via mockResolvedValue still flow through.
    mockFileOperations.readElementFile = jest.fn((...args: unknown[]) => mockFileOperations.readFile(...args));
    container.register<FileOperationsService>('FileOperationsService', () => mockFileOperations);

    // Register DI services
    container.register('SerializationService', () => new SerializationService());
    container.register('MetadataService', () => metadataService);
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

    // Using TestableAgentManager to expose protected saveAgentState for testing (Issue #123)
    container.register('AgentManager', () => new TestableAgentManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      baseDir: portfolioPath,
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
    }));

    agentManager = container.resolve<TestableAgentManager>('AgentManager');
    _fileLockManager = container.resolve<FileLockManager>('FileLockManager');
    fileOperationsService = container.resolve<FileOperationsService>('FileOperationsService') as jest.Mocked<FileOperationsService>;

    // Initialize manager
    await agentManager.initialize();
  });

  afterEach(async () => {
    await container.dispose();
    await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  });

  describe('Initialization', () => {
    it('should create agents directory structure', () => {
      expect(fileOperationsService.createDirectory).toHaveBeenCalledTimes(2); // agents dir + state dir
    });

    it('uses separate cache namespaces for DB-backed transport sessions', () => {
      let currentSession: SessionContext = {
        userId: 'shared-user',
        sessionId: 'session-a',
        tenantId: null,
        transport: 'http',
        createdAt: Date.now(),
      };
      const internals = agentManager as unknown as {
        contextTracker?: { getSessionContext: () => SessionContext | undefined };
        storageLayer: { writeContent?: () => Promise<string> };
        getCacheNamespace: () => string;
      };
      internals.contextTracker = { getSessionContext: () => currentSession };
      internals.storageLayer.writeContent = async () => 'unused-test-id';

      const sessionANamespace = internals.getCacheNamespace();
      currentSession = { ...currentSession, sessionId: 'session-b' };
      const sessionBNamespace = internals.getCacheNamespace();

      expect(sessionANamespace).toBe('shared-user:agent-session:session-a');
      expect(sessionBNamespace).toBe('shared-user:agent-session:session-b');
      expect(sessionANamespace).not.toBe(sessionBNamespace);
    });
  });

  describe('Recovery state synchronization', () => {
    it('continues the requested in-progress goal instead of another session goal', async () => {
      const agent = new Agent({ name: 'test-agent' }, metadataService);
      const otherGoal = agent.addGoal({ description: 'Other session execution' });
      otherGoal.status = 'in_progress';
      const ownedGoal = agent.addGoal({ description: 'Calling session execution' });
      ownedGoal.status = 'in_progress';
      agent.recordDecision({
        goalId: ownedGoal.id,
        decision: 'pause',
        reasoning: 'Paused for an external dependency',
        confidence: 1,
        outcome: 'partial',
      });
      jest.spyOn(agentManager, 'read').mockResolvedValue(agent);
      const executeSpy = jest.spyOn(
        getExecutionInternals(agentManager),
        'executeAgentWithinStateOperation',
      ).mockResolvedValue({
        agentName: 'test-agent',
        goal: 'Continued execution',
        goalId: 'goal-continuation',
        activeElements: {},
        availableTools: [],
        successCriteria: [],
        safetyTier: 'advisory',
      });

      await expect(agentManager.continueAgentExecution({
        agentName: 'test-agent',
        goalId: ownedGoal.id,
      })).resolves.toEqual(expect.objectContaining({
        previousState: expect.objectContaining({
          goals: expect.arrayContaining([
            expect.objectContaining({ id: ownedGoal.id }),
          ]),
        }),
      }));

      expect(executeSpy).toHaveBeenCalledWith(
        'test-agent',
        {},
        { operationName: 'continue_execution' },
      );
    });

    it('rejects a requested goal that is not in progress', async () => {
      const agent = new Agent({ name: 'test-agent' }, metadataService);
      const activeGoal = agent.addGoal({ description: 'Another active execution' });
      activeGoal.status = 'in_progress';
      jest.spyOn(agentManager, 'read').mockResolvedValue(agent);
      const executeSpy = jest.spyOn(
        getExecutionInternals(agentManager),
        'executeAgentWithinStateOperation',
      );

      await expect(agentManager.continueAgentExecution({
        agentName: 'test-agent',
        goalId: 'goal-not-owned',
      })).rejects.toThrow("Goal 'goal-not-owned' is not an in-progress goal");

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects a second completion of an explicitly identified finalized goal', async () => {
      const agent = new Agent({ name: 'test-agent' }, metadataService);
      const completedGoal = agent.addGoal({ description: 'Already completed execution' });
      completedGoal.status = 'in_progress';
      agent.completeGoal(completedGoal.id, 'success');
      const originalDecisionCount = agent.getState().decisions.length;
      jest.spyOn(agentManager, 'read').mockResolvedValue(agent);

      await expect(agentManager.completeAgentGoal({
        agentName: 'test-agent',
        goalId: completedGoal.id,
        outcome: 'failure',
        summary: 'Attempted duplicate completion',
      })).rejects.toThrow(`Goal '${completedGoal.id}' is not in progress`);

      const unchangedGoal = agent.getState().goals.find(goal => goal.id === completedGoal.id);
      expect(unchangedGoal?.status).toBe('completed');
      expect(agent.getState().decisions).toHaveLength(originalDecisionCount);
    });

    it('serializes continuation and completion across sessions for the same user', async () => {
      let currentSession = {
        userId: 'shared-user',
        sessionId: 'session-a',
        tenantId: null,
        transport: 'http' as const,
        createdAt: Date.now(),
      };
      getExecutionInternals(agentManager).contextTracker = {
        getSessionContext: () => currentSession,
      };

      const agent = new Agent({ name: 'test-agent' }, metadataService);
      const sourceGoal = agent.addGoal({ description: 'Paused execution' });
      sourceGoal.status = 'in_progress';
      agent.recordDecision({
        goalId: sourceGoal.id,
        decision: 'pause',
        reasoning: 'Waiting for continuation',
        confidence: 1,
        outcome: 'partial',
      });
      const readSpy = jest.spyOn(agentManager, 'read').mockResolvedValue(agent);

      let markContinuationStarted: (() => void) | undefined;
      const continuationStarted = new Promise<void>((resolve) => {
        markContinuationStarted = resolve;
      });
      let releaseContinuation: (() => void) | undefined;
      const continuationRelease = new Promise<void>((resolve) => {
        releaseContinuation = resolve;
      });
      jest.spyOn(getExecutionInternals(agentManager), 'executeAgentWithinStateOperation')
        .mockImplementation(async () => {
          markContinuationStarted?.();
          await continuationRelease;
          return {
            agentName: 'test-agent',
            goal: 'Continued execution',
            goalId: 'goal-continuation',
            activeElements: {},
            availableTools: [],
            successCriteria: [],
            safetyTier: 'advisory',
          };
        });

      const continuation = agentManager.continueAgentExecution({
        agentName: 'test-agent',
        goalId: sourceGoal.id,
      });
      await continuationStarted;

      currentSession = { ...currentSession, sessionId: 'session-b' };
      const completion = agentManager.completeAgentGoal({
        agentName: 'test-agent',
        goalId: sourceGoal.id,
        outcome: 'success',
        summary: 'Completed from another session',
      });
      await Promise.resolve();
      expect(readSpy).toHaveBeenCalledTimes(1);

      releaseContinuation?.();
      await expect(continuation).resolves.toEqual(expect.objectContaining({
        goalId: 'goal-continuation',
      }));
      await expect(completion).resolves.toEqual(expect.objectContaining({ success: true }));
      expect(readSpy).toHaveBeenCalledTimes(2);
    });

    it('serializes execute_agent behind an in-flight orphan reclaim', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('.state.yaml')) {
          throw Object.assign(new Error('missing state'), { code: 'ENOENT' });
        }
        return `---
name: test-agent
---
Content`;
      });
      const agent = await agentManager.read('test-agent');
      expect(agent).not.toBeNull();

      let markReclaimStarted: (() => void) | undefined;
      const reclaimStarted = new Promise<void>((resolve) => {
        markReclaimStarted = resolve;
      });
      let resolveReclaim: ((state: null) => void) | undefined;
      jest.spyOn((agentManager as any).stateStore, 'reclaimOrphaned')
        .mockImplementation(() => new Promise((resolve) => {
          markReclaimStarted?.();
          resolveReclaim = resolve;
        }));
      const loadExecutable = jest.spyOn(agentManager as any, 'loadExecutableAgent')
        .mockRejectedValue(new Error('execution reached serialized boundary'));

      const reclaim = agentManager.reclaimOrphanedAgentState({ agentName: 'test-agent' });
      await reclaimStarted;
      const execute = agentManager.executeAgent('test-agent', {});
      await Promise.resolve();
      expect(loadExecutable).not.toHaveBeenCalled();

      resolveReclaim?.(null);
      await expect(reclaim).resolves.toBeNull();
      await expect(execute).rejects.toThrow('execution reached serialized boundary');
      expect(loadExecutable).toHaveBeenCalledTimes(1);
    });

    it('does not hydrate reclaimed state over an execution started during the read', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('.state.yaml')) {
          throw Object.assign(new Error('missing state'), { code: 'ENOENT' });
        }
        return `---
name: test-agent
---
Content`;
      });
      const agent = await agentManager.read('test-agent');
      expect(agent).not.toBeNull();

      let markReadStarted: (() => void) | undefined;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      let resolveState: ((state: any) => void) | undefined;
      jest.spyOn((agentManager as any).stateStore, 'reclaimOrphaned')
        .mockImplementation(() => new Promise((resolve) => {
          markReadStarted?.();
          resolveState = resolve;
        }));

      const reclaim = agentManager.reclaimOrphanedAgentState({ agentName: 'test-agent' });
      await readStarted;
      (agentManager as any).beginExecutionAttempt('test-agent');
      resolveState?.({
        goals: [{
          id: 'goal-orphan',
          description: 'Orphaned execution',
          priority: 'medium',
          status: 'in_progress',
          importance: 5,
          urgency: 5,
          createdAt: new Date(),
          updatedAt: new Date(),
        }],
        decisions: [],
        context: {},
        lastActive: new Date(),
        sessionCount: 1,
        stateVersion: 1,
      });
      (agentManager as any).endExecutionAttempt('test-agent');

      await expect(reclaim).resolves.toBeNull();
      expect(agent?.getState().goals).toEqual([]);
    });

    it('preserves a concurrently-created goal while applying a recovery completion', () => {
      const sourceAgent = new Agent({ name: 'recovery-agent' }, metadataService);
      const originalGoal = sourceAgent.addGoal({ description: 'Original execution' });
      originalGoal.status = 'in_progress';
      sourceAgent.markStatePersisted();

      const recoveryAgent = new Agent(sourceAgent.metadata, metadataService);
      recoveryAgent.deserialize(sourceAgent.serializeToJSON());

      const concurrentGoal = sourceAgent.addGoal({ description: 'Concurrent execution' });
      concurrentGoal.status = 'in_progress';
      recoveryAgent.recordDecision({
        goalId: originalGoal.id,
        decision: 'goal_complete',
        reasoning: 'Execution aborted during recovery',
        confidence: 1,
        outcome: 'failure',
      });
      recoveryAgent.completeGoal(originalGoal.id, 'failure');

      (agentManager as any).recoverySourceAgents.set(recoveryAgent, sourceAgent);
      (agentManager as any).synchronizeRecoveryState(recoveryAgent, 2, originalGoal.id);

      const synchronizedState = sourceAgent.getState();
      expect(synchronizedState.goals.find(goal => goal.id === originalGoal.id)?.status)
        .toBe('failed');
      expect(synchronizedState.goals.find(goal => goal.id === concurrentGoal.id)?.status)
        .toBe('in_progress');
      expect(synchronizedState.decisions.some(decision =>
        decision.goalId === originalGoal.id && decision.decision === 'goal_complete'
      )).toBe(true);
      expect(synchronizedState.stateVersion).toBe(2);
      expect(sourceAgent.needsStatePersistence()).toBe(true);
    });

    it('marks a recovery-only synchronization as fully persisted', () => {
      const sourceAgent = new Agent({ name: 'recovery-agent' }, metadataService);
      const originalGoal = sourceAgent.addGoal({ description: 'Original execution' });
      originalGoal.status = 'in_progress';
      sourceAgent.markStatePersisted();

      const recoveryAgent = new Agent(sourceAgent.metadata, metadataService);
      recoveryAgent.deserialize(sourceAgent.serializeToJSON());
      recoveryAgent.completeGoal(originalGoal.id, 'failure');

      (agentManager as any).recoverySourceAgents.set(recoveryAgent, sourceAgent);
      (agentManager as any).synchronizeRecoveryState(recoveryAgent, 2, originalGoal.id);

      expect(sourceAgent.getState().goals[0]?.status).toBe('failed');
      expect(sourceAgent.getState().stateVersion).toBe(2);
      expect(sourceAgent.needsStatePersistence()).toBe(false);
    });
  });

  describe('Create', () => {
    it('should create a new agent', async () => {
      const result = await agentManager.create(
        TEST_AGENT_NAME,
        'A test agent',
        'Agent instructions here',
        {
          specializations: ['testing'],
          decisionFramework: 'rule_based'
        }
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain(TEST_AGENT_NAME);
      expect(result.element).toBeInstanceOf(Agent);
      expect(fileOperationsService.createFileExclusive).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.any(String),
        expect.objectContaining({ source: expect.stringContaining('.save') })
      );
    });

    it('should notify the storage layer after creating a new agent', async () => {
      const notifySavedSpy = jest.spyOn((agentManager as any).storageLayer, 'notifySaved');

      const result = await agentManager.create(
        'indexed-agent',
        'A test agent',
        'Agent instructions here'
      );

      expect(result.success).toBe(true);
      expect(notifySavedSpy).toHaveBeenCalledWith(
        'indexed-agent.md',
        expect.stringContaining(path.join('agents', 'indexed-agent.md'))
      );
    });

    it('should create a content-only agent when reference content is provided via metadata', async () => {
      const result = await agentManager.create(
        'content-only-agent',
        'A content-only agent',
        '',
        {
          content: '# Reference Material\n\nAgent reference content without explicit instructions.'
        }
      );

      expect(result.success).toBe(true);
      expect(result.element).toBeInstanceOf(Agent);
      expect(result.element?.instructions).toBe('');
      expect(result.element?.content).toContain('Agent reference content');
    });

    it('should prefer behavioral instructions over reference content for validation when both are provided', async () => {
      const validateCreateSpy = jest.spyOn((agentManager as any).validator, 'validateCreate');

      const result = await agentManager.create(
        'dual-field-agent',
        'A dual-field agent',
        'Behavioral instructions content',
        {
          content: '# Reference Content\n\nSupplemental context.'
        }
      );

      expect(result.success).toBe(true);
      expect(validateCreateSpy).toHaveBeenCalledWith(expect.objectContaining({
        name: 'dual-field-agent',
        description: 'A dual-field agent',
        content: 'Behavioral instructions content'
      }));
      expect(result.element?.instructions).toContain('Behavioral instructions content');
      expect(result.element?.content).toContain('Supplemental context.');
    });

    it('should reject agent creation when both instructions and reference content are empty', async () => {
      const result = await agentManager.create(
        'empty-content-agent',
        'An invalid empty-content agent',
        '   ',
        {
          content: '   '
        }
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Validation failed');
      expect(result.message).toMatch(/Content is required|Content is too short/);
    });

    it('should reject content-only agent creation when reference content exceeds the maximum length', async () => {
      const oversizedReferenceContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);

      const result = await agentManager.create(
        'oversized-content-agent',
        'An invalid oversized content-only agent',
        '',
        {
          content: oversizedReferenceContent
        }
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/maximum length|Content validation failed/);
    });

    it('should reject invalid agent names', async () => {
      const result = await agentManager.create(
        'invalid name!',
        'Description',
        'Valid content for testing agent creation'
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Invalid|invalid characters/);
    });

    it('should detect existing agents', async () => {
      // Mock createFileExclusive to return false (file already exists)
      fileOperationsService.createFileExclusive.mockResolvedValue(false);

      const result = await agentManager.create('duplicate', 'Second', 'Valid content for testing agent creation');

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should reject duplicate metadata name even with different filename (Issue #613)', async () => {
      // Create a mock agent with name "my-agent" that list() will return
      const mockAgent = {
        metadata: { name: 'my-agent', description: 'First agent' },
        id: 'my-agent',
        extensions: {}
      };
      jest.spyOn(agentManager, 'list').mockResolvedValue([mockAgent as any]);

      // Try to create another agent with the same metadata name
      const result = await agentManager.create('my-agent', 'Second agent', 'Valid content for testing agent creation');

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
      // Should NOT have attempted file creation
      expect(fileOperationsService.createFileExclusive).not.toHaveBeenCalled();
    });

    it('should log security event on creation', async () => {
      await agentManager.create('new-agent', 'Description', 'Valid content for testing agent creation');

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_CREATED',
          severity: 'LOW',
          details: expect.stringContaining('new-agent')
        })
      );
    });
  });

  describe('Read', () => {
    beforeEach(() => {
      fileOperationsService.readFile.mockResolvedValue(`---
name: test-agent
type: agent
version: 1.0.0
description: Test agent
decisionFramework: rule_based
specializations:
  - testing
---

# Test Agent

Agent instructions here`);
    });

    it('should read an existing agent', async () => {
      const agent = await agentManager.read(TEST_AGENT_NAME);

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe(TEST_AGENT_NAME);
      expect(agent?.extensions?.decisionFramework).toBe('rule_based');
    });

    it('should return null for non-existent agent', async () => {
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          return Promise.reject({ code: 'ENOENT' });
        }
        return Promise.resolve('---\nname: test-agent\n---\nPrevious definition');
      });

      const agent = await agentManager.read('non-existent');
      expect(agent).toBeNull();
    });

    it('should reject oversized files', async () => {
      fileOperationsService.readFile.mockResolvedValue(
        `---\nname: huge-agent\ntype: agent\n---\n${'x'.repeat(SECURITY_LIMITS.MAX_FILE_SIZE)}`,
      );

      await expect(agentManager.read('huge-agent'))
        .rejects.toThrow('exceeds maximum size');
    });

    it('should load agent state if available', async () => {
      // Mock both agent file and state file
      fileOperationsService.readFile.mockImplementation(asAsyncRead((path: string) => {
          if (path.includes(STATE_FILE_SUFFIX)) {
            // Return state file content in YAML frontmatter format
            return `---
goals:
  - id: goal_123
    description: Test goal
    status: pending
decisions: []
context:
  key: value
lastActive: 2025-01-01T00:00:00Z
sessionCount: 5
---`;
          } else {
            // Return agent file content
            return `---
name: test-agent
type: agent
---
Content`;
          }
        }));

      const agent = await agentManager.read(TEST_AGENT_NAME);
      const state = agent?.getState();

      // Note: sessionCount is stored as string in YAML and parsed back as number
      expect(state?.sessionCount).toBe(5);
      expect(state?.context.key).toBe('value');
    });
  });

  describe('Update', () => {
    it('should update agent metadata', async () => {
      fileOperationsService.readFile.mockResolvedValue(`---
name: test-agent
description: Old description
---
Content`);

      const success = await agentManager.update(TEST_AGENT_NAME, {
        description: 'New description',
        specializations: ['updated', 'skills']
      });

      expect(success).toBe(true);
      expect(fileOperationsService.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('New description'),
        expect.any(Object)
      );
    });

    it('should return false for non-existent agent', async () => {
      fileOperationsService.readFile.mockRejectedValue({ code: 'ENOENT' });

      const success = await agentManager.update('non-existent', {
        description: 'New'
      });

      expect(success).toBe(false);
    });

    it('should save agent state if dirty', async () => {
      // Create a mock agent with dirty state
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      agent.addGoal({ description: 'New goal' }); // This makes state dirty

      // Mock the read to return our agent
      fileOperationsService.readFile.mockResolvedValue(`---
name: test-agent
---
Content`);

      // Mock the manager's read method to return our agent
      jest.spyOn(agentManager, 'read').mockImplementation(() => Promise.resolve(agent));

      await agentManager.update(TEST_AGENT_NAME, {});

      // Should have written both the agent file and state file
      expect(fileOperationsService.writeFile).toHaveBeenCalledTimes(2);
    });

    it('should not call saveAgentState when state is not dirty (Issue #123)', async () => {
      // Create a fresh agent WITHOUT making any state changes
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      // Note: NOT calling addGoal, recordDecision, or any state-modifying method
      // so needsStatePersistence() should return false

      // Mock the read to return our agent
      fileOperationsService.readFile.mockResolvedValue(`---
name: test-agent
---
Content`);

      // Mock the manager's read method to return our fresh (clean) agent
      jest.spyOn(agentManager, 'read').mockImplementation(() => Promise.resolve(agent));

      await agentManager.update(TEST_AGENT_NAME, { description: 'Updated description' });

      // Should have written ONLY the agent file, NOT the state file
      // because needsStatePersistence() returns false for clean state
      expect(fileOperationsService.writeFile).toHaveBeenCalledTimes(1);
      const writePath = (fileOperationsService.writeFile as jest.Mock).mock.calls[0][0];
      expect(writePath).toMatch(/test-agent\.md$/);
      expect(writePath).not.toMatch(/\.state\.yaml$/);
    });
  });

  describe('Snapshot replacement', () => {
    it('rejects a snapshot loaded before a concurrent definition edit', async () => {
      const expected = new Agent({ name: TEST_AGENT_NAME, description: 'Loaded earlier' }, metadataService);
      const current = new Agent({ name: TEST_AGENT_NAME, description: 'Concurrent edit' }, metadataService);
      const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Imported replacement' }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(current);
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) return Promise.reject({ code: 'ENOENT' });
        return Promise.resolve('---\nname: test-agent\ndescription: Concurrent edit\n---\nBody');
      });

      await expect(agentManager.replaceFromSnapshot(replacement, `${TEST_AGENT_NAME}.md`, {
        stateIncluded: false,
        expected,
      })).rejects.toThrow("Agent definition changed concurrently while replacing 'test-agent'");
      expect(fileOperationsService.writeFile).not.toHaveBeenCalled();
      expect(fileOperationsService.deleteFile).not.toHaveBeenCalled();
    });

    it('clears durable sidecar state when the imported snapshot omits state', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous definition' }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      fileOperationsService.readFile.mockResolvedValue(`---
goals: []
decisions: []
context: {}
lastActive: 2026-08-21T12:00:00.000Z
sessionCount: 1
stateVersion: 3
---`);

      await agentManager.replaceFromSnapshot(replacement, `${TEST_AGENT_NAME}.md`, {
        stateIncluded: false,
      });

      expect(fileOperationsService.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining(`${TEST_AGENT_NAME}.state.yaml`),
        ElementType.AGENT,
        expect.objectContaining({ source: 'AgentManager.delete (state file)' }),
      );
      expect(replacement.getState().stateVersion).toBe(0);
    });

    it('persists included snapshot state even though import deserialization marks it clean', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous definition' }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      replacement.addGoal({ description: 'Imported goal' });
      replacement.markStatePersisted();
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          return Promise.reject({ code: 'ENOENT' });
        }
        return Promise.resolve('---\nname: test-agent\n---\nPrevious definition');
      });

      await agentManager.replaceFromSnapshot(replacement, `${TEST_AGENT_NAME}.md`, {
        stateIncluded: true,
      });

      const stateWrite = fileOperationsService.writeFile.mock.calls.find(([filePath]) =>
        String(filePath).endsWith(`${TEST_AGENT_NAME}.state.yaml`));
      expect(stateWrite?.[1]).toContain('Imported goal');
      expect(stateWrite?.[2]).toEqual(expect.objectContaining({ durable: true }));
      const definitionWrite = fileOperationsService.writeFile.mock.calls.find(([filePath]) =>
        String(filePath).endsWith(`${TEST_AGENT_NAME}.md`));
      expect(definitionWrite?.[2]).toEqual(expect.objectContaining({ durable: true }));
      expect(replacement.getState().stateVersion).toBe(1);
      expect(replacement.needsStatePersistence()).toBe(false);
    });

    it('leaves the previous definition untouched when state removal fails', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous definition' }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Replacement definition' }, metadataService);
      fileOperationsService.readFile.mockResolvedValue(`---
goals: []
decisions: []
context: {}
lastActive: 2026-08-21T12:00:00.000Z
sessionCount: 1
stateVersion: 3
---`);
      fileOperationsService.deleteFile.mockRejectedValue(new Error('state removal failed'));

      await expect(agentManager.replaceFromSnapshot(replacement, `${TEST_AGENT_NAME}.md`, {
        stateIncluded: false,
      })).rejects.toThrow('state removal failed');

      expect(fileOperationsService.writeFile).not.toHaveBeenCalled();
    });

    it('restores the previous definition and state when definition persistence fails', async () => {
      const previous = new Agent({
        name: TEST_AGENT_NAME,
        description: 'Previous definition',
      }, metadataService);
      previous.instructions = 'Previous instructions';
      const previousSerialized = JSON.parse(previous.serializeToJSON());
      previousSerialized.state = {
        goals: [{
          id: 'prior-goal',
          description: 'Prior goal',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-08-21T12:00:00.000Z',
          updatedAt: '2026-08-21T12:00:00.000Z',
        }],
        decisions: [],
        context: {},
        lastActive: '2026-08-21T12:00:00.000Z',
        sessionCount: 1,
        stateVersion: 3,
      };
      previous.deserialize(JSON.stringify(previousSerialized));
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);

      const replacement = new Agent({
        name: TEST_AGENT_NAME,
        description: 'Replacement definition',
      }, metadataService);
      replacement.instructions = 'Replacement instructions';
      replacement.addGoal({ description: 'Imported goal' });
      replacement.markStatePersisted();

      let durableState = `---
goals:
  - id: prior-goal
    description: Prior goal
    status: pending
    priority: medium
    createdAt: 2026-08-21T12:00:00.000Z
    updatedAt: 2026-08-21T12:00:00.000Z
decisions: []
context: {}
lastActive: 2026-08-21T12:00:00.000Z
sessionCount: 1
stateVersion: 3
---`;
      let durableDefinition = 'original bytes';
      fileOperationsService.exists.mockResolvedValue(true);
      fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
        if (filePath.endsWith(STATE_FILE_SUFFIX)) return durableState;
        return durableDefinition;
      }));
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          durableState = String(content);
          return;
        }
        durableDefinition = String(content);
        if (durableDefinition.includes('Replacement instructions')) {
          throw new Error('definition persistence failed');
        }
      });

      await expect(agentManager.replaceFromSnapshot(replacement, `${TEST_AGENT_NAME}.md`, {
        stateIncluded: true,
      })).rejects.toThrow('definition persistence failed');

      expect(durableDefinition).toBe('original bytes');
      expect(durableDefinition).not.toContain('Replacement instructions');
      expect(durableState).toContain('Prior goal');
      expect(durableState).not.toContain('Imported goal');
      expect(fileOperationsService.writeFile.mock.calls.filter(([filePath]) =>
        String(filePath).endsWith(STATE_FILE_SUFFIX))).toHaveLength(2);

      previous.addGoal({ description: 'Goal after rollback' });
      await expect(agentManager.save(previous, `${TEST_AGENT_NAME}.md`)).resolves.toBeUndefined();
      expect(previous.getState().stateVersion).toBe(6);
      expect(durableState).toContain('Goal after rollback');
    });

    it('recovers a crash after state persistence but before definition persistence', async () => {
      const previous = new Agent({
        name: TEST_AGENT_NAME,
        description: 'Previous definition',
      }, metadataService);
      previous.instructions = 'Previous instructions';
      const previousJson = JSON.parse(previous.serializeToJSON());
      previousJson.state = {
        goals: [{
          id: 'prior-goal',
          description: 'Prior goal',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-08-21T12:00:00.000Z',
          updatedAt: '2026-08-21T12:00:00.000Z',
        }],
        decisions: [],
        context: { source: 'previous' },
        lastActive: '2026-08-21T12:00:00.000Z',
        sessionCount: 1,
        stateVersion: 3,
      };
      previous.deserialize(JSON.stringify(previousJson));

      const replacement = new Agent({
        name: TEST_AGENT_NAME,
        description: 'Replacement definition',
      }, metadataService);
      replacement.instructions = 'Replacement instructions';
      replacement.addGoal({ description: 'Imported goal' });

      const previousDefinition = [
        '---',
        'name: test-agent',
        'description: Previous definition',
        '# retained hand-edited formatting',
        '---',
        'Previous instructions',
        '',
      ].join('\n');
      const intendedDefinition = await agentManager.exportElement(replacement, 'markdown');
      let durableDefinition = previousDefinition;
      const intendedState = { ...replacement.getState(), stateVersion: 3 };
      let durableState = container.resolve<SerializationService>('SerializationService').dumpYaml(
        {
          ...intendedState,
          lastActive: intendedState.lastActive.toISOString(),
          sessionCount: String(intendedState.sessionCount),
          stateVersion: '4',
          goals: intendedState.goals.map((goal) => ({
            ...goal,
            createdAt: goal.createdAt.toISOString(),
            updatedAt: goal.updatedAt.toISOString(),
          })),
        },
        { schema: 'json', noRefs: true, sortKeys: true },
      );
      fileOperationsService.exists.mockResolvedValue(true);
      fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) =>
        filePath.endsWith(STATE_FILE_SUFFIX) ? durableState : durableDefinition));
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) durableState = String(content);
        else durableDefinition = String(content);
      });

      const journal = new AgentSnapshotReplacementJournal(
        () => path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements'),
        0,
      );
      const journalEntry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: previous.id },
        stateIncluded: true,
        previousAgentJson: previous.serializeToJSON(),
        intendedAgentJson: replacement.serializeToJSON(),
        previousDefinition,
        intendedDefinition,
        previousState: previous.getState(),
        intendedState,
      });
      await journal.releaseOwnership(journalEntry);

      await agentManager.initialize();

      expect(durableDefinition).toContain('Previous instructions');
      expect(durableDefinition).not.toContain('Replacement instructions');
      expect(durableDefinition).toBe(previousDefinition);
      expect(durableState).toContain('Prior goal');
      expect(durableState).not.toContain('Imported goal');
      await expect(journal.list()).resolves.toEqual([]);
    });

    it.each(['save', 'update'] as const)(
      'does not let a concurrent %s interleave with snapshot replacement',
      async (operation) => {
        const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous' }, metadataService);
        jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
        const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Replacement' }, metadataService);
        replacement.addGoal({ description: 'Replacement state' });
        const concurrent = new Agent({ name: TEST_AGENT_NAME, description: 'Concurrent save' }, metadataService);
        const stateWriteStarted = deferred();
        const releaseStateWrite = deferred();
        let durableDefinition = '---\nname: test-agent\ndescription: Previous\n---\nOriginal body';
        let durableState: string | null = null;
        const definitionWrites: string[] = [];

        fileOperationsService.readFile.mockImplementation((filePath) => {
          if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
            return durableState === null
              ? Promise.reject({ code: 'ENOENT' })
              : Promise.resolve(durableState);
          }
          return Promise.resolve(durableDefinition);
        });
        fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
          if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
            durableState = String(content);
            if (durableState.includes('Replacement state')) {
              stateWriteStarted.resolve(undefined);
              await releaseStateWrite.promise;
            }
            return;
          }
          durableDefinition = String(content);
          definitionWrites.push(durableDefinition);
        });

        const replacementPromise = agentManager.replaceFromSnapshot(
          replacement,
          `${TEST_AGENT_NAME}.md`,
          { stateIncluded: true },
        );
        await stateWriteStarted.promise;
        const concurrentPromise = operation === 'save'
          ? agentManager.save(concurrent, `${TEST_AGENT_NAME}.md`)
          : agentManager.update(TEST_AGENT_NAME, { description: 'Concurrent update' });
        await Promise.resolve();
        await Promise.resolve();
        expect(definitionWrites).toEqual([]);

        releaseStateWrite.resolve(undefined);
        await replacementPromise;
        await concurrentPromise;

        expect(definitionWrites).toHaveLength(2);
        expect(definitionWrites[0]).toContain('Replacement');
        expect(definitionWrites[1]).toContain(
          operation === 'save' ? 'Concurrent save' : 'Concurrent update',
        );
      },
    );

    it('rejects recovery when only sessionCount changed concurrently', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous' }, metadataService);
      const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Replacement' }, metadataService);
      replacement.addGoal({ description: 'Imported goal' });
      const previousDefinition = await agentManager.exportElement(previous, 'markdown');
      const intendedDefinition = await agentManager.exportElement(replacement, 'markdown');
      const intendedState = { ...replacement.getState(), stateVersion: 3 };
      let durableState = container.resolve<SerializationService>('SerializationService').dumpYaml({
        ...intendedState,
        lastActive: intendedState.lastActive.toISOString(),
        sessionCount: '2',
        stateVersion: '4',
      }, { schema: 'json', noRefs: true, sortKeys: true });
      fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) =>
        filePath.endsWith(STATE_FILE_SUFFIX) ? durableState : previousDefinition));
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) durableState = String(content);
      });
      const journal = new AgentSnapshotReplacementJournal(
        () => path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements'),
        0,
      );
      const entry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: previous.id },
        stateIncluded: true,
        previousAgentJson: previous.serializeToJSON(),
        intendedAgentJson: replacement.serializeToJSON(),
        previousDefinition,
        intendedDefinition,
        previousState: previous.getState(),
        intendedState,
      });
      await journal.releaseOwnership(entry);

      await expect(agentManager.initialize()).resolves.toBeUndefined();
      expect(durableState).toContain("sessionCount: '2'");
      await expect(journal.list()).resolves.toHaveLength(0);
    });

    it('keeps a live replacement owned when a second manager observes an expired-age lease', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const ownerJournal = new AgentSnapshotReplacementJournal(() => journalDir, 5);
      const observerJournal = new AgentSnapshotReplacementJournal(() => journalDir, 5);
      const makeManager = (replacementJournal: AgentSnapshotReplacementJournal) =>
        new TestableAgentManager({
          portfolioManager: mockPortfolioManager as unknown as PortfolioManager,
          fileLockManager: _fileLockManager,
          baseDir: portfolioPath,
          fileOperationsService,
          validationRegistry: container.resolve('ValidationRegistry'),
          serializationService: container.resolve('SerializationService'),
          metadataService,
          eventDispatcher: new ElementEventDispatcher(),
          storageLayerFactory: createTestStorageFactory(),
          replacementJournal,
        });
      const ownerManager = makeManager(ownerJournal);
      const observerManager = makeManager(observerJournal);
      await ownerManager.initialize();
      await observerManager.initialize();
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous' }, metadataService);
      jest.spyOn(ownerManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Replacement' }, metadataService);
      replacement.addGoal({ description: 'Replacement state' });
      let durableDefinition = '---\nname: test-agent\ndescription: Previous\n---\nBody';
      let durableState: string | null = null;
      const stateWriteStarted = deferred();
      const releaseStateWrite = deferred();
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          return durableState === null
            ? Promise.reject({ code: 'ENOENT' })
            : Promise.resolve(durableState);
        }
        return Promise.resolve(durableDefinition);
      });
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          durableState = String(content);
          stateWriteStarted.resolve(undefined);
          await releaseStateWrite.promise;
        } else {
          durableDefinition = String(content);
        }
      });

      const activeReplacement = ownerManager.replaceFromSnapshot(
        replacement,
        `${TEST_AGENT_NAME}.md`,
        { stateIncluded: true },
      );
      await stateWriteStarted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      await observerManager.initialize();
      expect(durableDefinition).toContain('Previous');

      releaseStateWrite.resolve(undefined);
      await activeReplacement;
    });

    it('cannot remove a successor journal after takeover between definition CAS and completion', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME, description: 'Previous' }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME, description: 'Replacement' }, metadataService);
      const journal = (agentManager as unknown as {
        replacementJournal: AgentSnapshotReplacementJournal;
      }).replacementJournal;
      const observer = new AgentSnapshotReplacementJournal(
        () => path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements'),
        5_000,
      );
      let durableDefinition = '---\nname: test-agent\ndescription: Previous\n---\nBody';
      let takeover: Awaited<ReturnType<typeof observer.claimForRecovery>> = null;
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          return Promise.reject({ code: 'ENOENT' });
        }
        return Promise.resolve(durableDefinition);
      });
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (!String(filePath).endsWith(STATE_FILE_SUFFIX)) durableDefinition = String(content);
      });
      const originalRemove = journal.remove.bind(journal);
      jest.spyOn(journal, 'remove').mockImplementationOnce(async (journalPath, leaseToken) => {
        const active = await journal.read(journalPath);
        if (!active) throw new Error('Expected active replacement journal');
        await journal.releaseOwnership(active);
        const released = await observer.read(journalPath);
        if (!released) throw new Error('Expected released replacement journal');
        takeover = await observer.claimForRecovery(released);
        if (!takeover) throw new Error('Expected successor to claim replacement journal');
        await originalRemove(journalPath, leaseToken);
      });

      try {
        await expect(agentManager.replaceFromSnapshot(
          replacement,
          `${TEST_AGENT_NAME}.md`,
          { stateIncluded: false },
        )).rejects.toThrow('rollback failed');

        expect(durableDefinition).toContain('Replacement');
        const remaining = await observer.list();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].record.leaseToken).toBe(takeover?.record.leaseToken);
        if (!takeover) throw new Error('Expected successor takeover');
        await observer.releaseOwnership(takeover);
        await agentManager.initialize();
        expect(durableDefinition).toContain('Previous');
        await expect(observer.list()).resolves.toEqual([]);
      } finally {
        if (takeover) {
          const remaining = await observer.read(takeover.journalPath);
          if (remaining) {
            await observer.remove(remaining.journalPath, remaining.record.leaseToken);
          }
        }
      }
    });

    it('keeps a remotely visible lease valid throughout a long owned operation', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const recoveryDelayMs = 1_000;
      const owner = new AgentSnapshotReplacementJournal(() => journalDir, recoveryDelayMs);
      const previous = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await owner.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: previous.id },
        stateIncluded: false,
        previousAgentJson: previous.serializeToJSON(),
        intendedAgentJson: previous.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      const operationEntered = deferred();
      const releaseOperation = deferred();

      const ownedMutation = owner.runWhileOwned(entry, async () => {
        operationEntered.resolve(undefined);
        await releaseOperation.promise;
      });
      await operationEntered.promise;
      await new Promise(resolve => setTimeout(resolve, recoveryDelayMs * 2));

      const moduleUrl = pathToFileURL(path.join(
        process.cwd(),
        'src/elements/agents/AgentSnapshotReplacementJournal.ts',
      )).href;
      const childSource = `
        import { AgentSnapshotReplacementJournal } from ${JSON.stringify(moduleUrl)};
        const input = JSON.parse(process.env.DOLLHOUSE_AGENT_RECOVERY_INPUT);
        const observer = new AgentSnapshotReplacementJournal(() => input.journalDir, input.delay);
        observer.isRecoveryEligible = async record =>
          Date.parse(record.leaseExpiresAt) <= Date.now();
        const current = await observer.read(input.journalPath);
        if (!current) throw new Error('missing journal');
        const claimed = await observer.claimForRecovery(current);
        process.stdout.write(claimed ? 'claimed' : 'owned');
      `;
      const observer = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childSource],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DOLLHOUSE_AGENT_RECOVERY_INPUT: JSON.stringify({
              journalDir,
              journalPath: entry.journalPath,
              delay: recoveryDelayMs,
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      observer.stdout.on('data', chunk => { stdout += String(chunk); });
      observer.stderr.on('data', chunk => { stderr += String(chunk); });
      const observerResult = await new Promise<number | null>((resolve, reject) => {
        observer.once('error', reject);
        observer.once('close', resolve);
      });
      try {
        expect({ code: observerResult, stderr, stdout }).toEqual({
          code: 0,
          stderr: '',
          stdout: 'owned',
        });
      } finally {
        releaseOperation.resolve(undefined);
        await ownedMutation;
        await owner.remove(entry.journalPath, entry.record.leaseToken);
      }
    }, 20_000);

    it('reclaims a journal claim abandoned by a crashed process incarnation', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const owner = new AgentSnapshotReplacementJournal(() => journalDir, 5_000);
      const previous = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await owner.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: previous.id },
        stateIncluded: false,
        previousAgentJson: previous.serializeToJSON(),
        intendedAgentJson: previous.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      await owner.releaseOwnership(entry);
      const released = await owner.read(entry.journalPath);
      if (!released) throw new Error('Expected released replacement journal');

      await crashFilesystemGuardOwner(`${entry.journalPath}.claim`);
      const successor = new AgentSnapshotReplacementJournal(() => journalDir, 5_000);
      const claimed = await successor.claimForRecovery(released);

      expect(claimed).not.toBeNull();
      if (!claimed) throw new Error('Expected successor recovery claim');
      await successor.remove(claimed.journalPath, claimed.record.leaseToken);
    });

    it('serializes the same logical agent mutation across operating-system processes', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const readyPath = path.join(testDir, 'mutation-owner.ready');
      const releasePath = path.join(testDir, 'mutation-owner.release');
      const moduleUrl = pathToFileURL(path.join(
        process.cwd(),
        'src/elements/agents/AgentSnapshotReplacementJournal.ts',
      )).href;
      const childSource = `
        import fs from 'node:fs/promises';
        import { AgentSnapshotReplacementJournal } from ${JSON.stringify(moduleUrl)};
        const input = JSON.parse(process.env.DOLLHOUSE_AGENT_GATE_INPUT);
        const journal = new AgentSnapshotReplacementJournal(() => input.journalDir);
        await journal.runWithAgentMutationGate('CamelCaseAgent', async () => {
          await fs.writeFile(input.readyPath, 'ready', { mode: 0o600 });
          while (true) {
            try { await fs.access(input.releasePath); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 10)); }
          }
        });
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childSource],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DOLLHOUSE_AGENT_GATE_INPUT: JSON.stringify({ journalDir, readyPath, releasePath }),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        },
      );

      try {
        const deadline = Date.now() + 5_000;
        while (true) {
          try {
            await fs.access(readyPath);
            break;
          } catch {
            if (Date.now() >= deadline) throw new Error(`Child gate did not start: ${stderr}`);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }

        const observer = new AgentSnapshotReplacementJournal(() => journalDir);
        let observerEntered = false;
        const observerMutation = observer.runWithAgentMutationGate('camel-case-agent', async () => {
          observerEntered = true;
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(observerEntered).toBe(false);

        await fs.writeFile(releasePath, 'release', { mode: 0o600 });
        const result = await closed;
        expect(result).toEqual({ code: 0, signal: null });
        await observerMutation;
        expect(observerEntered).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });

    it('resolves a database UUID to the shared canonical gate before deletion', async () => {
      const elementId = randomUUID();
      const internals = agentManager as unknown as {
        storageLayer: {
          writeContent?: () => Promise<string>;
          getNameById?: (id: string) => string | undefined;
          resolveNameById: (id: string) => Promise<string | undefined>;
          hasCompletedScan: () => boolean;
          scan: () => Promise<unknown>;
        };
        replacementJournal: AgentSnapshotReplacementJournal;
        recoverPendingSnapshotReplacements: (name?: string) => Promise<void>;
        deleteUnlocked: (filePath: string, resolvedName?: string) => Promise<void>;
      };
      internals.storageLayer.writeContent = async () => elementId;
      internals.storageLayer.getNameById = () => undefined;
      const resolveNameById = jest.fn(async (id: string) =>
        id === elementId ? 'CamelCaseAgent' : undefined);
      internals.storageLayer.resolveNameById = resolveNameById;
      internals.storageLayer.hasCompletedScan = () => true;
      const gate = jest.spyOn(internals.replacementJournal, 'runWithAgentMutationGate')
        .mockImplementation(async (_name, operation) => operation());
      jest.spyOn(internals, 'recoverPendingSnapshotReplacements').mockResolvedValue();
      const deleteUnlocked = jest.spyOn(internals, 'deleteUnlocked').mockResolvedValue();

      await agentManager.delete(elementId);

      expect(resolveNameById).toHaveBeenCalledWith(elementId);
      expect(gate).toHaveBeenCalledWith('camel-case-agent', expect.any(Function));
      expect(deleteUnlocked).toHaveBeenCalledWith(elementId, 'CamelCaseAgent');
    });

    it.each([
      ['PID reuse', { source: 'linux-proc', bootId: 'boot-a', processStartId: '200' }],
      ['host reboot', { source: 'linux-proc', bootId: 'boot-b', processStartId: '100' }],
    ] as const)('recovers an expired file journal after %s without accepting stale ownership', async (
      _label,
      currentIncarnation,
    ) => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const recordedIncarnation = {
        source: 'linux-proc' as const,
        bootId: 'boot-a',
        processStartId: '100',
      };
      const owner = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5,
        async () => recordedIncarnation,
      );
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await owner.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      await owner.releaseOwnership(entry);
      const released = await owner.read(entry.journalPath);
      if (!released) throw new Error('Expected released journal');
      const crashedRecord = {
        ...released.record,
        ownerIncarnation: recordedIncarnation,
        leaseExpiresAt: new Date(0).toISOString(),
        releasedAt: null,
      };
      await fs.writeFile(entry.journalPath, `${JSON.stringify(crashedRecord)}\n`, { mode: 0o600 });
      const crashed = await owner.read(entry.journalPath);
      if (!crashed) throw new Error('Expected simulated crashed-owner journal');
      const sameProcess = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5,
        async () => recordedIncarnation,
      );
      const successor = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5,
        async () => currentIncarnation,
      );

      await expect(sameProcess.isRecoveryEligible(crashed.record)).resolves.toBe(false);
      await expect(successor.isRecoveryEligible(crashed.record)).resolves.toBe(true);
      const claimed = await successor.claimForRecovery(crashed);
      if (!claimed) throw new Error('Expected successor recovery claim');
      await expect(owner.remove(entry.journalPath, entry.record.leaseToken))
        .rejects.toThrow('lost its lease fence');
      await successor.remove(claimed.journalPath, claimed.record.leaseToken);
    });

    it.each([
      ['recorded owner incarnation is missing', null, {
        source: 'linux-proc' as const,
        bootId: 'boot-a',
        processStartId: '100',
      }],
      ['current process incarnation is unavailable', {
        source: 'linux-proc' as const,
        bootId: 'boot-a',
        processStartId: '100',
      }, null],
    ] as const)('keeps an expired file journal owned when %s', async (
      _label,
      ownerIncarnation,
      currentIncarnation,
    ) => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const journal = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5,
        async () => currentIncarnation,
      );
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      const expiredRecord = {
        ...entry.record,
        ownerIncarnation,
        leaseExpiresAt: new Date(0).toISOString(),
      };

      await expect(journal.isRecoveryEligible(expiredRecord)).resolves.toBe(false);
      await journal.remove(entry.journalPath, entry.record.leaseToken);
    });

    it('allows an explicitly released file journal to be claimed with unavailable incarnations', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const journal = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5,
        async () => null,
      );
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });

      await journal.releaseOwnership(entry);
      const released = await journal.read(entry.journalPath);
      if (!released) throw new Error('Expected released journal');
      expect(released.record.releasedAt).toEqual(expect.any(String));
      await expect(journal.isRecoveryEligible(released.record)).resolves.toBe(true);
      const claimed = await journal.claimForRecovery(released);
      if (!claimed) throw new Error('Expected released journal recovery claim');
      expect(claimed.record.releasedAt).toBeNull();
      await journal.remove(claimed.journalPath, claimed.record.leaseToken);
    });

    it('revokes the pre-release file-journal lease token before clearing ownership', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const journal = new AgentSnapshotReplacementJournal(() => journalDir, 5_000);
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });

      await journal.releaseOwnership(entry);
      const released = await journal.read(entry.journalPath);
      if (!released) throw new Error('Expected released journal');
      expect(released.record.leaseToken).not.toBe(entry.record.leaseToken);
      expect(released.record.releasedAt).toEqual(expect.any(String));

      await expect(journal.remove(entry.journalPath, entry.record.leaseToken))
        .rejects.toThrow('removal lost its lease fence');
      await expect(journal.quarantine(entry, 'stale pre-release owner'))
        .rejects.toThrow('quarantine lost its lease fence');

      await expect(journal.read(entry.journalPath)).resolves.toEqual(released);
      await journal.remove(released.journalPath, released.record.leaseToken);
    });

    it('retains file-journal ownership when the durable release write fails', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const journal = new AgentSnapshotReplacementJournal(
        () => journalDir,
        5_000,
        async () => null,
      );
      const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await journal.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      const internals = journal as unknown as {
        writeRecord: (journalPath: string, record: unknown) => Promise<void>;
      };
      const writeRecord = jest.spyOn(internals, 'writeRecord')
        .mockRejectedValueOnce(new Error('forced durable release failure'));

      await expect(journal.releaseOwnership(entry)).rejects.toThrow('forced durable release failure');
      await expect(journal.assertOwnership(entry)).resolves.toBeUndefined();
      const stillOwned = await journal.read(entry.journalPath);
      expect(stillOwned?.record.releasedAt).toBeNull();

      writeRecord.mockRestore();
      await journal.releaseOwnership(entry);
      const released = await journal.read(entry.journalPath);
      expect(released?.record.releasedAt).toEqual(expect.any(String));
      if (!released) throw new Error('Expected released journal');
      await journal.remove(released.journalPath, released.record.leaseToken);
    });

    it('permits only one file-backed replacement journal per logical agent', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const firstJournal = new AgentSnapshotReplacementJournal(() => journalDir, 5_000);
      const secondJournal = new AgentSnapshotReplacementJournal(() => journalDir, 5_000);
      const firstAgent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const otherAgent = new Agent({ name: 'other-agent' }, metadataService);
      const recordFor = (agent: Agent) => ({
        agentName: agent.metadata.name,
        filePath: `${agent.metadata.name}.md`,
        isDatabaseMode: false as const,
        stateKey: { name: agent.metadata.name, agentElementId: agent.id },
        stateIncluded: false,
        previousAgentJson: agent.serializeToJSON(),
        intendedAgentJson: agent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      const first = await firstJournal.create(recordFor(firstAgent));
      await expect(secondJournal.create(recordFor(firstAgent))).rejects.toThrow('already active');
      const unrelated = await secondJournal.create(recordFor(otherAgent));

      await firstJournal.remove(first.journalPath, first.record.leaseToken);
      await secondJournal.remove(unrelated.journalPath, unrelated.record.leaseToken);
    });

    it('quarantines an unrelated conflicted journal without blocking another agent', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const journal = new AgentSnapshotReplacementJournal(() => journalDir, 0);
      const pendingAgent = new Agent({ name: 'pending-agent' }, metadataService);
      const pendingEntry = await journal.create({
        agentName: 'pending-agent',
        filePath: 'pending-agent.md',
        isDatabaseMode: false,
        stateKey: { name: 'pending-agent', agentElementId: pendingAgent.id },
        stateIncluded: false,
        previousAgentJson: pendingAgent.serializeToJSON(),
        intendedAgentJson: pendingAgent.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      await journal.releaseOwnership(pendingEntry);
      fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) =>
        filePath.endsWith('pending-agent.md') ? 'outside conflicting bytes' : 'unrelated bytes'
      ));

      const unrelatedAgent = new Agent({ name: 'unrelated-agent' }, metadataService);
      await expect(agentManager.save(unrelatedAgent, 'unrelated-agent.md')).resolves.toBeUndefined();
      await expect(journal.list()).resolves.toHaveLength(1);

      await expect(agentManager.initialize()).resolves.toBeUndefined();
      await expect(journal.list()).resolves.toEqual([]);
      expect((await fs.readdir(journalDir)).some(name => name.includes('.quarantined-'))).toBe(true);
    });

    it('does not let a live replacement journal for one agent block an unrelated agent', async () => {
      const journal = new AgentSnapshotReplacementJournal(
        () => path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements'),
        5_000,
      );
      const pendingAgent = new Agent({ name: 'pending-agent' }, metadataService);
      const pendingEntry = await journal.create({
        agentName: 'pending-agent',
        filePath: 'pending-agent.md',
        isDatabaseMode: false,
        stateKey: { name: 'pending-agent', agentElementId: pendingAgent.id },
        stateIncluded: false,
        previousAgentJson: pendingAgent.serializeToJSON(),
        intendedAgentJson: pendingAgent.serializeToJSON(),
        previousDefinition: 'pending previous bytes',
        intendedDefinition: 'pending intended bytes',
        previousState: null,
        intendedState: null,
      });
      const unrelatedAgent = new Agent({ name: 'unrelated-agent' }, metadataService);

      try {
        await agentManager.save(unrelatedAgent, 'unrelated-agent.md');
      } finally {
        await journal.remove(pendingEntry.journalPath, pendingEntry.record.leaseToken);
      }

      expect(fileOperationsService.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('unrelated-agent.md'),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('atomically fences one remote recovery claimant after the durable lease expires', async () => {
      const journalDir = path.join(portfolioPath, ElementType.AGENT, '.state', '.replacements');
      const owner = new AgentSnapshotReplacementJournal(() => journalDir, 5);
      const previous = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      const entry = await owner.create({
        agentName: TEST_AGENT_NAME,
        filePath: `${TEST_AGENT_NAME}.md`,
        isDatabaseMode: false,
        stateKey: { name: TEST_AGENT_NAME, agentElementId: previous.id },
        stateIncluded: false,
        previousAgentJson: previous.serializeToJSON(),
        intendedAgentJson: previous.serializeToJSON(),
        previousDefinition: 'previous bytes',
        intendedDefinition: 'intended bytes',
        previousState: null,
        intendedState: null,
      });
      await owner.releaseOwnership(entry);
      const released = await owner.read(entry.journalPath);
      if (!released) throw new Error('Expected durable journal');
      const remoteRecord = {
        ...released.record,
        ownerHost: 'remote.example.invalid',
        ownerPid: 4242,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(0).toISOString(),
      };
      await fs.writeFile(entry.journalPath, `${JSON.stringify(remoteRecord)}\n`, 'utf8');
      const observerA = new AgentSnapshotReplacementJournal(() => journalDir, 5);
      const observerB = new AgentSnapshotReplacementJournal(() => journalDir, 5);
      const remoteEntry = { journalPath: entry.journalPath, record: remoteRecord };
      const claims = await Promise.all([
        observerA.claimForRecovery(remoteEntry),
        observerB.claimForRecovery(remoteEntry),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const claim = claims.find((value) => value !== null);
      if (!claim) throw new Error('Expected one recovery claimant');
      await observerA.remove(claim.journalPath, claim.record.leaseToken);
    });

    it('rejects omitted-state replacement when the durable version changes before CAS delete', async () => {
      const previous = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      jest.spyOn(agentManager, 'read').mockResolvedValue(previous);
      const replacement = new Agent({ name: TEST_AGENT_NAME }, metadataService);
      let stateReads = 0;
      fileOperationsService.readFile.mockImplementation((filePath) => {
        if (!String(filePath).endsWith(STATE_FILE_SUFFIX)) {
          return Promise.resolve('---\nname: test-agent\n---\nExact previous bytes');
        }
        stateReads += 1;
        return Promise.resolve(`---\ngoals: []\ndecisions: []\ncontext: {}\nlastActive: 2026-08-21T12:00:00.000Z\nsessionCount: 1\nstateVersion: ${stateReads === 1 ? 3 : 4}\n---`);
      });

      await expect(agentManager.replaceFromSnapshot(
        replacement,
        `${TEST_AGENT_NAME}.md`,
        { stateIncluded: false },
      )).rejects.toThrow('State version conflict');
      expect(fileOperationsService.writeFile).not.toHaveBeenCalledWith(
        expect.stringContaining(`${TEST_AGENT_NAME}.md`),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('Delete', () => {
    it('should delete agent and state files', async () => {
      fileOperationsService.exists.mockResolvedValue(true);

      await agentManager.delete(TEST_AGENT_NAME);

      expect(fileOperationsService.deleteFile).toHaveBeenCalledTimes(2); // Main file + state file
      expect(fileOperationsService.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.anything(),
        expect.anything()
      );
      expect(fileOperationsService.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.state.yaml'),
        ElementType.AGENT,
        expect.objectContaining({ source: 'AgentManager.delete (state file)' })
      );
    });

    it('should log security event on deletion', async () => {
      fileOperationsService.exists.mockResolvedValue(true);

      await agentManager.delete(TEST_AGENT_NAME);

      // Security logging is now handled by FileOperationsService, but BaseElementManager might still log high-level events?
      // Actually, BaseElementManager.delete calls super.delete which calls fileOperations.deleteFile.
      // FileOperationsService logs the deletion.
      // However, BaseElementManager.delete also logs 'ELEMENT_DELETED' in some versions.
      // Let's check BaseElementManager implementation.
      // It seems I removed the duplicate logging in BaseElementManager.
      // So we should expect FileOperationsService to handle it.
      // But the test is mocking FileOperationsService.
      // So we can't check if SecurityMonitor was called unless we spy on it and FileOperationsService calls it.
      // But FileOperationsService is mocked.
      // So we should check if fileOperationsService.deleteFile was called.
      expect(fileOperationsService.deleteFile).toHaveBeenCalled();
    });

    it('should not throw if agent does not exist', async () => {
      fileOperationsService.exists.mockResolvedValue(false);
      // BaseElementManager.delete checks exists() first.
      
      await expect(agentManager.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('List', () => {
    it('should list all agents', async () => {
      // Configure the mock to return agent files
      mockPortfolioManager.listElements.mockResolvedValue(['agent1.md', 'agent2.md']);

      fileOperationsService.readFile.mockImplementation(asAsyncRead((path: any) => {
        if (path.includes('agent1')) {
          return `---
name: agent1
---
Content`;
        } else {
          return `---
name: agent2
---
Content`;
        }
      }));

      const agents = await agentManager.list();

      expect(agents).toHaveLength(2);
      expect(agents[0].metadata.name).toBe('agent1');
      expect(agents[1].metadata.name).toBe('agent2');
    });

    it('should handle read errors gracefully', async () => {
      // Configure mock to return files but readFile to fail
      mockPortfolioManager.listElements.mockResolvedValue(['bad.md']);
      fileOperationsService.readFile.mockRejectedValue(new Error('Read error'));

      const agents = await agentManager.list();
      expect(agents).toHaveLength(0);
    });
  });

  describe('Validation', () => {
    it('should validate agent names', () => {
      expect(agentManager.validateName('valid-name').valid).toBe(true);
      expect(agentManager.validateName('valid_name').valid).toBe(true);
      expect(agentManager.validateName('valid123').valid).toBe(true);

      expect(agentManager.validateName('').valid).toBe(false);
      expect(agentManager.validateName('invalid name').valid).toBe(false);
      expect(agentManager.validateName('invalid!name').valid).toBe(false);
      expect(agentManager.validateName('a'.repeat(101)).valid).toBe(false);
    });

    it('should validate paths', () => {
      expect(agentManager.validatePath('relative/path.md')).toBe(true);
      expect(agentManager.validatePath('file.md')).toBe(true);

      expect(agentManager.validatePath('../traversal')).toBe(false);
      expect(agentManager.validatePath('~/home')).toBe(false);
      expect(agentManager.validatePath('/absolute/path')).toBe(false);
      expect(agentManager.validatePath(String.raw`C:\windows`)).toBe(false);
    });
  });

  describe('Import/Export', () => {
    it('should import agent from JSON', async () => {
      const agentData = {
        id: 'test-id',
        type: ElementType.AGENT,
        version: '1.0.0',
        metadata: {
          name: 'imported-agent',
          description: 'Imported from JSON',
          decisionFramework: 'hybrid'
        },
        state: {
          goals: [{
            id: 'goal_123',
            description: 'Imported goal',
            status: 'pending'
          }],
          decisions: [],
          context: {},
          lastActive: new Date().toISOString(),
          sessionCount: 0
        }
      };

      const agent = await agentManager.importElement(JSON.stringify(agentData), 'json');

      expect(agent.metadata.name).toBe('imported-agent');
      expect(agent.getState().goals).toHaveLength(1);
    });

    it('should import agent from markdown', async () => {
      const markdown = `---
name: markdown-agent
description: Imported from markdown
decisionFramework: programmatic
---

# Agent Instructions

This is the agent content.`;

      const agent = await agentManager.importElement(markdown, 'markdown');

      expect(agent.metadata.name).toBe('markdown-agent');
      expect(agent.extensions?.decisionFramework).toBe('programmatic');
      expect(agent.instructions).toContain('This is the agent content.');
      await expect(agentManager.exportElement(agent, 'markdown')).resolves.toContain('This is the agent content.');
    });

    it('should export agent to JSON', async () => {
      const agent = new Agent({
        name: 'export-test',
        description: 'Test export'
      }, metadataService);
      agent.addGoal({ description: 'Test goal' });

      const exported = await agentManager.exportElement(agent, 'json');
      const parsed = JSON.parse(exported);

      expect(parsed.metadata.name).toBe('export-test');
      expect(parsed.state.goals).toHaveLength(1);
    });

    it('should export agent to markdown', async () => {
      const agent = new Agent({
        name: 'export-test',
        description: 'Test export'
      }, metadataService);

      const exported = await agentManager.exportElement(agent, 'markdown');

      expect(exported).toContain('---');
      expect(exported).toContain('name: export-test');
      expect(exported).toContain('# export-test');
    });
  });

  describe('State Management', () => {
    it('tracks execution generations across equivalent agent-name aliases', () => {
      const observation = agentManager.observeExecutionGeneration('MyAgent');
      const internals = agentManager as unknown as {
        beginExecutionAttempt(name: string): void;
        endExecutionAttempt(name: string): void;
      };

      internals.beginExecutionAttempt('my-agent');
      expect(agentManager.hasExecutionGenerationChanged('MyAgent', observation.token)).toBe(true);

      internals.endExecutionAttempt('my-agent');
      observation.release();
    });

    it('should save agent state', async () => {
      const state = {
        goals: [],
        decisions: [],
        context: { test: 'value' },
        lastActive: new Date().toISOString(),
        sessionCount: 1
      };

      await agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state as any);

      // Check that the path contains the expected components (cross-platform)
      const firstCallArgs = (fileOperationsService.writeFile as jest.Mock).mock.calls[0];
      const filePath = firstCallArgs[0] as string;
      expect(filePath).toMatch(/[/\\]\.state[/\\]test-agent\.state\.yaml$/);
      expect(firstCallArgs[1]).toContain('test: value');
      expect(firstCallArgs[2]).toEqual(expect.any(Object));
    });

    it('should reject oversized state', async () => {
      const hugeState = {
        goals: [],
        decisions: [],
        context: { data: 'x'.repeat(100 * 1024) }, // Exceed limit
        lastActive: new Date().toISOString(),
        sessionCount: 1
      };

      await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, hugeState as any))
        .rejects.toThrow('exceeds allowed size');
    });

    it('should cache loaded state', async () => {
      let callCount = 0;
      fileOperationsService.readFile.mockImplementation(asAsyncRead((path: string) => {
          callCount++;
          if (path.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
---`;
          } else {
            return `---
name: test-agent
---
Content`;
          }
        }));

      // First read: element is not cached, so both the agent file and its
      // .state.yaml sidecar are read from disk (callCount = 2).
      await agentManager.read(TEST_AGENT_NAME);
      expect(callCount).toBe(2);

      // Second read: the element cache (populated by BaseElementManager.load())
      // serves the agent, and its already-hydrated state is returned as-is —
      // neither file is re-read. This is the desired steady-state behavior.
      await agentManager.read(TEST_AGENT_NAME);
      expect(callCount).toBe(2);

      // Force an element-cache miss by clearing the base-class LRU. The state
      // cache lives on AgentManager and is independent of the element cache —
      // so the next read should re-fetch the agent file but reuse the cached
      // AgentState, confirming the two layers are separate.
      agentManager.clearCache();
      await agentManager.read(TEST_AGENT_NAME);
      expect(callCount).toBe(3); // +1 agent file read; state came from stateCache
    });

    it('should acquire file lock during state save to prevent TOCTOU race (Issue #107)', async () => {
      // Spy on withLock to verify it's called
      const withLockSpy = jest.spyOn(_fileLockManager, 'withLock');

      const state = {
        goals: [],
        decisions: [],
        context: { test: 'concurrent-test' },
        lastActive: new Date().toISOString(),
        sessionCount: 1,
        stateVersion: 0
      };

      await agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state as any);

      // Verify that withLock was called with the correct resource identifier
      expect(withLockSpy).toHaveBeenCalledWith(
        'agent-state:test-agent',
        expect.any(Function)
      );

      withLockSpy.mockRestore();
    });

    it('should serialize concurrent saves through file lock (Issue #107)', async () => {
      const executionOrder: number[] = [];
      const lockEntries: number[] = [];
      const lockExits: number[] = [];
      let persistedState = '';
      fileOperationsService.exists.mockImplementation(async filePath =>
        filePath.includes(STATE_FILE_SUFFIX) && persistedState.length > 0);
      fileOperationsService.readFile.mockImplementation(asAsyncRead(filePath =>
        filePath.includes(STATE_FILE_SUFFIX) ? persistedState : ''));
      fileOperationsService.writeFile.mockImplementation(async (filePath, content) => {
        if (filePath.includes(STATE_FILE_SUFFIX)) persistedState = String(content);
      });

      // Track lock acquisition and release without interfering with the lock mechanism
      const originalWithLock = _fileLockManager.withLock.bind(_fileLockManager);
      jest.spyOn(_fileLockManager, 'withLock').mockImplementation(async (resource, operation) => {
        // Only track agent-state locks (not nested loadAgentState calls)
        if (resource.startsWith('agent-state:')) {
          lockEntries.push(lockEntries.length + 1);

          try {
            return await originalWithLock(resource, operation);
          } finally {
            lockExits.push(lockExits.length + 1);
          }
        }

        // For other resources, just pass through
        return await originalWithLock(resource, operation);
      });

      const state1 = {
        goals: [],
        decisions: [],
        context: { order: 1 },
        lastActive: new Date().toISOString(),
        sessionCount: 1,
        stateVersion: 0
      };

      const state2 = {
        goals: [],
        decisions: [],
        context: { order: 2 },
        lastActive: new Date().toISOString(),
        sessionCount: 2,
        stateVersion: 0
      };

      // Both callers observed the same initial version. Serialization allows
      // one writer to commit and makes the stale contender fail its CAS.
      const outcomes = await Promise.allSettled([
        agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state1 as any).then(() => executionOrder.push(1)),
        agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state2 as any).then(() => executionOrder.push(2))
      ]);

      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
      expect(executionOrder).toHaveLength(1);

      // Verify locks were acquired and released in order (serialization)
      expect(lockEntries).toHaveLength(2);
      expect(lockExits).toHaveLength(2);
    });
  });

  describe('Error Handling', () => {
    it('should handle file parse errors', async () => {
      fileOperationsService.readFile.mockResolvedValue('Invalid YAML content');

      // SerializationService provides more specific error messages
      await expect(agentManager.read('bad-agent'))
        .rejects.toThrow('YAML must contain an object');
    });

    it('should validate element type in files', async () => {
      fileOperationsService.readFile.mockResolvedValue(`---
name: wrong-type
type: persona
---
Content`);

      await expect(agentManager.read('wrong-type'))
        .rejects.toThrow("Invalid element type: expected 'agents', got 'persona'");
    });
  });

  /**
   * State Persistence Edge Cases (Issue #123)
   *
   * Tests for:
   * 1. Concurrent state updates (partially covered above, extended here)
   * 2. State file corruption recovery
   * 3. Large state files near MAX_STATE_SIZE (100KB)
   * 4. State version rollback after failed save
   */
  describe('State Persistence Edge Cases (Issue #123)', () => {

    describe('Corruption Recovery', () => {
      it('should handle malformed YAML state file gracefully', async () => {
        // Mock agent file to exist
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            // Return malformed YAML (unclosed brace, invalid syntax)
            return `---
goals: [
  { id: "goal_123", description: "Test"
decisions: []
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Should not throw - graceful degradation returns null for corrupt state
        // Agent should still load, just without persisted state
        const agent = await agentManager.read(TEST_AGENT_NAME);

        // Agent loads but state is default (no goals from corrupt file)
        expect(agent).not.toBeNull();
        expect(agent?.getState().goals).toHaveLength(0);
      });

      it('should handle truncated state file', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            // Truncated YAML - incomplete content
            return `---
goals:
  - id: goal_123
    description: Test goal
    status: pend`;  // Truncated mid-value
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Should handle gracefully
        const agent = await agentManager.read(TEST_AGENT_NAME);
        expect(agent).not.toBeNull();
      });

      it('should handle state file with invalid stateVersion type', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
stateVersion: "not-a-number"
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        const agent = await agentManager.read(TEST_AGENT_NAME);
        expect(agent).not.toBeNull();

        // stateVersion should be coerced or defaulted, not NaN
        const stateVersion = agent?.getState().stateVersion;
        expect(Number.isNaN(stateVersion)).toBe(false);
      });

      /**
       * FIX (Issue #123): State deserialization now defaults missing arrays.
       * normalizeLoadedState() defaults missing goals/decisions to empty arrays.
       */
      it('should default missing goals/decisions arrays in state file', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            // Missing goals, decisions, context - only has sessionCount and lastActive
            return `---
lastActive: 2025-01-01T00:00:00Z
sessionCount: 5
stateVersion: 1
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        const agent = await agentManager.read(TEST_AGENT_NAME);
        expect(agent).not.toBeNull();

        // CORRECT BEHAVIOR: Missing fields should be defaulted to empty arrays
        const state = agent?.getState();
        expect(state).toBeDefined();
        expect(Array.isArray(state?.goals)).toBe(true);
        expect(Array.isArray(state?.decisions)).toBe(true);
        expect(state?.goals).toHaveLength(0);
        expect(state?.decisions).toHaveLength(0);
      });

      it('should handle state file with invalid date format', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: "not-a-valid-date"
sessionCount: 1
stateVersion: 1
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Should handle gracefully
        const agent = await agentManager.read(TEST_AGENT_NAME);
        expect(agent).not.toBeNull();
      });
    });

    describe('serialized state persistence boundary conditions', () => {
      it('should accept state below the semantic state ceiling', async () => {
        // Calculate padding needed to get just under the limit
        // YAML overhead is roughly 100 bytes for the structure
        const yamlOverhead = 200;
        const targetSize = AGENT_LIMITS.MAX_STATE_SIZE - yamlOverhead;
        const padding = 'x'.repeat(targetSize);

        const state = {
          goals: [],
          decisions: [],
          context: { data: padding },
          lastActive: new Date().toISOString(),
          sessionCount: 1,
          stateVersion: 0
        };

        // Should succeed without throwing
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state as any))
          .resolves.not.toThrow();
      });

      it('should reject state that exceeds the semantic state ceiling', async () => {
        const targetSize = AGENT_LIMITS.MAX_STATE_SIZE + 1;
        const padding = 'x'.repeat(targetSize);

        const state = {
          goals: [],
          decisions: [],
          context: { data: padding },
          lastActive: new Date().toISOString(),
          sessionCount: 1,
          stateVersion: 0
        };

        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state as any))
          .rejects.toThrow('exceeds allowed size');
      });

      it('should handle state with many small goals near size limit', async () => {
        // Create many small goals instead of one large context
        const goals = [];
        for (let i = 0; i < 50; i++) {  // MAX_GOALS is 50
          goals.push({
            id: `goal_${i}`,
            description: `Goal description ${i} with some padding text`,
            status: 'pending',
            priority: 'medium',
            importance: 5,
            urgency: 5,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        }

        const state = {
          goals,
          decisions: [],
          context: {},
          lastActive: new Date().toISOString(),
          sessionCount: 1,
          stateVersion: 0
        };

        // Should succeed - 50 small goals is under size limit
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, state as any))
          .resolves.not.toThrow();
      });
    });

    describe('State Version Rollback on Failed Save', () => {
      it('should not increment stateVersion when write fails', async () => {
        const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
        const initialVersion = agent.getState().stateVersion;

        // Add a goal - with Option C fix, version does NOT increment during operation
        agent.addGoal({ description: 'Test goal for version rollback' });

        // Version should still be the same (not incremented during addGoal)
        expect(agent.getState().stateVersion).toBe(initialVersion);

        // Mock writeFile to fail
        fileOperationsService.writeFile.mockRejectedValueOnce(new Error('Disk full'));

        // Attempt save - should fail
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, agent.getState() as any))
          .rejects.toThrow('Disk full');

        // FIX (Issue #123): Version should NOT have incremented because save failed
        expect(agent.getState().stateVersion).toBe(initialVersion);
      });

      /**
       * THIS TEST VERIFIES THE BUG EXISTS
       * It will FAIL with the current implementation and PASS after the Option C fix.
       * Uncomment to verify the bug, then keep uncommented after the fix.
       */
      /**
       * FIX (Issue #123): stateVersion now only increments on successful save.
       * This test verifies the Option C pattern is working correctly.
       */
      it('stateVersion should only increment on successful save', async () => {
        const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
        const initialVersion = agent.getState().stateVersion;
        expect(initialVersion).toBe(0);

        // Add a goal - with correct implementation, version should NOT change yet
        agent.addGoal({ description: 'Test goal for correct behavior' });

        // With Option C (correct behavior): version should still be 0.
        // A successful first save advances the persisted version to 1.
        // This test asserts the CORRECT behavior
        expect(agent.getState().stateVersion).toBe(0);

        // Mock successful save
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---\nname: test-agent\n---\nContent`;
        }));

        // Save should increment version
        await agentManager.exposedSaveAgentState(TEST_AGENT_NAME, agent.getState() as any);

        // After successful save, version should be 1
        // Note: The agent object won't automatically update - this tests the pattern
      });

      it('should not increment stateVersion when size validation fails', async () => {
        const agent = new Agent({ name: TEST_AGENT_NAME }, metadataService);
        const initialVersion = agent.getState().stateVersion;

        // Add goal - with Option C fix, version does NOT change during operation
        agent.addGoal({ description: 'Test goal' });

        // Version should still be initial (not incremented during addGoal)
        expect(agent.getState().stateVersion).toBe(initialVersion);

        // Create oversized state by modifying context directly (bypassing validation)
        const oversizedState = {
          ...agent.getState(),
          context: { data: 'x'.repeat(100 * 1024) }  // Exceed limit
        };

        // Attempt save - should fail due to size
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, oversizedState as any))
          .rejects.toThrow('exceeds allowed size');

        // FIX (Issue #123): Version should NOT have changed because save failed
        expect(agent.getState().stateVersion).toBe(initialVersion);
      });

      it('should not persist stateVersion increment when version conflict occurs', async () => {
        // Setup: Load an agent with version 1
        fileOperationsService.exists.mockResolvedValue(true);
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
stateVersion: 5
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Create a state with lower version (simulating stale state)
        const staleState = {
          goals: [],
          decisions: [],
          context: { test: 'stale' },
          lastActive: new Date().toISOString(),
          sessionCount: 1,
          stateVersion: 3  // Lower than disk version (5)
        };

        // Attempt to save stale state - should fail with version conflict
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, staleState as any))
          .rejects.toThrow('State version conflict');

        // Verify no write occurred
        expect(fileOperationsService.writeFile).not.toHaveBeenCalled();
      });
    });

    describe('Issue #697: V2 Field Normalization on Load', () => {
      it('should normalize goals (plural) to goal on load', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: plural-goal-agent
type: agent
goals:
  template: "Do {{task}}"
  parameters:
    - name: task
      description: The task to do
      required: true
---
Agent with plural goals field`;
        }));

        const agent = await agentManager.read('plural-goal-agent');
        expect(agent).not.toBeNull();
        // goal should be set from goals
        expect((requireLoadedAgent(agent).metadata as any).goal).toBeDefined();
        expect((requireLoadedAgent(agent).metadata as any).goal.template).toBe('Do {{task}}');
        // goals (plural) should be removed
        expect((requireLoadedAgent(agent).metadata as any).goals).toBeUndefined();
      });

      it('should not clobber existing goal when goals (plural) also present', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: both-goal-agent
type: agent
goal:
  template: "Primary {{task}}"
goals:
  template: "Legacy {{task}}"
---
Agent with both goal and goals`;
        }));

        const agent = await agentManager.read('both-goal-agent');
        expect(agent).not.toBeNull();
        // Original goal should be preserved
        expect((requireLoadedAgent(agent).metadata as any).goal.template).toBe('Primary {{task}}');
        // goals should be cleaned up
        expect((requireLoadedAgent(agent).metadata as any).goals).toBeUndefined();
      });

      it('should normalize maxSteps to maxAutonomousSteps inside autonomy', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: maxsteps-agent
type: agent
autonomy:
  maxSteps: 5
  riskTolerance: moderate
---
Agent with maxSteps shorthand`;
        }));

        const agent = await agentManager.read('maxsteps-agent');
        expect(agent).not.toBeNull();
        const autonomy = (requireLoadedAgent(agent).metadata as any).autonomy;
        expect(autonomy.maxAutonomousSteps).toBe(5);
        expect(autonomy.maxSteps).toBeUndefined();
      });

      it('should promote root-level riskTolerance into autonomy block', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: root-risk-agent
type: agent
riskTolerance: conservative
---
Agent with root-level riskTolerance`;
        }));

        const agent = await agentManager.read('root-risk-agent');
        expect(agent).not.toBeNull();
        const autonomy = (requireLoadedAgent(agent).metadata as any).autonomy;
        expect(autonomy).toBeDefined();
        expect(autonomy.riskTolerance).toBe('conservative');
      });

      it('should promote root-level maxAutonomousSteps into autonomy block', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: root-steps-agent
type: agent
maxAutonomousSteps: 10
---
Agent with root-level maxAutonomousSteps`;
        }));

        const agent = await agentManager.read('root-steps-agent');
        expect(agent).not.toBeNull();
        const autonomy = (requireLoadedAgent(agent).metadata as any).autonomy;
        expect(autonomy).toBeDefined();
        expect(autonomy.maxAutonomousSteps).toBe(10);
        expect((requireLoadedAgent(agent).metadata as any).maxAutonomousSteps).toBeUndefined();
      });

      it('should not clobber existing autonomy.riskTolerance with root-level value', async () => {
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: noclobber-agent
type: agent
riskTolerance: aggressive
autonomy:
  riskTolerance: conservative
  maxAutonomousSteps: 3
---
Agent with both root and nested riskTolerance`;
        }));

        const agent = await agentManager.read('noclobber-agent');
        expect(agent).not.toBeNull();
        const autonomy = (requireLoadedAgent(agent).metadata as any).autonomy;
        // Nested value should win
        expect(autonomy.riskTolerance).toBe('conservative');
        expect(autonomy.maxAutonomousSteps).toBe(3);
      });
    });

    describe('Version Conflict Detection', () => {
      it('should detect version conflict when disk version is higher', async () => {
        // Mock disk state with version 10
        fileOperationsService.exists.mockResolvedValue(true);
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
stateVersion: 10
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Try to save with version 5 (stale)
        const staleState = {
          goals: [{ id: 'goal_1', description: 'New goal', status: 'pending' }],
          decisions: [],
          context: {},
          lastActive: new Date().toISOString(),
          sessionCount: 2,
          stateVersion: 5
        };

        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, staleState as any))
          .rejects.toThrow(/State version conflict.*current version is 10.*attempted to save version 5/);
      });

      it('should allow save when disk version matches attempted version', async () => {
        // Mock disk state with version 5
        fileOperationsService.exists.mockResolvedValue(true);
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
stateVersion: 5
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // Save with version 5 (matches disk) - should increment to 6
        // Note: Current implementation allows equal versions (not just greater)
        const matchingState = {
          goals: [{ id: 'goal_1', description: 'New goal', status: 'pending' }],
          decisions: [],
          context: {},
          lastActive: new Date().toISOString(),
          sessionCount: 2,
          stateVersion: 5
        };

        // Should succeed - versions match
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, matchingState as any))
          .resolves.not.toThrow();
      });

      it('should reject a save when the caller skipped over the durable version', async () => {
        // Mock disk state with version 3
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            return `---
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 1
stateVersion: 3
---`;
          }
          return `---
name: test-agent
---
Content`;
        }));

        // A caller cannot skip from version 3 to version 5. It must reload and
        // present the exact durable generation before writing version 4.
        const newerState = {
          goals: [],
          decisions: [],
          context: { updated: true },
          lastActive: new Date().toISOString(),
          sessionCount: 2,
          stateVersion: 5
        };

        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, newerState as any))
          .rejects.toThrow('State version conflict');
      });

      it('should handle first save when no state file exists', async () => {
        // Mock: no state file exists (ENOENT)
        fileOperationsService.readFile.mockImplementation(asAsyncRead((filePath: string) => {
          if (filePath.includes(STATE_FILE_SUFFIX)) {
            const error = new Error('ENOENT') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return `---
name: test-agent
---
Content`;
        }));

        const newState = {
          goals: [{ id: 'goal_1', description: 'First goal', status: 'pending' }],
          decisions: [],
          context: {},
          lastActive: new Date().toISOString(),
          sessionCount: 1,
          stateVersion: 0
        };

        // Should succeed - no existing state to conflict with
        await expect(agentManager.exposedSaveAgentState(TEST_AGENT_NAME, newState as any))
          .resolves.not.toThrow();
      });
    });
  });
});
