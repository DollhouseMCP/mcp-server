/**
 * Unit tests for AgentManager implementation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the security modules before importing anything that uses them
jest.mock('../../../../../src/security/fileLockManager.js');
jest.mock('../../../../../src/security/securityMonitor.js');
jest.mock('../../../../../src/utils/logger.js');

// Import after mocking
import { AgentManager } from '../../../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../../../src/elements/agents/Agent.js';
import { AgentMetadata } from '../../../../../src/elements/agents/types.js';
import { ElementType } from '../../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';

describe('AgentManager', () => {
  let agentManager: AgentManager;
  let testDir: string;
  let portfolioPath: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
    portfolioPath = testDir;
    agentManager = new AgentManager(portfolioPath);
    
    // Initialize manager
    await agentManager.initialize();

    // Set up mocks
    jest.clearAllMocks();
    
    // Set default mock implementations by assigning functions directly
    (FileLockManager as any).atomicWriteFile = jest.fn().mockResolvedValue(undefined);
    (FileLockManager as any).atomicReadFile = jest.fn().mockResolvedValue('');
    (FileLockManager as any).withLock = jest.fn((resource: string, operation: () => Promise<any>) => operation());
    (SecurityMonitor as any).logSecurityEvent = jest.fn();
    
    // Mock fs.open for atomic file creation
    const mockFileHandle = {
      writeFile: jest.fn(() => Promise.resolve()),
      close: jest.fn(() => Promise.resolve())
    };
    jest.spyOn(fs, 'open').mockResolvedValue(mockFileHandle as any);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Initialization', () => {
    it('should create agents directory structure', async () => {
      const agentsPath = path.join(portfolioPath, 'agent');
      const statePath = path.join(agentsPath, '.state');

      const agentsDirExists = await fs.access(agentsPath).then(() => true).catch(() => false);
      const stateDirExists = await fs.access(statePath).then(() => true).catch(() => false);

      expect(agentsDirExists).toBe(true);
      expect(stateDirExists).toBe(true);
    });
  });

  describe('Create', () => {
    it('should create a new agent', async () => {
      const result = await agentManager.create(
        'test-agent',
        'A test agent',
        'Agent instructions here',
        {
          specializations: ['testing'],
          decisionFramework: 'rule_based'
        }
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('test-agent');
      expect(result.element).toBeInstanceOf(Agent);
      expect(fs.open).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        'wx'
      );
    });

    it('should reject invalid agent names', async () => {
      const result = await agentManager.create(
        'invalid name!',
        'Description',
        'Content'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid agent name');
    });

    it('should detect existing agents', async () => {
      // First create should succeed
      const firstResult = await agentManager.create('duplicate', 'First', 'Content');
      expect(firstResult.success).toBe(true);
      
      // Mock fs.open to throw EEXIST error for duplicate
      jest.spyOn(fs, 'open').mockRejectedValueOnce({ code: 'EEXIST' });

      // Try to create duplicate
      const result = await agentManager.create('duplicate', 'Second', 'Content');

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should log security event on creation', async () => {
      await agentManager.create('new-agent', 'Description', 'Content');

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
    beforeEach(async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(`---
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
      const agent = await agentManager.read('test-agent');

      expect(agent).not.toBeNull();
      expect(agent?.metadata.name).toBe('test-agent');
      expect(agent?.extensions?.decisionFramework).toBe('rule_based');
    });

    it('should return null for non-existent agent', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockRejectedValue({ code: 'ENOENT' });

      const agent = await agentManager.read('non-existent');
      expect(agent).toBeNull();
    });

    it('should reject oversized files', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockResolvedValue('x'.repeat(200 * 1024)); // 200KB

      await expect(agentManager.read('huge-agent'))
        .rejects.toThrow('exceeds maximum size');
    });

    it('should load agent state if available', async () => {
      // Mock both agent file and state file
      (FileLockManager.atomicReadFile as jest.Mock)
        .mockImplementation(async (path: string) => {
          if (path.includes('.state.yaml')) {
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
        });

      const agent = await agentManager.read('test-agent');
      const state = agent?.getState();

      // Note: sessionCount is stored as string in YAML and parsed back as number
      expect(state?.sessionCount).toBe(5);
      expect(state?.context.key).toBe('value');
    });
  });

  describe('Update', () => {
    it('should update agent metadata', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(`---
name: test-agent
description: Old description
---
Content`);

      const success = await agentManager.update('test-agent', {
        description: 'New description',
        specializations: ['updated', 'skills']
      });

      expect(success).toBe(true);
      expect(FileLockManager.atomicWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('New description'),
        expect.any(Object)
      );
    });

    it('should return false for non-existent agent', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockRejectedValue({ code: 'ENOENT' });

      const success = await agentManager.update('non-existent', {
        description: 'New'
      });

      expect(success).toBe(false);
    });

    it('should save agent state if dirty', async () => {
      // Create a mock agent with dirty state
      const agent = new Agent({ name: 'test-agent' });
      agent.addGoal({ description: 'New goal' }); // This makes state dirty
      
      // Mock the read to return our agent
      (FileLockManager.atomicReadFile as jest.Mock).mockImplementation(async () => {
        return `---
name: test-agent
---
Content`;
      });
      
      // Mock the manager's read method to return our agent
      jest.spyOn(agentManager, 'read').mockResolvedValue(agent);

      await agentManager.update('test-agent', {});

      // Should have written both the agent file and state file
      expect(FileLockManager.atomicWriteFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('Delete', () => {
    it('should delete agent and state files', async () => {
      const mockUnlink = jest.spyOn(fs, 'unlink').mockResolvedValue();
      const mockAccess = jest.spyOn(fs, 'access').mockResolvedValue();

      await agentManager.delete('test-agent');

      expect(mockUnlink).toHaveBeenCalledTimes(2); // Main file + state file
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md')
      );
      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.state.yaml')
      );
    });

    it('should log security event on deletion', async () => {
      const mockUnlink = jest.spyOn(fs, 'unlink').mockResolvedValue();
      const mockAccess = jest.spyOn(fs, 'access').mockResolvedValue();

      await agentManager.delete('test-agent');

      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_DELETED',
          severity: 'MEDIUM',
          details: expect.stringContaining('test-agent')
        })
      );
    });

    it('should not throw if agent does not exist', async () => {
      const mockAccess = jest.spyOn(fs, 'access').mockRejectedValue({ code: 'ENOENT' });

      await expect(agentManager.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('List', () => {
    it('should list all agents', async () => {
      const mockReaddir = jest.spyOn(fs, 'readdir').mockResolvedValue([
        'agent1.md',
        'agent2.md',
        '.hidden.md', // Should be ignored
        'not-agent.txt', // Should be ignored
        '.state' // Should be ignored
      ] as any);

      (FileLockManager.atomicReadFile as jest.Mock).mockImplementation(async (path) => {
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
      });

      const agents = await agentManager.list();

      expect(agents).toHaveLength(2);
      expect(agents[0].metadata.name).toBe('agent1');
      expect(agents[1].metadata.name).toBe('agent2');
    });

    it('should handle read errors gracefully', async () => {
      const mockReaddir = jest.spyOn(fs, 'readdir').mockResolvedValue(['bad.md'] as any);
      (FileLockManager.atomicReadFile as jest.Mock).mockRejectedValue(new Error('Read error'));

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
      expect(agentManager.validatePath('C:\\windows')).toBe(false);
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
    });

    it('should export agent to JSON', async () => {
      const agent = new Agent({
        name: 'export-test',
        description: 'Test export'
      });
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
      });

      const exported = await agentManager.exportElement(agent, 'markdown');

      expect(exported).toContain('---');
      expect(exported).toContain('name: export-test');
      expect(exported).toContain('# export-test');
    });
  });

  describe('State Management', () => {
    it('should save agent state', async () => {
      const state = {
        goals: [],
        decisions: [],
        context: { test: 'value' },
        lastActive: new Date().toISOString(),
        sessionCount: 1
      };

      await agentManager.saveAgentState('test-agent', state as any);

      // Check that the path contains the expected components (cross-platform)
      const firstCallArgs = (FileLockManager.atomicWriteFile as jest.Mock).mock.calls[0];
      const filePath = firstCallArgs[0];
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

      await expect(agentManager.saveAgentState('test-agent', hugeState as any))
        .rejects.toThrow('exceeds maximum');
    });

    it('should cache loaded state', async () => {
      let callCount = 0;
      (FileLockManager.atomicReadFile as jest.Mock)
        .mockImplementation(async (path: string) => {
          callCount++;
          if (path.includes('.state.yaml')) {
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
        });

      // First read loads from file
      await agentManager.read('test-agent');
      const firstCallCount = callCount;
      expect(firstCallCount).toBe(2); // Agent file + state file

      // Second read should use cache
      await agentManager.read('test-agent');
      expect(callCount).toBe(3); // Only agent file read again
    });
  });

  describe('Error Handling', () => {
    it('should handle file parse errors', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockResolvedValue('Invalid YAML content');

      await expect(agentManager.read('bad-agent'))
        .rejects.toThrow('Invalid agent file format');
    });

    it('should validate element type in files', async () => {
      (FileLockManager.atomicReadFile as jest.Mock).mockResolvedValue(`---
name: wrong-type
type: persona
---
Content`);

      await expect(agentManager.read('wrong-type'))
        .rejects.toThrow("Invalid element type: expected 'agent', got 'persona'");
    });
  });
});