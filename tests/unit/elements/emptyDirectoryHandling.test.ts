import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the modules before importing
jest.mock('../../../src/security/fileLockManager.js');
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/utils/logger.js');

// Import managers after mocking
import { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

describe('Empty Directory Handling', () => {
  let testDir: string;
  let mockPortfolioManager: {
    getElementDir: jest.Mock<(type: ElementType) => string>;
    getBaseDir: jest.Mock<() => string>;
    listElements: jest.Mock<() => Promise<string[]>>;
    isTestElement: jest.Mock<() => boolean>;
  };
  let container: InstanceType<typeof DollhouseContainer>;
  
  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-dir-test-'));
    
    // Set up mocks
    jest.clearAllMocks();
    
    // Mock FileLockManager - simplified for Jest compatibility
    (FileLockManager as any).atomicWriteFile = jest.fn(() => Promise.resolve(undefined));
    (FileLockManager as any).atomicReadFile = jest.fn(() => Promise.resolve(''));
    (FileLockManager as any).withLock = jest.fn((resource: string, operation: () => Promise<any>) => operation());
    
    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();
    
    // Mock logger
    (logger as any).debug = jest.fn();
    (logger as any).error = jest.fn();
    (logger as any).warn = jest.fn();
    (logger as any).info = jest.fn();
    
    // Mock PortfolioManager
    mockPortfolioManager = {
      getElementDir: jest.fn((type: ElementType) => {
        if (type === ElementType.AGENT) return path.join(testDir, 'agents');
        if (type === ElementType.TEMPLATE) return path.join(testDir, 'templates');
        return testDir;
      }),
      getBaseDir: jest.fn(() => testDir),
      listElements: jest.fn(async () => []),
      isTestElement: jest.fn(() => false)
    };

    // Setup container and register mocks
    container = new DollhouseContainer();
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    // Register FileOperationsService using di-mocks helper - required by BaseElementManager
    const fileOperationsService = createTestFileOperationsService();
    container.register('FileOperationsService', () => fileOperationsService);
  });

  afterEach(async () => {
    // Clean up container
    await container.dispose();
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
    // Reset all mocks
    jest.restoreAllMocks();
  });

  describe('AgentManager', () => {
    it('should return empty array when agents directory does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      
      mockPortfolioManager.listElements.mockRejectedValueOnce(
        Object.assign(new Error('Directory does not exist'), { code: 'ENOENT' })
      );
      
      // Temporarily register AgentManager with specific dependencies for this test
      const serializationService = new SerializationService();
      const metadataService = new MetadataService();
      const validationRegistry = new ValidationRegistry(
        new ValidationService(),
        new TriggerValidationService(),
        metadataService
      );
      container.register('AgentManager', () => new AgentManager({
        portfolioManager: container.resolve('PortfolioManager'),
        fileLockManager: container.resolve('FileLockManager'),
        baseDir: nonExistentDir,
        fileOperationsService: container.resolve('FileOperationsService'),
        validationRegistry,
        serializationService,
        metadataService,
        eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
      }));
      const manager = container.resolve<AgentManager>('AgentManager');
      
      // list() should return empty array
      const agents = await manager.list();
      expect(agents).toEqual([]);
      
      // Should log debug message
      expect(logger.debug).toHaveBeenCalledWith(
        'Agents directory does not exist yet, returning empty array'
      );
    });

    it('should handle EACCES permission errors gracefully', async () => {
      // Mock PortfolioManager to throw EACCES for listElements
      mockPortfolioManager.listElements.mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      );
      
      const serializationService = new SerializationService();
      const metadataService = new MetadataService();
      const validationRegistry = new ValidationRegistry(
        new ValidationService(),
        new TriggerValidationService(),
        metadataService
      );
      container.register('AgentManager', () => new AgentManager({
        portfolioManager: container.resolve('PortfolioManager'),
        fileLockManager: container.resolve('FileLockManager'),
        baseDir: testDir,
        fileOperationsService: container.resolve('FileOperationsService'),
        validationRegistry,
        serializationService,
        metadataService,
        eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
      }));
      const manager = container.resolve<AgentManager>('AgentManager');

      const agents = await manager.list();
      expect(agents).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('TemplateManager', () => {
    it('should return empty array when templates directory does not exist', async () => {
      // Mock PortfolioManager to return empty array for templates
      mockPortfolioManager.listElements.mockResolvedValueOnce([]);

      const manager = container.resolve<TemplateManager>('TemplateManager');
      const templates = await manager.list();

      expect(Array.isArray(templates)).toBe(true);
    });
  });

  // Memory and Ensemble managers have been removed from the codebase

  describe('Remaining Managers', () => {
    it('should handle empty directories consistently', async () => {
      // Mock PortfolioManager to return empty arrays
      mockPortfolioManager.listElements.mockResolvedValue([]);

      // All managers should return empty arrays
      const serializationService = new SerializationService();
      const metadataService = new MetadataService();
      const validationRegistry = new ValidationRegistry(
        new ValidationService(),
        new TriggerValidationService(),
        metadataService
      );
      container.register('AgentManager', () => new AgentManager({
        portfolioManager: container.resolve('PortfolioManager'),
        fileLockManager: container.resolve('FileLockManager'),
        baseDir: testDir,
        fileOperationsService: container.resolve('FileOperationsService'),
        validationRegistry,
        serializationService,
        metadataService,
        eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
      }));
      const agentManager = container.resolve<AgentManager>('AgentManager');
      const templateManager = container.resolve<TemplateManager>('TemplateManager');
      
      // Initialize agent manager
      await agentManager.initialize();
      
      expect(Array.isArray(await agentManager.list())).toBe(true);
      expect(Array.isArray(await templateManager.list())).toBe(true);
    });
  });
});
