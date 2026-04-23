/**
 * Unit tests for AgentManager.executeAgent method
 * Tests the 6 scenarios defined in AGENTIC_LOOP_STEP3_MINIMAL_IMPLEMENTATION.md
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
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import type { ExecuteAgentResult } from '../../../../src/elements/agents/types.js';
import { AGENT_LIMITS } from '../../../../src/elements/agents/constants.js';

const metadataService: MetadataService = createTestMetadataService();

describe('AgentManager.executeAgent', () => {
  let agentManager: InstanceType<typeof AgentManager>;
  let testDir: string;
  let portfolioPath: string;
  let mockPortfolioManager: {
    listElements: jest.MockedFunction<() => Promise<string[]>>;
    getElementDir: jest.MockedFunction<(type: ElementType) => string>;
    getBaseDir: jest.MockedFunction<() => string>;
  };
  let container: InstanceType<typeof DollhouseContainer>;
  let fileOperationsService: jest.Mocked<FileOperationsService>;
  let fileStore: Map<string, string>;

  beforeEach(async () => {
    jest.clearAllMocks();
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    // Create temporary test directory
    testDir = path.join(os.tmpdir(), 'agent-execute-test-' + Math.random().toString(36).substring(7));
    portfolioPath = testDir;

    // In-memory file store for write->read round-trip
    fileStore = new Map<string, string>();

    mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(portfolioPath, type)),
      getBaseDir: jest.fn<() => string>(() => portfolioPath)
    };

    container = new DollhouseContainer();
    container.register<PortfolioManager>('PortfolioManager', () => mockPortfolioManager as any);

    // Fix FileLockManager.withLock — use jest.spyOn so the callback actually executes
    const fileLockManager = new FileLockManager();
    jest.spyOn(fileLockManager, 'withLock').mockImplementation(
      async <T>(_key: string, fn: () => Promise<T>) => fn()
    );
    container.register<FileLockManager>('FileLockManager', () => fileLockManager);

    // Mock FileOperationsService with fileStore-backed read/write/exists
    const mockFileOperations = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockImplementation(async (filePath: string) => fileStore.has(filePath)),
      readFile: jest.fn().mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;
        return '';
      }),
      writeFile: jest.fn().mockImplementation(async (filePath: string, content: string) => {
        fileStore.set(filePath, content);
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

    // Create AgentManager instance
    const agentManagerInstance = new AgentManager(
      container.resolve('PortfolioManager'),
      container.resolve('FileLockManager'),
      portfolioPath,
      container.resolve('FileOperationsService'),
      container.resolve('ValidationRegistry'),
      container.resolve('SerializationService'),
      container.resolve('MetadataService')
    );

    // Set up element manager resolver for activating elements (using static method)
    AgentManager.setElementManagerResolver((managerName: string) => {
      if (managerName === 'PersonaManager') {
        return {
          list: async () => {
            // Return mock personas based on what's been "read"
            const personas = [];
            try {
              const content = await fileOperationsService.readFile(
                path.join(portfolioPath, 'personas', 'helpful-assistant.md')
              );
              personas.push({
                metadata: { name: 'helpful-assistant', type: 'persona' },
                content: content.split('---')[2]?.trim() || content
              });
            } catch (_e) {
              // Persona not found
            }
            try {
              const content = await fileOperationsService.readFile(
                path.join(portfolioPath, 'personas', 'code-reviewer.md')
              );
              personas.push({
                metadata: { name: 'code-reviewer', type: 'persona' },
                content: content.split('---')[2]?.trim() || content
              });
            } catch (_e) {
              // Persona not found
            }
            return personas;
          }
        } as any;
      }
      if (managerName === 'SkillManager') {
        return {
          list: async () => {
            const skills = [];
            try {
              const content = await fileOperationsService.readFile(
                path.join(portfolioPath, 'skills', 'code-analysis.md')
              );
              skills.push({
                metadata: { name: 'code-analysis', type: 'skill' },
                instructions: content.split('---')[2]?.trim() || content
              });
            } catch (_e) {
              // Skill not found
            }
            return skills;
          }
        } as any;
      }
      if (managerName === 'MemoryManager') {
        return {
          list: async () => {
            const memories = [];
            try {
              await fileOperationsService.readFile(
                path.join(portfolioPath, 'memories', 'project-context.md')
              );
              memories.push({
                metadata: { name: 'project-context', type: 'memory' },
                getEntries: () => [
                  { key: 'language', value: 'TypeScript' },
                  { key: 'framework', value: 'Node.js' }
                ]
              });
            } catch (_e) {
              // Memory not found
            }
            return memories;
          }
        } as any;
      }
      return null;
    });

    container.register('AgentManager', () => agentManagerInstance);

    agentManager = container.resolve<AgentManager>('AgentManager');
    fileOperationsService = container.resolve<FileOperationsService>('FileOperationsService') as jest.Mocked<FileOperationsService>;

    // Initialize manager
    await agentManager.initialize();
  });

  afterEach(async () => {
    // Reset static resolvers to prevent test isolation issues
    AgentManager.resetResolvers();
    await container.dispose();
  });

  /**
   * Test 1: Happy Path - File Counting
   *
   * Execute hello-world-agent with valid parameters and verify:
   * - Goal is rendered correctly
   * - Active elements are loaded
   * - Available tools are listed
   * - Success criteria are provided
   */
  describe('Test 1: Happy Path - File Counting', () => {
    it('should execute hello-world-agent with valid parameters', async () => {
      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
description: "Minimal agent demonstrating the LLM-first agentic loop"
type: "agent"
version: "2.0.0"
author: "DollhouseMCP"
created: "2025-12-09"
category: "testing"
tags: ["demo", "walking-skeleton", "v2"]

goal:
  template: "List all TypeScript files in the {directory} directory and count them"
  parameters:
    - name: directory
      type: string
      required: true
      description: "Directory path to search"
  successCriteria:
    - "Files are listed"
    - "Count is provided"

activates:
  personas:
    - helpful-assistant

tools:
  allowed:
    - glob
    - read_file

riskTolerance: moderate
maxConcurrentGoals: 5
---

# Hello World Agent

A minimal agent that demonstrates the LLM-first agentic loop architecture.`;
        }

        // Mock helpful-assistant persona
        if (filePath.includes('helpful-assistant.md')) {
          return `---
name: "Helpful Assistant"
type: "persona"
version: "1.0.0"
description: "A helpful AI assistant"
---

# Helpful Assistant

You are a helpful AI assistant.`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src/elements' }
      );

      // Verify response structure
      expect(result).toBeDefined();
      expect(result.agentName).toBe('hello-world-agent');

      // Verify goal rendering
      expect(result.goal).toBe('List all TypeScript files in the src/elements directory and count them');

      // Verify active elements
      expect(result.activeElements).toBeDefined();
      expect(result.activeElements.personas).toBeDefined();
      expect(result.activeElements.personas).toHaveLength(1);
      expect(result.activeElements.personas[0].name).toBe('helpful-assistant');
      expect(result.activeElements.personas[0].content).toContain('helpful AI assistant');

      // Verify available tools
      expect(result.availableTools).toEqual(['glob', 'read_file']);

      // Verify success criteria
      expect(result.successCriteria).toEqual(['Files are listed', 'Count is provided']);

      // Verify security event was logged
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AGENT_EXECUTED',
          source: 'AgentManager.executeAgent',
          details: expect.stringContaining('hello-world-agent')
        })
      );
    });
  });

  /**
   * Test 2: Security Warnings (Advisory)
   *
   * Execute with malicious parameter and verify:
   * - Execution is NOT blocked (advisory only)
   * - Goal is still rendered with malicious input
   *
   * NOTE: Security warnings are not yet implemented in the walking skeleton.
   * The validateGoalSecurity method is private and not called by executeAgent yet.
   * This test verifies that malicious input doesn't block execution (advisory approach).
   */
  describe('Test 2: Security Warnings (Advisory)', () => {
    it('should not block execution even with malicious parameter', async () => {
      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory and count them"
  parameters:
    - name: directory
      type: string
      required: true
  successCriteria:
    - "Files are listed"

tools:
  allowed:
    - glob
---

# Hello World Agent`;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute with malicious parameter
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src && rm -rf /' }
      );

      // Verify execution succeeded (not blocked)
      expect(result).toBeDefined();
      expect(result.agentName).toBe('hello-world-agent');

      // Verify goal was still rendered (advisory approach - doesn't block)
      expect(result.goal).toContain('src && rm -rf /');

      // Security warnings are not yet implemented in the walking skeleton
      // When implemented, this test should be updated to verify warnings are present
      // but execution is not blocked
    });
  });

  /**
   * Test 3: Missing Required Parameter
   *
   * Execute with missing required parameter and verify:
   * - Error is thrown with clear message
   */
  describe('Test 3: Missing Required Parameter', () => {
    it('should throw error when required parameter is missing', async () => {
      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory and count them"
  parameters:
    - name: directory
      type: string
      required: true
  successCriteria:
    - "Files are listed"
---

# Hello World Agent`;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute without required parameter
      await expect(
        agentManager.executeAgent('hello-world-agent', {})
      ).rejects.toThrow(/missing required parameter.*directory/i);
    });

    it('should enumerate all missing goal parameters with introspect guidance', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('rubric-qa-agent.md')) {
          return `---
name: "Rubric QA Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Verify {deliverable_path} against {run_dir}"
  parameters:
    - name: run_dir
      type: string
      required: true
    - name: deliverable_path
      type: string
      required: true
---

# Rubric QA Agent`;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });

      await expect(
        agentManager.executeAgent('rubric-qa-agent', {})
      ).rejects.toThrow(/missing required parameters.*run_dir.*deliverable_path/i);

      await expect(
        agentManager.executeAgent('rubric-qa-agent', {})
      ).rejects.toThrow(/introspect/i);
    });
  });

  /**
   * Test 4: Element-Agnostic Activation
   *
   * Create test agent that activates multiple element types and verify:
   * - All element types are loaded
   * - Context includes contributions from all elements
   */
  describe('Test 4: Element-Agnostic Activation', () => {
    it('should activate multiple element types', async () => {
      // Mock multi-element-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('multi-element-agent.md')) {
          return `---
name: "Multi Element Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Analyze code in {directory}"
  parameters:
    - name: directory
      type: string
      required: true

activates:
  personas:
    - code-reviewer
  skills:
    - code-analysis
  memories:
    - project-context
---

# Multi Element Agent`;
        }

        // Mock code-reviewer persona
        if (filePath.includes('code-reviewer.md')) {
          return `---
name: "Code Reviewer"
type: "persona"
version: "1.0.0"
---

# Code Reviewer

You are an expert code reviewer.`;
        }

        // Mock code-analysis skill
        if (filePath.includes('code-analysis.md')) {
          return `---
name: "Code Analysis"
type: "skill"
version: "1.0.0"
---

# Code Analysis

Analyze code for quality and issues.`;
        }

        // Mock project-context memory
        if (filePath.includes('project-context.md')) {
          return `---
name: "Project Context"
type: "memory"
version: "1.0.0"
entries:
  - key: "language"
    value: "TypeScript"
  - key: "framework"
    value: "Node.js"
---

# Project Context

Project context memory.`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'multi-element-agent',
        { directory: 'src' }
      );

      // Verify all three element types are activated
      expect(result.activeElements).toBeDefined();

      // Verify personas
      expect(result.activeElements.personas).toBeDefined();
      expect(result.activeElements.personas).toHaveLength(1);
      expect(result.activeElements.personas[0].name).toBe('code-reviewer');

      // Verify skills
      expect(result.activeElements.skills).toBeDefined();
      expect(result.activeElements.skills).toHaveLength(1);
      expect(result.activeElements.skills[0].name).toBe('code-analysis');

      // Verify memories
      expect(result.activeElements.memories).toBeDefined();
      expect(result.activeElements.memories).toHaveLength(1);
      expect(result.activeElements.memories[0].name).toBe('project-context');
    });
  });

  /**
   * Test 5: Agent Without Activates (Minimal)
   *
   * Create minimal agent with only goal and verify:
   * - Empty activeElements is returned
   * - Goal still renders correctly
   */
  describe('Test 5: Agent Without Activates (Minimal)', () => {
    it('should handle agent with no activates section', async () => {
      // Mock minimal-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('minimal-agent.md')) {
          return `---
name: "Minimal Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Echo the message: {message}"
  parameters:
    - name: message
      type: string
      required: true
---

# Minimal Agent

Minimal agent with no activates.`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'minimal-agent',
        { message: 'Hello' }
      );

      // Verify response structure
      expect(result).toBeDefined();
      expect(result.agentName).toBe('minimal-agent');

      // Verify goal was rendered
      expect(result.goal).toBe('Echo the message: Hello');

      // Verify empty activeElements
      expect(result.activeElements).toBeDefined();
      expect(Object.keys(result.activeElements)).toHaveLength(0);

      // Verify agent can still function
      expect(result.availableTools).toEqual([]);
      expect(result.successCriteria).toEqual([]);
    });
  });

  /**
   * Test 6: Constraint Blocking (Hard Limit)
   *
   * Set up agent with maxConcurrentGoals limit and verify:
   * - Agent loads with state containing multiple goals
   * - Execution succeeds (constraints not yet implemented in walking skeleton)
   *
   * NOTE: Constraint evaluation is not yet implemented in the walking skeleton.
   * The evaluateConstraints method exists but is not called by executeAgent yet.
   * This test verifies that agents with state can be executed.
   */
  describe('Test 6: Constraint Blocking (Hard Limit)', () => {
    it('should execute agent with existing goals (constraints not yet blocking)', async () => {
      // First, create an agent instance with existing goals
      const agent = new Agent({
        name: 'task-manager',
        description: 'Task management agent',
        maxConcurrentGoals: 5
      }, metadataService);

      // Add 5 goals to reach the limit
      for (let i = 0; i < 5; i++) {
        agent.addGoal({
          description: `Task ${i + 1}`,
          priority: 'medium'
        });
      }

      const state = agent.getState();

      // Mock file reads
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-manager.md')) {
          return `---
name: "Task Manager"
type: "agent"
version: "2.0.0"
maxConcurrentGoals: 5

goal:
  template: "Add task: {task}"
  parameters:
    - name: task
      type: string
      required: true
---

# Task Manager

Manages tasks with concurrency limits.`;
        }

        if (filePath.includes('task-manager.state.yaml')) {
          // Return state with 5 goals
          return `---
goals:
${state.goals.map(g => `  - id: "${g.id}"
    description: "${g.description}"
    priority: "${g.priority}"
    status: "in_progress"
    importance: 5
    urgency: 5
    createdAt: "${g.createdAt.toISOString()}"
    updatedAt: "${g.updatedAt.toISOString()}"`).join('\n')}
decisions: []
context: {}
lastActive: "${state.lastActive.toISOString()}"
sessionCount: 1
---`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute with another task
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'task-manager',
        { task: 'New task' }
      );

      // Verify execution succeeded
      expect(result).toBeDefined();
      expect(result.agentName).toBe('task-manager');
      expect(result.goal).toBe('Add task: New task');

      // Constraints are not yet implemented in the walking skeleton
      // When implemented, this test should verify:
      // - result.constraints.canProceed is false
      // - result.constraints.blockers mentions maxConcurrentGoals
    });

    it('should execute agent with state under limit', async () => {
      // Create agent with only 3 goals (under limit of 5)
      const agent = new Agent({
        name: 'task-manager-under-limit',
        description: 'Task management agent',
        maxConcurrentGoals: 5
      }, metadataService);

      // Add only 3 goals
      for (let i = 0; i < 3; i++) {
        agent.addGoal({
          description: `Task ${i + 1}`,
          priority: 'medium'
        });
      }

      const state = agent.getState();

      // Mock file reads
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        if (filePath.includes('task-manager-under-limit.md')) {
          return `---
name: "Task Manager Under Limit"
type: "agent"
version: "2.0.0"
maxConcurrentGoals: 5

goal:
  template: "Add task: {task}"
  parameters:
    - name: task
      type: string
      required: true
---

# Task Manager

Manages tasks with concurrency limits.`;
        }

        if (filePath.includes('task-manager-under-limit.state.yaml')) {
          return `---
goals:
${state.goals.map(g => `  - id: "${g.id}"
    description: "${g.description}"
    priority: "${g.priority}"
    status: "in_progress"
    importance: 5
    urgency: 5
    createdAt: "${g.createdAt.toISOString()}"
    updatedAt: "${g.updatedAt.toISOString()}"`).join('\n')}
decisions: []
context: {}
lastActive: "${state.lastActive.toISOString()}"
sessionCount: 1
---`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute should succeed
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'task-manager-under-limit',
        { task: 'New task' }
      );

      // Verify execution succeeded
      expect(result).toBeDefined();
      expect(result.agentName).toBe('task-manager-under-limit');
      expect(result.goal).toBe('Add task: New task');

      // Constraints are not yet implemented in the walking skeleton
      // When implemented, this test should verify:
      // - result.constraints.canProceed is true
      // - result.constraints.blockers is empty
    });
  });

  /**
   * Additional Test: Non-existent Agent
   *
   * Verify proper error handling for missing agents
   */
  describe('Error Handling', () => {
    it('should throw error for non-existent agent', async () => {
      fileOperationsService.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(
        agentManager.executeAgent('non-existent-agent', {})
      ).rejects.toThrow();
    });

    it('should auto-convert V1 agent to V2 and require objective parameter', async () => {
      // V1 agents (without goal.template) are auto-converted to V2 with a default 'objective' parameter
      // The conversion happens on execution, so if no objective is provided, it throws
      fileOperationsService.readFile.mockResolvedValue(`---
name: "Invalid Agent"
type: "agent"
---

Missing goal configuration`);

      // With V1→V2 auto-conversion, the agent now requires the 'objective' parameter
      await expect(
        agentManager.executeAgent('invalid-agent', {})
      ).rejects.toThrow(/objective/i);
    });

    // Note: Full V1→V2 auto-conversion execution test is covered in integration tests
    // because it involves file operations (in-place V1→V2 upgrade, state hydration, etc.)
    // The unit test above verifies the conversion happens and the parameter is required.
  });

  /**
   * Test 7: Goal Persistence in executeAgent
   *
   * Tests for PR #140: Fix goal persistence in executeAgent for functional agentic loop
   *
   * Verify that:
   * - Goal is persisted (not temporary)
   * - goalId is returned in the result
   * - Goal status is set to 'in_progress'
   * - Goal can be found by subsequent operations (e.g., record_agent_step)
   */
  describe('Test 7: Goal Persistence in executeAgent', () => {
    it('should return goalId in ExecuteAgentResult', async () => {
      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        // Check fileStore first for round-tripped writes
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory"
  parameters:
    - name: directory
      type: string
      required: true
---

# Hello World Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src' }
      );

      // Verify goalId is present in result
      expect(result.goalId).toBeDefined();
      expect(typeof result.goalId).toBe('string');
      // Goal IDs use format: goal_<timestamp>_<random>
      expect(result.goalId).toMatch(/^goal_\d+_[a-z0-9]+$/);
    });

    it('should persist goal with in_progress status', async () => {
      // Track the saved agent state
      let savedAgent: Agent | null = null;

      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        // Check fileStore first for round-tripped writes
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory"
  parameters:
    - name: directory
      type: string
      required: true
---

# Hello World Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Intercept save to capture the agent state
      const originalSave = agentManager.save.bind(agentManager);
      jest.spyOn(agentManager, 'save').mockImplementation(async (agent: Agent, filename: string) => {
        savedAgent = agent;
        return originalSave(agent, filename);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src' }
      );

      // Verify agent was saved
      expect(savedAgent).not.toBeNull();
      expect(agentManager.save).toHaveBeenCalled();

      // Verify the saved agent has a goal with the returned ID
      const state = savedAgent!.getState();
      const persistedGoal = state.goals.find(g => g.id === result.goalId);

      expect(persistedGoal).toBeDefined();
      expect(persistedGoal!.status).toBe('in_progress');
      expect(persistedGoal!.description).toContain('List all TypeScript files in the src directory');
    });

    it('should allow goal to be found by subsequent operations', async () => {
      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        // Check fileStore first for round-tripped writes
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory"
  parameters:
    - name: directory
      type: string
      required: true
---

# Hello World Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Execute the agent
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src' }
      );

      // Verify goalId is returned
      expect(result.goalId).toBeDefined();

      // Now read the agent back to verify the goal is persisted
      const agent = await agentManager.read('hello-world-agent');
      expect(agent).toBeDefined();

      const state = agent!.getState();
      const foundGoal = state.goals.find(g => g.id === result.goalId);

      // Verify the goal exists and is accessible
      expect(foundGoal).toBeDefined();
      expect(foundGoal!.status).toBe('in_progress');
      expect(foundGoal!.description).toContain('List all TypeScript files in the src directory');
    });

    it('should create goal before returning result (not temporary)', async () => {
      let goalCreatedBeforeReturn = false;

      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        // Check fileStore first for round-tripped writes
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Count files in {directory}"
  parameters:
    - name: directory
      type: string
      required: true
---

# Hello World Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Intercept save to verify goal exists
      const originalSave = agentManager.save.bind(agentManager);
      jest.spyOn(agentManager, 'save').mockImplementation(async (agent: Agent, filename: string) => {
        const state = agent.getState();
        goalCreatedBeforeReturn = state.goals.length > 0;
        return originalSave(agent, filename);
      });

      // Execute the agent
      await agentManager.executeAgent('hello-world-agent', { directory: 'src' });

      // Verify goal was created before the method returned
      expect(goalCreatedBeforeReturn).toBe(true);
      expect(agentManager.save).toHaveBeenCalled();
    });

    it('should handle goal persistence workflow: execute -> record_agent_step -> goal found', async () => {
      // This test simulates the full agentic loop workflow
      // 1. executeAgent creates and persists goal
      // 2. LLM performs work
      // 3. record_agent_step finds the goal to update

      // Mock the hello-world-agent file
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        // Check fileStore first for round-tripped writes
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('hello-world-agent.md')) {
          return `---
name: "Hello World Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "List all TypeScript files in the {directory} directory"
  parameters:
    - name: directory
      type: string
      required: true
---

# Hello World Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Step 1: executeAgent creates the goal
      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'hello-world-agent',
        { directory: 'src' }
      );

      expect(result.goalId).toBeDefined();

      // Step 2: Simulate LLM receiving the goalId
      const goalIdForLLM = result.goalId;
      expect(goalIdForLLM).toBeDefined();

      // Step 3: Reload the agent (simulating a subsequent operation like record_agent_step)
      const agent = await agentManager.read('hello-world-agent');
      expect(agent).toBeDefined();

      const state = agent!.getState();
      const goal = state.goals.find(g => g.id === goalIdForLLM);

      // Verify the goal can be found and has the correct state
      expect(goal).toBeDefined();
      expect(goal!.status).toBe('in_progress');
      expect(goal!.description).toContain('List all TypeScript files in the src directory');

      // This confirms the agentic loop can proceed:
      // - executeAgent persists the goal
      // - LLM gets the goalId
      // - record_agent_step can find and update the goal
    });
  });

  /**
   * Test 8: Activation Warnings (#116)
   *
   * Verify that element activation failures are surfaced in the result
   * rather than silently swallowed.
   */
  describe('Test 8: Activation Warnings (#116)', () => {
    it('should include activationWarnings when an element fails to activate', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('warn-agent.md')) {
          return `---
name: "Warn Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true

activates:
  personas:
    - nonexistent-persona
---

# Warn Agent`;
        }

        // The nonexistent persona will cause getElementContent to throw
        throw new Error(`Element not found: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'warn-agent',
        { task: 'something' }
      );

      expect(result).toBeDefined();
      expect(result.agentName).toBe('warn-agent');
      expect(result.activationWarnings).toBeDefined();
      expect(result.activationWarnings).toHaveLength(1);
      expect(result.activationWarnings![0].elementType).toBe('personas');
      expect(result.activationWarnings![0].elementName).toBe('nonexistent-persona');
      expect(result.activationWarnings![0].error).toBeDefined();
      expect(typeof result.activationWarnings![0].error).toBe('string');
    });

    it('should still activate other elements when one fails (partial failure)', async () => {
      // Set up element manager resolver that succeeds for code-reviewer but fails for nonexistent
      AgentManager.resetResolvers();
      AgentManager.setElementManagerResolver((managerName: string) => {
        if (managerName === 'PersonaManager') {
          return {
            list: async () => [
              {
                metadata: { name: 'code-reviewer', type: 'persona' },
                content: 'You are an expert code reviewer.'
              }
            ]
          } as any;
        }
        return null;
      });

      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('partial-agent.md')) {
          return `---
name: "Partial Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Review {target}"
  parameters:
    - name: target
      type: string
      required: true

activates:
  personas:
    - code-reviewer
    - nonexistent-persona
---

# Partial Agent`;
        }

        if (filePath.includes('code-reviewer.md')) {
          return `---
name: "Code Reviewer"
type: "persona"
version: "1.0.0"
---

# Code Reviewer

You are an expert code reviewer.`;
        }

        throw new Error(`Element not found: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'partial-agent',
        { target: 'src' }
      );

      // The successful persona should still be activated
      expect(result.activeElements.personas).toBeDefined();
      expect(result.activeElements.personas.some(p => p.name === 'code-reviewer')).toBe(true);

      // The failure should be in warnings
      expect(result.activationWarnings).toBeDefined();
      expect(result.activationWarnings!.some(w => w.elementName === 'nonexistent-persona')).toBe(true);
    });

    it('should not include activationWarnings when all activations succeed', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('success-agent.md')) {
          return `---
name: "Success Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true
---

# Success Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'success-agent',
        { task: 'something' }
      );

      expect(result.activationWarnings).toBeUndefined();
    });

    it('should still throw on circular activation errors', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('circular-agent.md')) {
          return `---
name: "Circular Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true

activates:
  agents:
    - circular-agent
---

# Circular Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      await expect(
        agentManager.executeAgent('circular-agent', { task: 'loop' })
      ).rejects.toThrow(/[Cc]ircular/);
    });

    it('should collect warnings from multiple element types', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('multi-fail-agent.md')) {
          return `---
name: "Multi Fail Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true

activates:
  personas:
    - missing-persona
  skills:
    - missing-skill
---

# Multi Fail Agent`;
        }

        throw new Error(`Element not found: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'multi-fail-agent',
        { task: 'test' }
      );

      expect(result.activationWarnings).toBeDefined();
      expect(result.activationWarnings).toHaveLength(2);
      expect(result.activationWarnings!.some(w => w.elementType === 'personas')).toBe(true);
      expect(result.activationWarnings!.some(w => w.elementType === 'skills')).toBe(true);
    });

    it('should truncate rendered goal when parameter value is extremely long', async () => {
      const longValue = 'x'.repeat(AGENT_LIMITS.MAX_RENDERED_GOAL_LENGTH + 100);

      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('long-goal-agent.md')) {
          return `---
name: "Long Goal Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Process: {data}"
  parameters:
    - name: data
      type: string
      required: true
---

# Long Goal Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'long-goal-agent',
        { data: longValue }
      );

      expect(result).toBeDefined();
      expect(result.goal.length).toBeLessThanOrEqual(AGENT_LIMITS.MAX_RENDERED_GOAL_LENGTH);
    });

    it('should handle parameter keys containing regex metacharacters', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('regex-key-agent.md')) {
          return `---
name: "Regex Key Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Process {data.input} items"
  parameters:
    - name: "data.input"
      type: string
      required: true
---

# Regex Key Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'regex-key-agent',
        { 'data.input': '42' }
      );

      expect(result).toBeDefined();
      // The dot in "data.input" should be escaped so {data.input} is replaced, not {dataxinput}
      expect(result.goal).toBe('Process 42 items');
    });

    it('should create empty array for element type when all activations fail', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('all-fail-agent.md')) {
          return `---
name: "All Fail Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true

activates:
  personas:
    - missing-one
    - missing-two
---

# All Fail Agent`;
        }

        throw new Error(`Element not found: ${filePath}`);
      });

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'all-fail-agent',
        { task: 'test' }
      );

      expect(result.activeElements.personas).toBeDefined();
      expect(result.activeElements.personas).toEqual([]);
      expect(result.activationWarnings).toHaveLength(2);
    });

    it('should handle non-Error thrown values in activation warnings', async () => {
      fileOperationsService.readFile.mockImplementation(async (filePath: string) => {
        const stored = fileStore.get(filePath);
        if (stored !== undefined) return stored;

        if (filePath.includes('string-error-agent.md')) {
          return `---
name: "String Error Agent"
type: "agent"
version: "2.0.0"

goal:
  template: "Do {task}"
  parameters:
    - name: task
      type: string
      required: true

activates:
  personas:
    - bad-persona
---

# String Error Agent`;
        }

        throw new Error(`Unexpected file read: ${filePath}`);
      });

      // Spy on getElementContent to throw a plain string (non-Error)
      const getElementContentSpy = jest.spyOn(agentManager as any, 'getElementContent');
      getElementContentSpy.mockRejectedValueOnce('plain string error');

      const result: ExecuteAgentResult = await agentManager.executeAgent(
        'string-error-agent',
        { task: 'test' }
      );

      expect(result.activationWarnings).toBeDefined();
      expect(result.activationWarnings).toHaveLength(1);
      expect(result.activationWarnings![0].error).toBe('plain string error');

      getElementContentSpy.mockRestore();
    });
  });
});
