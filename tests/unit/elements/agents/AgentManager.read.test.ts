/**
 * Unit tests for AgentManager.read() flexible fallback (#607)
 *
 * Validates that execute_agent can find agents whose filenames don't
 * exactly match {normalizeFilename(name)}.md — e.g., legacy agents
 * with a `-agent` suffix or other non-standard naming.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';

jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/services/FileOperationsService.js');

import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService, TestableAgentManager } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

const metadataService: MetadataService = createTestMetadataService();

const AGENT_CONTENT_STANDARD = `---
name: my-agent
type: agent
version: 1.0.0
description: Standard agent
decisionFramework: rule_based
specializations:
  - testing
---

# My Agent

Agent instructions`;

const AGENT_CONTENT_LEGACY = `---
name: legacy-poster
type: agent
version: 1.0.0
description: Legacy agent with -agent suffix filename
decisionFramework: rule_based
specializations:
  - posting
---

# Legacy Poster

Post things`;

const AGENT_CONTENT_WRONG_DIRECT_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: different-agent',
);

const AGENT_CONTENT_REQUESTED_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: requested-agent',
);

const AGENT_CONTENT_STORAGE_FALLBACK_IDENTITY = AGENT_CONTENT_STANDARD.replace(
  'name: my-agent',
  'name: "---"',
);

const ACTIVE_REQUESTED_STATE = `---
goals:
  - id: goal_requested_active
    description: Requested identity goal
    priority: high
    status: in_progress
    importance: 8
    urgency: 7
    createdAt: 2026-08-04T12:00:00Z
    updatedAt: 2026-08-04T12:01:00Z
decisions: []
context: {}
lastActive: 2026-08-04T12:01:00Z
sessionCount: 1
stateVersion: 2
---`;

describe('AgentManager.read() flexible fallback (#607)', () => {
  let agentManager: TestableAgentManager;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let container: InstanceType<typeof DollhouseContainer>;
  let fileOperationsService: jest.Mocked<FileOperationsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    testDir = path.join(os.tmpdir(), 'agent-read-test-' + Math.random().toString(36).substring(7));
    portfolioPath = testDir;

    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    container = new DollhouseContainer();
    container.replace<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    container.replace<FileLockManager>('FileLockManager', () => new FileLockManager());

    const mockFileOperations: any = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      readFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      listDirectory: jest.fn().mockResolvedValue([]),
      stat: jest.fn().mockResolvedValue({ isDirectory: () => true }),
      resolvePath: jest.fn((p: string) => path.resolve(portfolioPath, p)),
      validatePath: jest.fn().mockReturnValue(true),
      createFileExclusive: jest.fn().mockResolvedValue(true)
    };
    // BaseElementManager.load uses readElementFile. Wire dynamically so tests
    // that reassign readFile propagate to the element-read path.
    mockFileOperations.readElementFile = jest.fn((...args: unknown[]) => mockFileOperations.readFile(...args));
    container.replace<FileOperationsService>('FileOperationsService', () => mockFileOperations as any);

    container.replace('SerializationService', () => new SerializationService());
    container.replace('MetadataService', () => metadataService);
    container.replace('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

    container.replace('AgentManager', () => new TestableAgentManager({
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

    agentManager = container.resolve<AgentManager>('AgentManager');
    fileOperationsService = container.resolve<FileOperationsService>('FileOperationsService') as jest.Mocked<FileOperationsService>;

    await agentManager.initialize();
  });

  afterEach(async () => {
    await container.dispose();
  });

  describe('direct lookup succeeds', () => {
    it('should return the agent without fallback', async () => {
      fileOperationsService.readFile.mockResolvedValue(AGENT_CONTENT_STANDARD);

      const agent = await agentManager.read('my-agent');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('my-agent');
    });

    it('should accept metadata that resolves to the requested storage fallback identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'unnamed.md') {
          return AGENT_CONTENT_STORAGE_FALLBACK_IDENTITY;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const agent = await agentManager.read('unnamed');

      expect(agent?.metadata.name).toBe('---');
      expect(mockPortfolioManager.listElements).not.toHaveBeenCalled();
    });

    it('should fall back when the direct filename contains a different agent', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'requested-agent.md') return AGENT_CONTENT_WRONG_DIRECT_IDENTITY;
        if (filename === 'legacy-requested-agent.md') return AGENT_CONTENT_REQUESTED_IDENTITY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'requested-agent.md',
        'legacy-requested-agent.md',
      ]);

      const agent = await agentManager.read('requested-agent');

      expect(agent?.metadata.name).toBe('requested-agent');
      expect(mockPortfolioManager.listElements).toHaveBeenCalledWith(ElementType.AGENT);
    });

    it('should not attach requested recovery state to a mismatched direct definition', async () => {
      const stateReads: string[] = [];
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'requested-agent.md') return AGENT_CONTENT_WRONG_DIRECT_IDENTITY;
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          return ACTIVE_REQUESTED_STATE;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['requested-agent.md']);

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'requested-agent' }))
        .rejects.toThrow("Agent 'requested-agent' not found");
      expect(stateReads).toEqual([]);
    });
  });

  describe('direct lookup ENOENT + flexible match finds agent', () => {
    it('should fall back to flexible matching and return the agent', async () => {
      // Direct lookup: ENOENT (filename mismatch)
      // Flexible fallback via list(): returns the legacy-named file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('legacy-poster.md')) {
          // Direct lookup for "legacy-poster" — file doesn't exist at this path
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        if (filePath.includes('legacy-poster-agent.md')) {
          // The actual file on disk has "-agent" suffix
          return AGENT_CONTENT_LEGACY;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      // list() uses portfolioManager.listElements which returns filenames
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const agent = await agentManager.read('legacy-poster');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('legacy-poster');
    });

    it('should match case-insensitively on metadata name', async () => {
      const upperCaseContent = AGENT_CONTENT_LEGACY.replace(
        'name: legacy-poster',
        'name: Legacy-Poster'
      );

      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('legacy-poster-agent.md')) {
          return upperCaseContent;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });

      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const agent = await agentManager.read('legacy-poster');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('Legacy-Poster');
    });

    it('should preserve candidate-file state for ordinary flexible reads', async () => {
      const stateReads: string[] = [];
      const candidateState = ACTIVE_REQUESTED_STATE.replace(
        'goal_requested_active',
        'goal_candidate_active',
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          if (filename === 'legacy-poster-agent.state.yaml') {
            return candidateState;
          }
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const result = await agentManager.getAgentState({ agentName: 'legacy-poster' });

      expect(result.state.goals).toEqual([
        expect.objectContaining({ id: 'goal_candidate_active', status: 'in_progress' })
      ]);
      expect(stateReads).toEqual(['legacy-poster-agent.state.yaml']);
    });

    it('should hydrate strict recovery from the requested state identity', async () => {
      const stateReads: string[] = [];
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        if (filename.endsWith('.state.yaml')) {
          stateReads.push(filename);
          if (filename === 'legacy-poster.state.yaml') {
            return ACTIVE_REQUESTED_STATE;
          }
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      const result = await agentManager.getAgentStateForRecovery({ agentName: 'legacy-poster' });

      expect(result.state.goals).toEqual([
        expect.objectContaining({ id: 'goal_requested_active', status: 'in_progress' })
      ]);
      expect(stateReads).toEqual(['legacy-poster.state.yaml']);
    });

    it('should return empty state for an ordinary flexible read with no requested state identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md' || filename.endsWith('.state.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') return AGENT_CONTENT_LEGACY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      await expect(agentManager.getAgentState({ agentName: 'legacy-poster' }))
        .resolves.toEqual(expect.objectContaining({
          agentName: 'legacy-poster',
          state: expect.objectContaining({ goals: [] }),
        }));
    });

    it('should fail closed during recovery when a flexible match has no requested state identity', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md' || filename.endsWith('.state.yaml')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') return AGENT_CONTENT_LEGACY;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-poster-agent.md']);

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'legacy-poster' }))
        .rejects.toThrow('Cannot verify durable state');
    });
  });

  describe('direct lookup ENOENT + no flexible match', () => {
    it('should return null', async () => {
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockResolvedValue([]);

      const agent = await agentManager.read('completely-missing');

      expect(agent).toBeNull();
    });

    it('should return null when list has agents but none match', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('other-agent.md')) {
          return AGENT_CONTENT_STANDARD;
        }
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      });
      mockPortfolioManager.listElements.mockResolvedValue(['other-agent.md']);

      const agent = await agentManager.read('totally-different');

      expect(agent).toBeNull();
    });
  });

  describe('non-ENOENT errors', () => {
    it('should propagate non-ENOENT errors without fallback', async () => {
      fileOperationsService.readFile.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(agentManager.read('some-agent')).rejects.toThrow('EACCES');
    });

    it('should propagate requested state failures through strict recovery reads', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        if (filename === 'my-agent.state.yaml') {
          throw Object.assign(new Error('State storage unavailable'), { code: 'EACCES' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'my-agent' }))
        .rejects.toThrow('State storage unavailable');
      expect(cacheSpy).not.toHaveBeenCalled();
    });

    it('should fail closed when the state directory is unavailable', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      fileOperationsService.stat.mockRejectedValueOnce(
        Object.assign(new Error('State mount unavailable'), { code: 'ENOENT' })
      );

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'my-agent' }))
        .rejects.toThrow('Agent state directory unavailable: State mount unavailable');
    });

    it('should bypass cached state without replacing shared caches during strict recovery reads', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      let requestedState = ACTIVE_REQUESTED_STATE.replace('in_progress', 'completed');
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'my-agent.md') return AGENT_CONTENT_STANDARD;
        if (filename === 'my-agent.state.yaml') return requestedState;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const firstRead = await agentManager.read('my-agent');
      expect(firstRead?.getState().goals[0]?.status).toBe('completed');

      requestedState = ACTIVE_REQUESTED_STATE;
      cacheSpy.mockClear();
      const strictRead = await agentManager.getAgentStateForRecovery({ agentName: 'my-agent' });
      expect(strictRead.state.goals[0]?.status).toBe('in_progress');
      expect(cacheSpy).not.toHaveBeenCalled();

      const ordinaryRead = await agentManager.getAgentState({ agentName: 'my-agent' });
      expect(ordinaryRead.state.goals[0]?.status).toBe('completed');
    });
  });

  describe('flexible fallback resilience', () => {
    it('should preserve ordinary not-found behavior for an empty portfolio', async () => {
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockResolvedValue([]);

      await expect(agentManager.read('missing-agent')).resolves.toBeNull();
      expect(mockPortfolioManager.listElements).toHaveBeenCalledWith(ElementType.AGENT);
    });

    it('should propagate list failures through strict recovery reads', async () => {
      // Direct lookup: ENOENT
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      // list() itself throws
      mockPortfolioManager.listElements.mockRejectedValue(new Error('Storage unavailable'));

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'failing-agent' }))
        .rejects.toThrow('Storage unavailable');
      expect(mockPortfolioManager.listElements).toHaveBeenCalledWith(
        ElementType.AGENT,
        { throwOnFilesystemError: true }
      );
    });

    it('should preserve a missing agents directory as a storage failure', async () => {
      fileOperationsService.createDirectory.mockClear();
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('Direct file missing'), { code: 'ENOENT' })
      );
      mockPortfolioManager.listElements.mockRejectedValue(
        Object.assign(new Error('Agents directory unavailable'), { code: 'ENOENT' })
      );

      await expect(agentManager.getAgentStateForRecovery({ agentName: 'offline-agent' }))
        .rejects.toThrow('Agents directory unavailable');
      expect(fileOperationsService.createDirectory).not.toHaveBeenCalled();
    });

    it('should propagate candidate load failures through getAgentState()', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (path.basename(filePath) === 'failing-agent.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        throw new Error('Candidate storage unavailable');
      });
      mockPortfolioManager.listElements.mockResolvedValue(['legacy-failing-agent.md']);

      await expect(agentManager.getAgentState({ agentName: 'failing-agent' }))
        .rejects.toThrow('Candidate storage unavailable');
    });

    it('should return a matching candidate despite an unrelated load failure', async () => {
      const cacheSpy = jest.spyOn(
        agentManager as unknown as {
          cacheElement: (agent: unknown, filename: string) => void;
        },
        'cacheElement'
      );
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const filename = path.basename(filePath);
        if (filename === 'legacy-poster.md') {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (filename === 'legacy-poster-agent.md') {
          return AGENT_CONTENT_LEGACY;
        }
        throw new Error('Unrelated candidate is malformed');
      });
      mockPortfolioManager.listElements.mockResolvedValue([
        'broken-agent.md',
        'legacy-poster-agent.md'
      ]);

      await expect(agentManager.read('legacy-poster')).resolves.toMatchObject({
        metadata: { name: 'legacy-poster' }
      });
      expect(cacheSpy).not.toHaveBeenCalled();
    });
  });
});
