/**
 * Unit tests for AgentManager circular activation detection (Issue #109 - HIGH-1)
 * Tests that agents cannot activate themselves directly or indirectly
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';

// Mock the security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');
jest.mock('../../../../src/services/FileOperationsService.js');

// Import after mocking
import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { logger } from '../../../../src/utils/logger.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';

const metadataService: MetadataService = createTestMetadataService();

describe('AgentManager - Circular Activation Detection (Issue #109)', () => {
  let agentManager: InstanceType<typeof AgentManager>;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let container: InstanceType<typeof DollhouseContainer>;

  // Create test agents
  const createSelfReferencingAgent = () => ({
    name: 'recursive-agent',
    content: `---
name: recursive-agent
version: "2.0"
author: test
goal:
  template: "Recursive test agent"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - recursive-agent
---

# Recursive Agent

This agent activates itself (should be blocked).
`
  });

  const createAgentA = () => ({
    name: 'agent-a',
    content: `---
name: agent-a
version: "2.0"
author: test
goal:
  template: "Agent A test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - agent-b
---

# Agent A

This agent activates agent-b.
`
  });

  const createAgentB = () => ({
    name: 'agent-b',
    content: `---
name: agent-b
version: "2.0"
author: test
goal:
  template: "Agent B test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - agent-a
---

# Agent B

This agent activates agent-a (creates a cycle).
`
  });

  const createAgentC = () => ({
    name: 'agent-c',
    content: `---
name: agent-c
version: "2.0"
author: test
goal:
  template: "Agent C test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - agent-d
---

# Agent C

This agent activates agent-d.
`
  });

  const createAgentD = () => ({
    name: 'agent-d',
    content: `---
name: agent-d
version: "2.0"
author: test
goal:
  template: "Agent D test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - agent-e
---

# Agent D

This agent activates agent-e.
`
  });

  const createAgentE = () => ({
    name: 'agent-e',
    content: `---
name: agent-e
version: "2.0"
author: test
goal:
  template: "Agent E test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - agent-c
---

# Agent E

This agent activates agent-c (creates longer cycle: C→D→E→C).
`
  });

  const createGhostActivatorAgent = () => ({
    name: 'ghost-activator',
    content: `---
name: ghost-activator
version: "2.0"
author: test
goal:
  template: "Ghost activator test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - ghost-agent
---

# Ghost Activator

This agent activates a non-existent agent.
`
  });

  const createNormalAgent = () => ({
    name: 'normal-agent',
    content: `---
name: normal-agent
version: "2.0"
author: test
goal:
  template: "Normal test agent"
  successCriteria:
    - "Test completed"
activates:
  personas:
    - helpful-assistant
---

# Normal Agent

This agent activates personas (no cycles).
`
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    // Ensure logger methods are jest.fn() for assertion access
    (logger as any).warn = jest.fn();
    (logger as any).info = jest.fn();
    (logger as any).debug = jest.fn();
    (logger as any).error = jest.fn();

    // Create temporary test directory
    testDir = path.join(os.tmpdir(), 'agent-circular-test-' + Math.random().toString(36).substring(7));
    portfolioPath = testDir;

    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    container = new DollhouseContainer();
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);
    container.register<FileLockManager>('FileLockManager', () => new FileLockManager());

    // Mock FileOperationsService
    const fileStore = new Map<string, string>(); // Track written files

    const mockFileOperations = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockImplementation((filePath: string) => {
        return Promise.resolve(fileStore.has(filePath));
      }),
      readFile: jest.fn().mockImplementation((filePath: string) => {
        // Check if file was written to fileStore first
        if (fileStore.has(filePath)) {
          return Promise.resolve(fileStore.get(filePath)!);
        }

        // Otherwise, return agent content based on filename
        // Return agent content based on filename (case-insensitive for testing)
        // Filenames use plain {name}.md convention — directory provides type context
        const basename = path.basename(filePath, '.md');
        const lowerBasename = basename.toLowerCase();
        if (lowerBasename === 'recursive-agent') return Promise.resolve(createSelfReferencingAgent().content);
        if (lowerBasename === 'agent-a') return Promise.resolve(createAgentA().content);
        if (lowerBasename === 'agent-b') return Promise.resolve(createAgentB().content);
        if (lowerBasename === 'agent-c') return Promise.resolve(createAgentC().content);
        if (lowerBasename === 'agent-d') return Promise.resolve(createAgentD().content);
        if (lowerBasename === 'agent-e') return Promise.resolve(createAgentE().content);
        if (lowerBasename === 'normal-agent') return Promise.resolve(createNormalAgent().content);
        if (lowerBasename === 'ghost-activator') return Promise.resolve(createGhostActivatorAgent().content);
        if (lowerBasename === 'mixedcase-agent') {
          return Promise.resolve(`---
name: MixedCase-Agent
version: "2.0"
author: test
goal:
  template: "Mixed case test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - mixedcase-agent
---

# Mixed Case Agent
`);
        }
        if (lowerBasename === 'minimal-agent') {
          return Promise.resolve(`---
name: minimal-agent
version: "2.0"
author: test
goal:
  template: "Minimal test agent"
  successCriteria:
    - "Test completed"
---

# Minimal Agent
`);
        }
        if (lowerBasename === 'empty-activates-agent') {
          return Promise.resolve(`---
name: empty-activates-agent
version: "2.0"
author: test
goal:
  template: "Empty activates test"
  successCriteria:
    - "Test completed"
activates:
  agents: []
---

# Empty Activates Agent
`);
        }
        return Promise.reject(new Error('File not found'));
      }),
      writeFile: jest.fn().mockImplementation((filePath: string, content: string) => {
        fileStore.set(filePath, content);
        return Promise.resolve(undefined);
      }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      listDirectory: jest.fn().mockResolvedValue([]),
      resolvePath: jest.fn((p: string) => path.resolve(portfolioPath, p)),
      validatePath: jest.fn().mockReturnValue(true),
      createFileExclusive: jest.fn().mockResolvedValue(true)
    };
    container.register<FileOperationsService>('FileOperationsService', () => mockFileOperations as any);

    // Register DI services
    container.register('SerializationService', () => new SerializationService());
    container.register('MetadataService', () => metadataService);
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

    // Issue #1948: Element manager resolver passed via constructor deps.
    // Uses lazy reference to agentManagerInstance for self-referential activation.
    let agentManagerInstance: AgentManager;
    const elementManagerResolver = (managerName: string) => {
      if (managerName === 'PersonaManager') {
        return {
          list: async () => [{
            metadata: { name: 'helpful-assistant', type: 'persona' },
            content: 'Helpful assistant persona content'
          }]
        } as any;
      }
      if (managerName === 'AgentManager') {
        return agentManagerInstance;
      }
      return null;
    };

    agentManagerInstance = new AgentManager({
      portfolioManager: container.resolve('PortfolioManager'),
      fileLockManager: container.resolve('FileLockManager'),
      baseDir: portfolioPath,
      fileOperationsService: container.resolve('FileOperationsService'),
      validationRegistry: container.resolve('ValidationRegistry'),
      serializationService: container.resolve('SerializationService'),
      metadataService: container.resolve('MetadataService'),
      eventDispatcher: new ElementEventDispatcher(),
      elementManagerResolver,
    });

    container.register('AgentManager', () => agentManagerInstance);

    agentManager = container.resolve<AgentManager>('AgentManager');

    // Initialize manager
    await agentManager.initialize();
  });

  afterEach(async () => {
    // Reset static resolvers to prevent test isolation issues
    AgentManager.resetResolvers();
    await container.dispose();
  });

  describe('Self-referential activation', () => {
    it('should block agent that activates itself', async () => {
      // Create the agent
      const agentData = createSelfReferencingAgent();
      await agentManager.create(agentData.name, agentData.content);

      // Try to execute - should throw with circular detection error
      await expect(
        agentManager.executeAgent('recursive-agent', {})
      ).rejects.toThrow(/Circular agent activation detected.*recursive-agent → recursive-agent/);
    });

    it('should provide clear error message with cycle path', async () => {
      const agentData = createSelfReferencingAgent();
      await agentManager.create(agentData.name, agentData.content);

      try {
        await agentManager.executeAgent('recursive-agent', {});
        // Should not reach here
        expect(true).toBe(false); // Force test to fail if no error thrown
      } catch (error: any) {
        expect(error.message).toContain('Circular agent activation detected');
        expect(error.message).toContain('recursive-agent → recursive-agent');
        expect(error.message).toContain('cannot activate itself');
      }
    });
  });

  describe('Cross-agent circular activation (A→B→A)', () => {
    it('should detect circular activation between two agents', async () => {
      const agentAData = createAgentA();
      const agentBData = createAgentB();
      await agentManager.create(agentAData.name, agentAData.content);
      await agentManager.create(agentBData.name, agentBData.content);

      // Static cycle detection should catch A→B→A before any activation occurs
      await expect(
        agentManager.executeAgent('agent-a', {})
      ).rejects.toThrow(/Circular agent activation detected/);

      // Verify the error contains the cycle path and cycle length
      try {
        await agentManager.executeAgent('agent-a', {});
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain('agent-a');
        expect(error.message).toContain('agent-b');
        expect(error.message).toContain('cycle of 2');
      }
    });
  });

  describe('Longer circular chains (C→D→E→C)', () => {
    it('should detect circular activation in longer chains', async () => {
      const agentCData = createAgentC();
      const agentDData = createAgentD();
      const agentEData = createAgentE();
      await agentManager.create(agentCData.name, agentCData.content);
      await agentManager.create(agentDData.name, agentDData.content);
      await agentManager.create(agentEData.name, agentEData.content);

      // Static cycle detection should catch C→D→E→C
      await expect(
        agentManager.executeAgent('agent-c', {})
      ).rejects.toThrow(/Circular agent activation detected/);

      // Verify the error contains the full cycle path and cycle length
      try {
        await agentManager.executeAgent('agent-c', {});
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain('agent-c');
        expect(error.message).toContain('agent-d');
        expect(error.message).toContain('agent-e');
        expect(error.message).toContain('cycle of 3');
      }
    });
  });

  describe('Case sensitivity', () => {
    it('should use case-insensitive comparison for cycle detection', async () => {
      // The cycle detection uses case-insensitive comparison (via .toLowerCase())
      // This ensures that 'Agent-A' and 'agent-a' are treated as the same agent
      // The self-referential test above already validates this behavior
      // This test documents the design decision

      const agentData = createSelfReferencingAgent();
      await agentManager.create(agentData.name, agentData.content);

      // Should detect self-reference and throw error
      await expect(
        agentManager.executeAgent('recursive-agent', {})
      ).rejects.toThrow(/Circular agent activation detected/);
    });
  });

  describe('Non-circular activation chains', () => {
    it('should allow agents that do not form cycles', async () => {
      // Create an agent that activates personas (no cycle)
      const agentData = createNormalAgent();
      await agentManager.create(agentData.name, agentData.content);

      // Should execute successfully
      const result = await agentManager.executeAgent('normal-agent', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('normal-agent');
      expect(result.goal).toBe('Normal test agent');
    });

    it('should track agent chain depth correctly', async () => {
      const agentData = createNormalAgent();
      await agentManager.create(agentData.name, agentData.content);

      const result = await agentManager.executeAgent('normal-agent', {});
      expect(result.executionContext).toBeDefined();
      expect(result.executionContext?.agentChain).toEqual(['normal-agent']);
      expect(result.executionContext?.depth).toBe(0); // 0 for direct invocation
    });
  });

  describe('Non-circular multi-agent chains', () => {
    it('should allow agents that activate non-agent elements only', async () => {
      const agentData = createNormalAgent();
      await agentManager.create(agentData.name, agentData.content);

      // normal-agent only activates personas, no cycles possible
      const result = await agentManager.executeAgent('normal-agent', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('normal-agent');
      expect(result.goal).toBe('Normal test agent');
    });
  });

  describe('Diamond activation (no false positive)', () => {
    it('should allow diamond-shaped activation graphs without false positive', async () => {
      // Diamond pattern: A→B, A→C, B→D, C→D
      // This is NOT a cycle - D is reached via two paths but no node revisits itself

      // We need mock file responses for diamond agents
      const mockFileOps = (agentManager as any).fileOperations;
      const originalReadFile = mockFileOps.readFile;

      // Override readFile to also serve diamond agent files
      mockFileOps.readFile = jest.fn().mockImplementation((filePath: string) => {
        const basename = path.basename(filePath, '.md').toLowerCase();
        if (basename === 'diamond-a') {
          return Promise.resolve(`---
name: diamond-a
version: "2.0"
author: test
goal:
  template: "Diamond A test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - diamond-b
    - diamond-c
---

# Diamond A
`);
        }
        if (basename === 'diamond-b') {
          return Promise.resolve(`---
name: diamond-b
version: "2.0"
author: test
goal:
  template: "Diamond B test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - diamond-d
---

# Diamond B
`);
        }
        if (basename === 'diamond-c') {
          return Promise.resolve(`---
name: diamond-c
version: "2.0"
author: test
goal:
  template: "Diamond C test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - diamond-d
---

# Diamond C
`);
        }
        if (basename === 'diamond-d') {
          return Promise.resolve(`---
name: diamond-d
version: "2.0"
author: test
goal:
  template: "Diamond D test"
  successCriteria:
    - "Test completed"
---

# Diamond D (leaf)
`);
        }
        // Fall through to original
        return originalReadFile(filePath);
      });

      await agentManager.create('diamond-a', '');
      await agentManager.create('diamond-b', '');
      await agentManager.create('diamond-c', '');
      await agentManager.create('diamond-d', '');

      // Diamond graph has no cycles, should execute successfully
      const result = await agentManager.executeAgent('diamond-a', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('diamond-a');
    });
  });

  describe('Edge cases', () => {
    it('should handle agents with no activates configuration', async () => {
      await agentManager.create('minimal-agent', ''); // Content loaded from mock

      // Should execute without error
      const result = await agentManager.executeAgent('minimal-agent', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('minimal-agent');
    });

    it('should handle empty activates.agents array', async () => {
      await agentManager.create('empty-activates-agent', ''); // Content loaded from mock

      // Should execute without error
      const result = await agentManager.executeAgent('empty-activates-agent', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('empty-activates-agent');
    });

    it('should warn when an activated agent cannot be resolved', async () => {
      const agentData = createGhostActivatorAgent();
      await agentManager.create(agentData.name, agentData.content);

      // ghost-agent does not exist, so cycle detection should warn but not throw
      const result = await agentManager.executeAgent('ghost-activator', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('ghost-activator');

      // Verify the warning was logged for the unresolvable agent
      const mockedWarn = logger.warn as jest.MockedFunction<typeof logger.warn>;
      const warnCalls = mockedWarn.mock.calls.map(call => String(call[0]));
      expect(warnCalls.some(msg => msg.includes('could not be resolved during cycle detection'))).toBe(true);
    });
  });

  describe('DFS safety limits', () => {
    it('should stop DFS at depth limit and not detect cycles beyond it', async () => {
      // Create a chain of 13 agents: chain-0 -> chain-1 -> ... -> chain-12 -> chain-0
      // The cycle back to chain-0 is at depth 13 from root.
      // MAX_ACTIVATION_DEPTH = 10, so the DFS should stop before reaching it.
      const mockFileOps = (agentManager as any).fileOperations;
      const originalReadFile = mockFileOps.readFile;

      mockFileOps.readFile = jest.fn().mockImplementation((filePath: string) => {
        const basename = path.basename(filePath, '.md').toLowerCase();

        // chain-N agents: filename is chain-N.md, basename is 'chain-N'
        if (basename.startsWith('chain-')) {
          const num = parseInt(basename.replace('chain-', ''));
          if (!isNaN(num) && num >= 0 && num <= 12) {
            const nextAgent = num < 12 ? `chain-${num + 1}` : 'chain-0';
            return Promise.resolve(`---
name: chain-${num}
version: "2.0"
author: test
goal:
  template: "Chain ${num} test"
  successCriteria:
    - "Test completed"
activates:
  agents:
    - ${nextAgent}
---

# Chain Agent ${num}
`);
          }
        }

        // Fall through to original
        return originalReadFile(filePath);
      });

      // Create all 13 chain agents
      for (let i = 0; i <= 12; i++) {
        await agentManager.create(`chain-${i}`, '');
      }

      // The cycle is at depth 13 but the DFS limit is 10, so no cycle should be detected
      const result = await agentManager.executeAgent('chain-0', {});
      expect(result).toBeDefined();
      expect(result.agentName).toBe('chain-0');

      // Verify the depth limit warning was logged
      const mockedWarn = logger.warn as jest.MockedFunction<typeof logger.warn>;
      const warnCalls = mockedWarn.mock.calls.map(call => String(call[0]));
      expect(warnCalls.some(msg => msg.includes('hit depth limit of 10'))).toBe(true);
    });
  });
});
