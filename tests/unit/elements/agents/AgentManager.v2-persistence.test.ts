/**
 * Unit tests for AgentManager v2 metadata persistence
 *
 * Tests that v2 fields are correctly preserved during serialization/deserialization
 * and that type coercion doesn't corrupt boolean/number values.
 *
 * @see Issue #108 - CRIT-3: serializeElement drops v2 metadata fields
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Mock the security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

// Import after mocking
import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../../src/elements/agents/Agent.js';
import {
  AgentMetadataV2,
  AgentGoalConfig,
  AgentActivates,
  AgentToolConfig
} from '../../../../src/elements/agents/types.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { normalizeAutonomyKeys, normalizeResilienceKeys, normalizeGoalKeys, isOneOf } from '../../../../src/elements/agents/constants.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

const metadataService: MetadataService = createTestMetadataService();

// Issue #725: Unit tests for normalizeGoalKeys
describe('normalizeGoalKeys', () => {
  it('should promote success_criteria to successCriteria', () => {
    const obj: Record<string, unknown> = { template: 'Do X', success_criteria: ['done'] };
    normalizeGoalKeys(obj);
    expect(obj.successCriteria).toEqual(['done']);
    expect(obj.success_criteria).toBeUndefined();
  });

  it('should not clobber existing successCriteria', () => {
    const obj: Record<string, unknown> = { successCriteria: ['a'], success_criteria: ['b'] };
    normalizeGoalKeys(obj);
    expect(obj.successCriteria).toEqual(['a']);
    expect(obj.success_criteria).toBeUndefined();
  });

  it('should be safe on already-normalized objects', () => {
    const obj: Record<string, unknown> = { successCriteria: ['x'] };
    normalizeGoalKeys(obj);
    expect(obj.successCriteria).toEqual(['x']);
  });
});

// Issue #730: Unit tests for shared helpers
describe('isOneOf', () => {
  const options = ['a', 'b', 'c'] as const;

  it('should return true for matching strings', () => {
    expect(isOneOf('a', options)).toBe(true);
    expect(isOneOf('c', options)).toBe(true);
  });

  it('should return false for non-matching strings', () => {
    expect(isOneOf('d', options)).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isOneOf(42, options)).toBe(false);
    expect(isOneOf(null, options)).toBe(false);
    expect(isOneOf(undefined, options)).toBe(false);
    expect(isOneOf(true, options)).toBe(false);
  });
});

// Issue #730: Unit tests for shared normalization helpers
describe('normalizeAutonomyKeys', () => {
  it('should promote snake_case to camelCase', () => {
    const obj: Record<string, unknown> = { risk_tolerance: 'conservative', max_autonomous_steps: 10 };
    normalizeAutonomyKeys(obj);
    expect(obj.riskTolerance).toBe('conservative');
    expect(obj.maxAutonomousSteps).toBe(10);
    expect(obj.risk_tolerance).toBeUndefined();
    expect(obj.max_autonomous_steps).toBeUndefined();
  });

  it('should not clobber existing camelCase keys', () => {
    const obj: Record<string, unknown> = { riskTolerance: 'aggressive', risk_tolerance: 'conservative' };
    normalizeAutonomyKeys(obj);
    expect(obj.riskTolerance).toBe('aggressive');
    expect(obj.risk_tolerance).toBeUndefined();
  });

  it('should handle all four autonomy keys', () => {
    const obj: Record<string, unknown> = {
      risk_tolerance: 'moderate', max_autonomous_steps: 5,
      requires_approval: ['delete_*'], auto_approve: ['read_*'],
    };
    normalizeAutonomyKeys(obj);
    expect(obj).toEqual({
      riskTolerance: 'moderate', maxAutonomousSteps: 5,
      requiresApproval: ['delete_*'], autoApprove: ['read_*'],
    });
  });

  it('should be safe to call on already-normalized objects', () => {
    const obj: Record<string, unknown> = { riskTolerance: 'conservative' };
    normalizeAutonomyKeys(obj);
    expect(obj.riskTolerance).toBe('conservative');
  });
});

describe('normalizeResilienceKeys', () => {
  it('should promote all six snake_case keys to camelCase', () => {
    const obj: Record<string, unknown> = {
      on_step_limit_reached: 'pause', on_execution_failure: 'retry',
      max_retries: 3, max_continuations: 5,
      retry_backoff: 'exponential', preserve_state: true,
    };
    normalizeResilienceKeys(obj);
    expect(obj).toEqual({
      onStepLimitReached: 'pause', onExecutionFailure: 'retry',
      maxRetries: 3, maxContinuations: 5,
      retryBackoff: 'exponential', preserveState: true,
    });
  });

  it('should not clobber existing camelCase keys', () => {
    const obj: Record<string, unknown> = { onStepLimitReached: 'continue', on_step_limit_reached: 'pause' };
    normalizeResilienceKeys(obj);
    expect(obj.onStepLimitReached).toBe('continue');
    expect(obj.on_step_limit_reached).toBeUndefined();
  });
});

describe('AgentManager v2 Metadata Persistence', () => {
  let agentManager: InstanceType<typeof AgentManager>;
  let testDir: string;
  let portfolioPath: string;
  let container: InstanceType<typeof DollhouseContainer>;
  let serializationService: SerializationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create temporary test directory
    testDir = path.join(os.tmpdir(), 'agent-v2-test-' + Math.random().toString(36).substring(7));
    portfolioPath = testDir;

    // Create real directory structure for file-based tests
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ElementType.AGENT), { recursive: true });

    const mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    container = new DollhouseContainer();
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);

    // Configure FileLockManager mock to execute callbacks (withLock pass-through).
    // Tests need actual file writes to verify V2 field persistence on disk.
    const mockFileLockManager = new FileLockManager();
    (mockFileLockManager as any).withLock = jest.fn(
      async (_resource: string, operation: () => Promise<unknown>) => operation()
    );
    (mockFileLockManager as any).atomicWriteFile = jest.fn(
      async (filePath: string, content: string, options?: any) => {
        const fsImport = await import('fs/promises');
        await fsImport.writeFile(filePath, content, options);
      }
    );
    (mockFileLockManager as any).atomicReadFile = jest.fn(
      async (filePath: string, options?: any) => {
        const fsImport = await import('fs/promises');
        return fsImport.readFile(filePath, options);
      }
    );
    container.register<FileLockManager>('FileLockManager', () => mockFileLockManager);

    // Use real FileOperationsService for this test (needs the FileLockManager for writeFile)
    container.register<FileOperationsService>('FileOperationsService', () =>
      new FileOperationsService(container.resolve('FileLockManager'))
    );

    // Register DI services
    serializationService = new SerializationService();
    container.register('SerializationService', () => serializationService);
    container.register('MetadataService', () => metadataService);
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));

    container.register('AgentManager', () => new AgentManager({
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
  });

  afterEach(async () => {
    // Cleanup test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('v2 Field Persistence', () => {
    it('should persist goal field with all subfields', async () => {
      const goal: AgentGoalConfig = {
        template: 'Analyze {directory} for {issue_type}',
        parameters: [
          { name: 'directory', type: 'string', required: true, description: 'Directory to analyze' },
          { name: 'issue_type', type: 'string', required: false, default: 'security issues' }
        ],
        successCriteria: [
          'Analysis report generated',
          'All files scanned',
          'Issues prioritized'
        ]
      };

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-goal',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with v2 goal',
        goal
      };

      // Create agent
      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      // Serialize
      const serialized = await (agentManager as any).serializeElement(agent);

      // Parse back
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      // Verify goal persisted with all fields
      expect(parsedMetadata.goal).toBeDefined();
      expect(parsedMetadata.goal.template).toBe(goal.template);
      expect(parsedMetadata.goal.parameters).toHaveLength(2);
      expect(parsedMetadata.goal.parameters[0].name).toBe('directory');
      expect(parsedMetadata.goal.parameters[0].required).toBe(true);
      expect(parsedMetadata.goal.parameters[1].default).toBe('security issues');
      expect(parsedMetadata.goal.successCriteria).toEqual(goal.successCriteria);
    });

    it('should persist activates field with all element types', async () => {
      const activates: AgentActivates = {
        personas: ['code-reviewer', 'security-expert'],
        skills: ['code-analysis', 'vulnerability-detection'],
        memories: ['project-context', 'security-history'],
        templates: ['report-template'],
        ensembles: ['security-ensemble']
      };

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-activates',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with activates',
        goal: {
          template: 'Test goal',
          parameters: []
        },
        activates
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.activates).toBeDefined();
      expect(parsedMetadata.activates?.personas).toEqual(activates.personas);
      expect(parsedMetadata.activates?.skills).toEqual(activates.skills);
      expect(parsedMetadata.activates?.memories).toEqual(activates.memories);
      expect(parsedMetadata.activates?.templates).toEqual(activates.templates);
      expect(parsedMetadata.activates?.ensembles).toEqual(activates.ensembles);
    });

    it('should persist tools field with allowed and denied lists', async () => {
      const tools: AgentToolConfig = {
        allowed: ['read_file', 'search_code', 'analyze_security'],
        denied: ['delete_file', 'execute_command']
      };

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-tools',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with tools',
        goal: {
          template: 'Test goal',
          parameters: []
        },
        tools
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.tools).toBeDefined();
      expect(parsedMetadata.tools?.allowed).toEqual(tools.allowed);
      expect(parsedMetadata.tools?.denied).toEqual(tools.denied);
    });

    it('should persist systemPrompt field', async () => {
      const systemPrompt = 'You are a security-focused code reviewer. Prioritize identifying vulnerabilities.';

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-prompt',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with system prompt',
        goal: {
          template: 'Test goal',
          parameters: []
        },
        systemPrompt
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.systemPrompt).toBe(systemPrompt);
    });

    it('should persist ruleEngineConfig field (deprecated but supported)', async () => {
      const ruleEngineConfig = {
        maxIterations: 10,
        timeout: 5000,
        rules: ['check-security', 'check-performance']
      };

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-rules',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with rule engine',
        goal: {
          template: 'Test goal',
          parameters: []
        },
        ruleEngineConfig
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.ruleEngineConfig).toBeDefined();
      expect(parsedMetadata.ruleEngineConfig).toEqual(ruleEngineConfig);
    });
  });

  describe('Type Preservation', () => {
    it('should not coerce booleans to strings (v1 agent)', async () => {
      // Issue #722: v1 fields only serialize on v1 agents (no goal)
      const metadata: AgentMetadataV2 = {
        name: 'test-agent-boolean',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with boolean',
        learningEnabled: true
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.learningEnabled).toBe(true);
      expect(typeof parsedMetadata.learningEnabled).toBe('boolean');
    });

    it('should not coerce numbers to strings (v1 agent)', async () => {
      // Issue #722: v1 fields only serialize on v1 agents (no goal)
      const metadata: AgentMetadataV2 = {
        name: 'test-agent-number',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with number',
        maxConcurrentGoals: 5
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.maxConcurrentGoals).toBe(5);
      expect(typeof parsedMetadata.maxConcurrentGoals).toBe('number');
    });

    it('should not serialize v1 fields on v2 agents (Issue #722)', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v2-clean',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'V2 agent should not carry v1 baggage',
        goal: {
          template: 'Test goal',
          parameters: []
        },
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      // V2 agent should not have v1 defaults
      expect(parsedMetadata.decisionFramework).toBeUndefined();
      expect(parsedMetadata.riskTolerance).toBeUndefined();
      expect(parsedMetadata.learningEnabled).toBeUndefined();
      expect(parsedMetadata.maxConcurrentGoals).toBeUndefined();
    });

    it('should preserve parameter types in goal config', async () => {
      const goal: AgentGoalConfig = {
        template: 'Process {count} items with {verbose} logging',
        parameters: [
          { name: 'count', type: 'number', required: true, default: 10 },
          { name: 'verbose', type: 'boolean', required: false, default: false }
        ]
      };

      const metadata: AgentMetadataV2 = {
        name: 'test-agent-param-types',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test agent with typed parameters',
        goal
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.goal.parameters[0].default).toBe(10);
      expect(typeof parsedMetadata.goal.parameters[0].default).toBe('number');
      expect(parsedMetadata.goal.parameters[1].default).toBe(false);
      expect(typeof parsedMetadata.goal.parameters[1].default).toBe('boolean');
    });
  });

  describe('Backward Compatibility', () => {
    it('should handle v1 agents without v2 fields', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'test-agent-v1',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test v1 agent',
        decisionFramework: 'rule_based',
        riskTolerance: 'moderate',
        specializations: ['code-review', 'security'],
        triggers: ['analyze', 'review']
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      // v1 fields should be preserved
      expect(parsedMetadata.decisionFramework).toBe('rule_based');
      expect(parsedMetadata.riskTolerance).toBe('moderate');
      expect(parsedMetadata.specializations).toEqual(['code-review', 'security']);
      expect(parsedMetadata.triggers).toEqual(['analyze', 'review']);

      // v2 fields should not be present
      expect(parsedMetadata.goal).toBeUndefined();
      expect(parsedMetadata.activates).toBeUndefined();
      expect(parsedMetadata.tools).toBeUndefined();
      expect(parsedMetadata.systemPrompt).toBeUndefined();
    });

    it('should handle mixed v1 and v2 fields (Issue #722: v1 dropped for v2 agents)', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'test-agent-mixed',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test mixed version agent',
        // v2 fields
        goal: {
          template: 'Test goal',
          parameters: []
        },
        activates: {
          personas: ['reviewer']
        },
        // v1 field (should be dropped since goal is present)
        decisionFramework: 'hybrid',
        // triggers is NOT a v1 field — always serialized
        triggers: ['analyze']
      };

      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };

      const serialized = await (agentManager as any).serializeElement(agent);
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      // V2 fields preserved
      expect(parsedMetadata.goal).toBeDefined();
      expect(parsedMetadata.activates).toBeDefined();
      expect(parsedMetadata.triggers).toEqual(['analyze']);
      // Issue #722: v1 fields dropped for v2 agents
      expect(parsedMetadata.decisionFramework).toBeUndefined();
    });
  });

  describe('Round-Trip Persistence', () => {
    it('should preserve all v2 fields through save/load cycle', async () => {
      const goal: AgentGoalConfig = {
        template: 'Analyze {directory}',
        parameters: [
          { name: 'directory', type: 'string', required: true }
        ],
        successCriteria: ['Analysis complete']
      };

      const activates: AgentActivates = {
        personas: ['reviewer'],
        skills: ['analysis']
      };

      const tools: AgentToolConfig = {
        allowed: ['read_file'],
        denied: ['delete_file']
      };

      const metadata: AgentMetadataV2 = {
        name: 'roundtrip-agent',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Test round-trip persistence',
        goal,
        activates,
        tools,
        systemPrompt: 'Test prompt',
      };

      // Create and serialize
      const agent = new Agent(metadata, metadataService);
      agent.extensions = { instructions: 'Test instructions' };
      const serialized = await (agentManager as any).serializeElement(agent);

      // Parse back and verify all v2 fields
      const parsed = serializationService.parseFrontmatter(serialized);
      const parsedMetadata = parsed.data as AgentMetadataV2;

      expect(parsedMetadata.goal).toEqual(goal);
      expect(parsedMetadata.activates).toEqual(activates);
      expect(parsedMetadata.tools).toEqual(tools);
      expect(parsedMetadata.systemPrompt).toBe('Test prompt');
      // Issue #722: v1 fields (learningEnabled, maxConcurrentGoals) not serialized for v2 agents
      expect(parsedMetadata.learningEnabled).toBeUndefined();
      expect(parsedMetadata.maxConcurrentGoals).toBeUndefined();
    });
  });

  /**
   * Issue #134 - normalizeGoalInput: V1 string → V2 object conversion
   * Tests the private normalizeGoalInput method through direct access
   */
  describe('Goal Normalization (V1 string → V2 object)', () => {
    it('should convert string goal to V2 format', () => {
      // Access private method for testing
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const result = normalizeGoal('Complete the deployment task');

      expect(result).toEqual({
        template: 'Complete the deployment task',
        parameters: []
      });
    });

    it('should preserve V2 object goal format', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const v2Goal: AgentGoalConfig = {
        template: 'Deploy {service} to {env}',
        parameters: [
          { name: 'service', type: 'string', required: true },
          { name: 'env', type: 'string', required: true }
        ],
        successCriteria: ['Service running', 'Health check passing']
      };

      const result = normalizeGoal(v2Goal);

      expect(result).toEqual(v2Goal);
    });

    it('should return undefined for undefined goal', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const result = normalizeGoal(undefined);

      expect(result).toBeUndefined();
    });

    it('should return undefined for null goal', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const result = normalizeGoal(null);

      expect(result).toBeUndefined();
    });

    it('should return undefined for empty string goal', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const result = normalizeGoal('');

      expect(result).toBeUndefined();
    });

    it('should normalize parameters with defaults for partial V2 goal', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const partialGoal = {
        template: 'Process {item}',
        parameters: [
          { name: 'item' }  // Missing type and required
        ]
      };

      const result = normalizeGoal(partialGoal);

      expect(result).toBeDefined();
      expect(result.template).toBe('Process {item}');
      // Should have normalized the parameter with default type
      expect(result.parameters[0]).toEqual(
        expect.objectContaining({
          name: 'item',
          type: 'string',  // default type
          required: false  // default required
        })
      );
    });

    it('should handle parameters with invalid types by defaulting to string', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithInvalidType = {
        template: 'Test {param}',
        parameters: [
          { name: 'param', type: 'invalid_type', required: true }
        ]
      };

      const result = normalizeGoal(goalWithInvalidType);

      expect(result.parameters[0].type).toBe('string'); // Default to string
      expect(result.parameters[0].required).toBe(true); // Preserve required
    });

    it('should handle goal object without template by returning undefined', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithoutTemplate = {
        parameters: [{ name: 'test', type: 'string', required: true }]
      };

      const result = normalizeGoal(goalWithoutTemplate);

      // Should return undefined since template is required
      expect(result).toBeUndefined();
    });

    it('should preserve successCriteria in V2 goal', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithCriteria = {
        template: 'Complete task',
        parameters: [],
        successCriteria: ['Task done', 'No errors']
      };

      const result = normalizeGoal(goalWithCriteria);

      expect(result.successCriteria).toEqual(['Task done', 'No errors']);
    });

    it('should sanitize string default values in parameters', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithDefaults = {
        template: 'Run {command}',
        parameters: [
          {
            name: 'command',
            type: 'string',
            required: false,
            default: '<script>alert("xss")</script>'
          }
        ]
      };

      const result = normalizeGoal(goalWithDefaults);

      // Default should be sanitized (angle brackets stripped)
      expect(result.parameters[0].default).toBeDefined();
      expect(result.parameters[0].default).not.toContain('<script>');
      expect(result.parameters[0].default).not.toContain('</script>');
      // Content without brackets is preserved
      expect(result.parameters[0].default).toContain('alert');
    });

    it('should preserve non-string default values without modification', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithNumericDefaults = {
        template: 'Set count to {count} and enabled to {enabled}',
        parameters: [
          { name: 'count', type: 'number', required: false, default: 42 },
          { name: 'enabled', type: 'boolean', required: false, default: true }
        ]
      };

      const result = normalizeGoal(goalWithNumericDefaults);

      expect(result.parameters[0].default).toBe(42);
      expect(result.parameters[1].default).toBe(true);
    });

    it('should sanitize parameter descriptions', () => {
      const normalizeGoal = (agentManager as any).normalizeGoalInput.bind(agentManager);

      const goalWithDescriptions = {
        template: 'Run {cmd}',
        parameters: [
          {
            name: 'cmd',
            type: 'string',
            required: true,
            description: 'Command to run <script>alert(1)</script>'
          }
        ]
      };

      const result = normalizeGoal(goalWithDescriptions);

      // Description should be sanitized (angle brackets stripped)
      expect(result.parameters[0].description).toBeDefined();
      expect(result.parameters[0].description).not.toContain('<script>');
      expect(result.parameters[0].description).not.toContain('</script>');
    });
  });

  describe('element quality — markdown body (#696)', () => {
    it('generated file contains a markdown body with name and description', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'My Test Agent',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Does useful things autonomously'
      };
      const agent = new Agent(metadata, metadataService);
      // No content set — relies on buildDefaultBody()

      const serialized = await (agentManager as any).serializeElement(agent);

      // Body section must exist after the closing ---
      const parts = serialized.split(/^---\s*$/m);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# My Test Agent');
      expect(body).toContain('Does useful things autonomously');
    });

    it('generated file has H1 heading even with no description', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'Minimal Agent',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user'
        // no description
      };
      const agent = new Agent(metadata, metadataService);

      const serialized = await (agentManager as any).serializeElement(agent);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Minimal Agent');
    });

    it('generates a valid body even when name is empty (MetadataService normalizes to Untitled)', async () => {
      const metadata: AgentMetadataV2 = {
        name: '',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user'
      };
      const agent = new Agent(metadata, metadataService);

      const serialized = await (agentManager as any).serializeElement(agent);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // MetadataService normalizes '' → 'Untitled Agent', so body still has a valid H1
      expect(body).toContain('# Untitled Agent');
      // No broken heading like '#   ' or '# '
      expect(body).not.toMatch(/^#\s*$/m);
    });

    it('preserves explicit content over the default body', async () => {
      const metadata: AgentMetadataV2 = {
        name: 'Agent With Content',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: 'Description text'
      };
      const agent = new Agent(metadata, metadataService);
      agent.content = '# Custom Body\n\nThis is hand-written content.';

      const serialized = await (agentManager as any).serializeElement(agent);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Custom Body');
      expect(body).toContain('hand-written content');
      // Default body should NOT appear alongside the custom body
      expect(body).not.toContain('Description text');
    });

    it('whitespace-only name and description never produce a broken H1', async () => {
      const metadata: AgentMetadataV2 = {
        name: '   ',
        type: ElementType.AGENT,
        version: '1.0.0',
        author: 'test-user',
        description: '   '
      };
      const agent = new Agent(metadata, metadataService);

      const serialized = await (agentManager as any).serializeElement(agent);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // Whitespace-only name: MetadataService normalizes to 'Untitled Agent'
      // buildDefaultBody() trims fields, so never produces a broken '#   '
      expect(body).not.toMatch(/^#\s*$/m);         // No empty heading
      expect(body).not.toMatch(/^#\s{2,}/m);       // No heading with only spaces
      expect(body).toContain('# Untitled Agent');   // Falls back to normalized name
    });
  });

  describe('parseMetadata V2 field validation (Issue #722)', () => {
    /**
     * Helper: call parseMetadata directly (protected method, accessed via type assertion).
     * Returns validated metadata — malformed fields should be stripped.
     */
    async function parseRawMetadata(data: Record<string, unknown>): Promise<any> {
      return (agentManager as any).parseMetadata(data);
    }

    it('should strip goal when goal has no template', async () => {
      const result = await parseRawMetadata({
        name: 'bad-goal', description: 'Test',
        goal: { parameters: [], successCriteria: [] }
      });
      expect(result.goal).toBeUndefined();
    });

    it('should preserve valid goal', async () => {
      const result = await parseRawMetadata({
        name: 'good-goal', description: 'Test',
        goal: { template: 'Do {thing}', parameters: [{ name: 'thing', type: 'string', required: true }], successCriteria: ['Done'] }
      });
      expect(result.goal).toBeDefined();
      expect(result.goal.template).toBe('Do {thing}');
      expect(result.goal.successCriteria).toEqual(['Done']);
    });

    it('should strip goal.parameters when not an array', async () => {
      const result = await parseRawMetadata({
        name: 'bad-params', description: 'Test',
        goal: { template: 'Do {thing}', parameters: 'not-an-array' }
      });
      expect(result.goal).toBeDefined();
      expect(result.goal.template).toBe('Do {thing}');
      expect(result.goal.parameters).toBeUndefined();
    });

    it('should strip activates when it is not an object', async () => {
      const result = await parseRawMetadata({
        name: 'bad-activates', description: 'Test',
        activates: 'not-an-object'
      });
      expect(result.activates).toBeUndefined();
    });

    it('should strip activates entries that are not arrays', async () => {
      const result = await parseRawMetadata({
        name: 'bad-activates-entry', description: 'Test',
        activates: { skills: ['valid-skill'], personas: 'not-an-array' }
      });
      expect(result.activates).toBeDefined();
      expect(result.activates.skills).toEqual(['valid-skill']);
      expect(result.activates.personas).toBeUndefined();
    });

    it('should strip tools when tools.allowed is not an array', async () => {
      const result = await parseRawMetadata({
        name: 'bad-tools', description: 'Test',
        tools: { allowed: 'not-an-array' }
      });
      expect(result.tools).toBeUndefined();
    });

    it('should preserve valid tools', async () => {
      const result = await parseRawMetadata({
        name: 'good-tools', description: 'Test',
        tools: { allowed: ['read_file'], denied: ['write_file'] }
      });
      expect(result.tools).toBeDefined();
      expect(result.tools.allowed).toEqual(['read_file']);
      expect(result.tools.denied).toEqual(['write_file']);
    });

    it('should strip tools.denied when it is not an array (Gap 3)', async () => {
      const result = await parseRawMetadata({
        name: 'bad-denied', description: 'Test',
        tools: { allowed: ['read_file'], denied: 'write_file' }
      });
      expect(result.tools).toBeDefined();
      expect(result.tools.allowed).toEqual(['read_file']);
      expect(result.tools.denied).toBeUndefined();
    });

    it('should strip autonomy.riskTolerance when invalid enum (Gap 4)', async () => {
      const result = await parseRawMetadata({
        name: 'bad-risk', description: 'Test',
        autonomy: { riskTolerance: 'yolo', maxAutonomousSteps: 10 }
      });
      expect(result.autonomy).toBeDefined();
      expect(result.autonomy.riskTolerance).toBeUndefined();
      expect(result.autonomy.maxAutonomousSteps).toBe(10);
    });

    it('should preserve valid autonomy.riskTolerance values', async () => {
      for (const valid of ['conservative', 'moderate', 'aggressive']) {
        const result = await parseRawMetadata({
          name: `risk-${valid}`, description: 'Test',
          autonomy: { riskTolerance: valid }
        });
        expect(result.autonomy.riskTolerance).toBe(valid);
      }
    });

    it('should strip resilience.retryBackoff when invalid enum (Gap 5)', async () => {
      const result = await parseRawMetadata({
        name: 'bad-backoff', description: 'Test',
        resilience: { retryBackoff: 'quadratic', maxRetries: 3 }
      });
      expect(result.resilience).toBeDefined();
      expect(result.resilience.retryBackoff).toBeUndefined();
      expect(result.resilience.maxRetries).toBe(3);
    });

    it('should strip resilience.preserveState when not a boolean (Gap 5)', async () => {
      const result = await parseRawMetadata({
        name: 'bad-preserve', description: 'Test',
        resilience: { preserveState: 'yes', maxRetries: 2 }
      });
      expect(result.resilience).toBeDefined();
      expect(result.resilience.preserveState).toBeUndefined();
      expect(result.resilience.maxRetries).toBe(2);
    });

    it('should preserve valid resilience.retryBackoff and preserveState', async () => {
      const result = await parseRawMetadata({
        name: 'good-resilience-full', description: 'Test',
        resilience: {
          onStepLimitReached: 'pause',
          onExecutionFailure: 'retry',
          maxRetries: 3,
          maxContinuations: 5,
          retryBackoff: 'exponential',
          preserveState: true,
        }
      });
      expect(result.resilience.retryBackoff).toBe('exponential');
      expect(result.resilience.preserveState).toBe(true);
    });

    it('should strip systemPrompt when it is not a string', async () => {
      const result = await parseRawMetadata({
        name: 'bad-prompt', description: 'Test',
        systemPrompt: { nested: 'object' }
      });
      expect(result.systemPrompt).toBeUndefined();
    });

    // Issue #725: snake_case normalization in parseMetadata
    it('should normalize system_prompt to systemPrompt on read (Issue #725)', async () => {
      const result = await parseRawMetadata({
        name: 'snake-prompt', description: 'Test',
        system_prompt: 'You are helpful.',
      });
      expect(result.systemPrompt).toBe('You are helpful.');
      expect(result.system_prompt).toBeUndefined();
    });

    it('should not clobber systemPrompt with system_prompt on read (Issue #725)', async () => {
      const result = await parseRawMetadata({
        name: 'both-prompts', description: 'Test',
        systemPrompt: 'camel wins',
        system_prompt: 'snake loses',
      });
      expect(result.systemPrompt).toBe('camel wins');
      expect(result.system_prompt).toBeUndefined();
    });

    it('should normalize goal.success_criteria to successCriteria on read (Issue #725)', async () => {
      const result = await parseRawMetadata({
        name: 'snake-criteria', description: 'Test',
        goal: { template: 'Do {task}', success_criteria: ['All done'] },
      });
      expect(result.goal.successCriteria).toEqual(['All done']);
      expect((result.goal as any).success_criteria).toBeUndefined();
    });

    it('should not clobber goal.successCriteria with success_criteria on read (Issue #725)', async () => {
      const result = await parseRawMetadata({
        name: 'both-criteria', description: 'Test',
        goal: { template: 'Do {task}', successCriteria: ['camel'], success_criteria: ['snake'] },
      });
      expect(result.goal.successCriteria).toEqual(['camel']);
      expect((result.goal as any).success_criteria).toBeUndefined();
    });

    it('should strip autonomy when it is not an object', async () => {
      const result = await parseRawMetadata({
        name: 'bad-autonomy', description: 'Test',
        autonomy: 'not-an-object'
      });
      expect(result.autonomy).toBeUndefined();
    });

    it('should strip autonomy.maxAutonomousSteps when not a number', async () => {
      const result = await parseRawMetadata({
        name: 'bad-steps', description: 'Test',
        autonomy: { maxAutonomousSteps: 'twenty', requiresApproval: ['delete_*'] }
      });
      expect(result.autonomy).toBeDefined();
      expect(result.autonomy.maxAutonomousSteps).toBeUndefined();
      expect(result.autonomy.requiresApproval).toEqual(['delete_*']);
    });

    it('should strip resilience when it is not an object', async () => {
      const result = await parseRawMetadata({
        name: 'bad-resilience', description: 'Test',
        resilience: 'not-an-object'
      });
      expect(result.resilience).toBeUndefined();
    });

    it('should strip resilience.onStepLimitReached when invalid enum', async () => {
      const result = await parseRawMetadata({
        name: 'bad-resilience-enum', description: 'Test',
        resilience: { onStepLimitReached: 'explode', maxRetries: 3 }
      });
      expect(result.resilience).toBeDefined();
      expect(result.resilience.onStepLimitReached).toBeUndefined();
      expect(result.resilience.maxRetries).toBe(3);
    });

    it('should strip tags when not an array', async () => {
      const result = await parseRawMetadata({
        name: 'bad-tags', description: 'Test',
        tags: 'not-an-array'
      });
      expect(result.tags).toBeUndefined();
    });

    it('should filter non-string values from tags array', async () => {
      const result = await parseRawMetadata({
        name: 'mixed-tags', description: 'Test',
        tags: ['valid', 123, true]
      });
      expect(result.tags).toEqual(['valid']);
    });
  });

  describe('snake_case → camelCase normalization (Issue #722)', () => {
    /**
     * LLMs often pass snake_case keys (risk_tolerance, max_retries) because
     * the schema descriptions use that style. The runtime (autonomyEvaluator,
     * resilienceEvaluator) reads camelCase. parseMetadata must normalize.
     */
    async function parseRawMetadata(data: Record<string, unknown>): Promise<any> {
      return (agentManager as any).parseMetadata(data);
    }

    it('should normalize autonomy snake_case keys to camelCase', async () => {
      const result = await parseRawMetadata({
        name: 'snake-autonomy', description: 'Test',
        autonomy: {
          risk_tolerance: 'conservative',
          max_autonomous_steps: 25,
          requires_approval: ['delete_*'],
          auto_approve: ['read_*'],
        }
      });
      expect(result.autonomy.riskTolerance).toBe('conservative');
      expect(result.autonomy.maxAutonomousSteps).toBe(25);
      expect(result.autonomy.requiresApproval).toEqual(['delete_*']);
      expect(result.autonomy.autoApprove).toEqual(['read_*']);
      // snake_case keys should be removed
      expect(result.autonomy.risk_tolerance).toBeUndefined();
      expect(result.autonomy.max_autonomous_steps).toBeUndefined();
      expect(result.autonomy.requires_approval).toBeUndefined();
      expect(result.autonomy.auto_approve).toBeUndefined();
    });

    it('should normalize resilience snake_case keys to camelCase', async () => {
      const result = await parseRawMetadata({
        name: 'snake-resilience', description: 'Test',
        resilience: {
          on_step_limit_reached: 'pause',
          on_execution_failure: 'retry',
          max_retries: 3,
          max_continuations: 5,
          retry_backoff: 'exponential',
          preserve_state: true,
        }
      });
      expect(result.resilience.onStepLimitReached).toBe('pause');
      expect(result.resilience.onExecutionFailure).toBe('retry');
      expect(result.resilience.maxRetries).toBe(3);
      expect(result.resilience.maxContinuations).toBe(5);
      expect(result.resilience.retryBackoff).toBe('exponential');
      expect(result.resilience.preserveState).toBe(true);
      // snake_case keys should be removed
      expect(result.resilience.on_step_limit_reached).toBeUndefined();
      expect(result.resilience.on_execution_failure).toBeUndefined();
      expect(result.resilience.max_retries).toBeUndefined();
      expect(result.resilience.max_continuations).toBeUndefined();
      expect(result.resilience.retry_backoff).toBeUndefined();
      expect(result.resilience.preserve_state).toBeUndefined();
    });

    it('should prefer existing camelCase over snake_case (no clobber)', async () => {
      const result = await parseRawMetadata({
        name: 'both-cases', description: 'Test',
        autonomy: {
          riskTolerance: 'aggressive',
          risk_tolerance: 'conservative',  // should be ignored since camelCase exists
          maxAutonomousSteps: 50,
          max_autonomous_steps: 10,  // should be ignored
        }
      });
      expect(result.autonomy.riskTolerance).toBe('aggressive');
      expect(result.autonomy.maxAutonomousSteps).toBe(50);
      expect(result.autonomy.risk_tolerance).toBeUndefined();
      expect(result.autonomy.max_autonomous_steps).toBeUndefined();
    });

    it('should validate after normalization (invalid enum still stripped)', async () => {
      const result = await parseRawMetadata({
        name: 'snake-invalid-enum', description: 'Test',
        resilience: {
          on_step_limit_reached: 'explode',  // normalized to camelCase, then fails enum check
          max_retries: 3,
        }
      });
      expect(result.resilience).toBeDefined();
      expect(result.resilience.onStepLimitReached).toBeUndefined(); // stripped by validation
      expect(result.resilience.maxRetries).toBe(3); // valid, preserved
    });
  });

  describe('Issue #727: Write-time V2 field validation', () => {
    // These tests verify that AgentManager.create() rejects invalid V2 fields
    // at write time, preventing silent data corruption.
    //
    // The validation pipeline has TWO layers:
    //   1. AgentElementValidator.validateCreate() — catches camelCase invalid values
    //   2. validateV2FieldsForCreate() — normalizes snake_case, then validates
    // Tests check the end result: create() returns success=false for bad inputs,
    // regardless of which layer catches the error.

    it('should reject invalid autonomy.riskTolerance enum at create time', async () => {
      const result = await agentManager.create(
        'bad-risk-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          autonomy: { riskTolerance: 'yolo' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/risk.?tolerance/i);
      expect(result.message).toContain('yolo');
    });

    it('should reject invalid resilience.onStepLimitReached enum at create time', async () => {
      const result = await agentManager.create(
        'bad-resilience-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          resilience: { onStepLimitReached: 'explode' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/onStepLimitReached/i);
    });

    it('should reject invalid resilience.onExecutionFailure enum at create time', async () => {
      const result = await agentManager.create(
        'bad-failure-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          resilience: { onExecutionFailure: 'crash' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/onExecutionFailure/i);
    });

    it('should reject invalid resilience.retryBackoff enum at create time', async () => {
      const result = await agentManager.create(
        'bad-backoff-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          resilience: { retryBackoff: 'turbo' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/retryBackoff/i);
    });

    it('should reject resilience.preserveState when not a boolean', async () => {
      const result = await agentManager.create(
        'bad-preserve-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          resilience: { preserveState: 'yes' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/preserveState/i);
    });

    it('should reject tools when not an object', async () => {
      const result = await agentManager.create(
        'bad-tools-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          tools: ['read_file', 'write_file'] as any,
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/[Tt]ools.*object/);
    });

    it('should reject tools.allowed when not an array', async () => {
      const result = await agentManager.create(
        'bad-tools-allowed-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          tools: { allowed: 'read_file' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/[Tt]ools.*allowed/);
    });

    it('should reject tools.denied when not an array', async () => {
      const result = await agentManager.create(
        'bad-tools-denied-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          tools: { allowed: ['read_file'], denied: 'write_file' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/[Tt]ools.*denied/i);
    });

    it('should reject systemPrompt when not a string', async () => {
      const result = await agentManager.create(
        'bad-prompt-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          systemPrompt: 42 as any,
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/[Ss]ystem.*[Pp]rompt.*string/);
    });

    it('should reject activates when passed as an array', async () => {
      const result = await agentManager.create(
        'bad-activates-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          activates: ['skill-a'] as any,
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/[Aa]ctivates.*object/);
    });

    it('should reject autonomy.maxAutonomousSteps when not a number', async () => {
      const result = await agentManager.create(
        'bad-steps-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          autonomy: { maxAutonomousSteps: 'many' as any },
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/maxAutonomousSteps/i);
    });

    it('should collect multiple validation errors in one response', async () => {
      const result = await agentManager.create(
        'multi-error-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          autonomy: { riskTolerance: 'yolo' as any },
          resilience: { onStepLimitReached: 'explode' as any, preserveState: 42 as any },
          tools: ['not-an-object'] as any,
        } as any
      );

      expect(result.success).toBe(false);
      // AgentElementValidator collects multiple errors, joined by ", "
      expect(result.message).toMatch(/[Tt]ools/);
      expect(result.message).toMatch(/risk.?tolerance|yolo/i);
    });

    it('should normalize snake_case and accept valid values at create time', async () => {
      // snake_case keys bypass the AgentElementValidator (it only checks camelCase)
      // but validateV2FieldsForCreate normalizes them before validation
      const result = await agentManager.create(
        'snake-case-valid-agent', 'Test agent with snake_case', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          autonomy: { risk_tolerance: 'conservative', max_autonomous_steps: 10 } as any,
          resilience: { on_step_limit_reached: 'pause', retry_backoff: 'exponential' } as any,
        } as any
      );

      expect(result.success).toBe(true);

      // Verify file was written with camelCase keys
      const agentFile = path.join(testDir, 'agents', 'snake-case-valid-agent.md');
      const fileContent = fs.readFileSync(agentFile, 'utf-8');
      expect(fileContent).toContain('riskTolerance:');
      expect(fileContent).toContain('conservative');
      expect(fileContent).toContain('onStepLimitReached:');
      expect(fileContent).toContain('pause');
    });

    it('should normalize snake_case then reject invalid enum values', async () => {
      // risk_tolerance: 'yolo' → normalizes to riskTolerance: 'yolo' → fails enum check
      const result = await agentManager.create(
        'snake-case-invalid-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          autonomy: { risk_tolerance: 'yolo' } as any,
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/riskTolerance/i);
      expect(result.message).toContain('yolo');
    });

    it('should normalize resilience snake_case then reject invalid enum', async () => {
      const result = await agentManager.create(
        'snake-resilience-invalid', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          resilience: { on_step_limit_reached: 'explode' } as any,
        } as any
      );

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/onStepLimitReached/i);
    });

    it('should normalize system_prompt at create time', async () => {
      // system_prompt (snake_case) should be accepted and normalized to systemPrompt
      const result = await agentManager.create(
        'snake-prompt-agent', 'Test agent', 'Instructions',
        {
          goal: { template: 'Do {task}', parameters: [{ name: 'task', type: 'string', required: true }] },
          system_prompt: 'You are a test agent.',
        } as any
      );

      expect(result.success).toBe(true);

      // Verify file was written with camelCase systemPrompt
      const agentFile = path.join(testDir, 'agents', 'snake-prompt-agent.md');
      const fileContent = fs.readFileSync(agentFile, 'utf-8');
      expect(fileContent).toContain('systemPrompt:');
      expect(fileContent).toContain('test agent');
    });

    it('should normalize goal.success_criteria at create time (Issue #725)', async () => {
      const result = await agentManager.create(
        'snake-criteria-agent', 'Test agent', 'Instructions',
        {
          goal: {
            template: 'Do {task}',
            parameters: [{ name: 'task', type: 'string', required: true }],
            success_criteria: ['Task completed'],
          },
        } as any
      );

      expect(result.success).toBe(true);

      // Verify file was written with camelCase successCriteria
      const agentFile = path.join(testDir, 'agents', 'snake-criteria-agent.md');
      const fileContent = fs.readFileSync(agentFile, 'utf-8');
      expect(fileContent).toContain('successCriteria');
      expect(fileContent).toContain('Task completed');
      expect(fileContent).not.toContain('success_criteria');
    });

    it('should accept fully valid V2 agent with all fields', async () => {
      const result = await agentManager.create(
        'fully-valid-v2-agent', 'Complete V2 agent', 'Instructions for the agent',
        {
          goal: {
            template: 'Review {files} for {type}',
            parameters: [
              { name: 'files', type: 'string', required: true },
              { name: 'type', type: 'string', required: true },
            ],
            successCriteria: ['All reviewed'],
          },
          activates: { skills: ['code-review'], personas: ['dev'] },
          tools: { allowed: ['read_file'], denied: ['write_file'] },
          systemPrompt: 'You are a reviewer.',
          autonomy: {
            riskTolerance: 'conservative',
            maxAutonomousSteps: 25,
            requiresApproval: ['delete_*'],
            autoApprove: ['read_*'],
          },
          resilience: {
            onStepLimitReached: 'pause',
            onExecutionFailure: 'retry',
            maxRetries: 3,
            maxContinuations: 5,
            retryBackoff: 'exponential',
            preserveState: true,
          },
        } as any
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('fully-valid-v2-agent');
    });

    it('should allow creation without V2 fields (V1 agent)', async () => {
      const result = await agentManager.create(
        'v1-agent-no-v2-fields', 'V1 agent test', 'Simple instructions',
        {} as any
      );

      expect(result.success).toBe(true);
    });
  });
});
