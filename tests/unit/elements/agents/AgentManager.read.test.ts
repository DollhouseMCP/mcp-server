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
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    container.register<FileLockManager>('FileLockManager', () => new FileLockManager());

    const mockFileOperations: any = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      readFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      listDirectory: jest.fn().mockResolvedValue([]),
      resolvePath: jest.fn((p: string) => path.resolve(portfolioPath, p)),
      validatePath: jest.fn().mockReturnValue(true),
      createFileExclusive: jest.fn().mockResolvedValue(true)
    };
    // BaseElementManager.load uses readElementFile. Wire dynamically so tests
    // that reassign readFile propagate to the element-read path.
    mockFileOperations.readElementFile = jest.fn((...args: unknown[]) => mockFileOperations.readFile(...args));
    container.register<FileOperationsService>('FileOperationsService', () => mockFileOperations as any);

    container.register('SerializationService', () => new SerializationService());
    container.register('MetadataService', () => metadataService);
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

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
  });

  describe('flexible fallback resilience', () => {
    it('should return null if list() throws during fallback', async () => {
      // Direct lookup: ENOENT
      fileOperationsService.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      );
      // list() itself throws
      mockPortfolioManager.listElements.mockRejectedValue(new Error('Storage unavailable'));

      const agent = await agentManager.read('failing-agent');

      expect(agent).toBeNull();
    });
  });
});
