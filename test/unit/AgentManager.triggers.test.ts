/**
 * Unit tests for Agent trigger extraction (Issue #1123)
 * Following pattern from SkillManager.triggers.test.ts and MemoryManager.triggers.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AgentManager } from '../../src/elements/agents/AgentManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../src/utils/logger.js';

// Mock dependencies
jest.mock('../../src/security/fileLockManager.js');
jest.mock('../../src/security/securityMonitor.js');
jest.mock('../../src/utils/logger.js');

describe('AgentManager - Trigger Extraction', () => {
  let agentManager: AgentManager;
  let tempDir: string;
  let agentsDir: string;
  let testAgentPath: string;
  let portfolioManager: PortfolioManager;
  let loggerWarnMock: jest.Mock;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-trigger-test-'));

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;

    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
    portfolioManager = PortfolioManager.getInstance();
    await portfolioManager.initialize();

    // Get agents directory
    agentsDir = portfolioManager.getElementDir(ElementType.AGENT);

    // Ensure agents directory exists
    await fs.mkdir(agentsDir, { recursive: true });

    // Create agent manager
    agentManager = new AgentManager(tempDir);

    // Set up mocks
    jest.clearAllMocks();

    // Mock FileLockManager - make atomicWriteFile actually write the file
    (FileLockManager as any).atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    });
    (FileLockManager as any).atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    });

    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    // Mock logger.warn to track warning logs
    loggerWarnMock = jest.fn();
    (logger as any).warn = loggerWarnMock;

    testAgentPath = 'test-agent.md';
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  describe('Loading Agents with Triggers', () => {
    it('should extract triggers from agent frontmatter', async () => {
      const agentContent = `---
name: Task Automator
description: Automates complex task workflows
version: 1.0.0
decisionFramework: rule_based
riskTolerance: moderate
triggers:
  - automate
  - orchestrate
  - delegate
  - schedule
---

# Instructions
This agent automates complex task workflows.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      expect(agent.metadata.triggers).toBeDefined();
      expect(agent.metadata.triggers).toEqual(['automate', 'orchestrate', 'delegate', 'schedule']);
    });

    it('should handle agents without triggers', async () => {
      const agentContent = `---
name: Simple Agent
description: A basic agent without triggers
version: 1.0.0
---

# Instructions
Basic agent content.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      expect(agent.metadata.triggers).toBeUndefined();
    });

    it('should sanitize and validate triggers', async () => {
      const agentContent = `---
name: Agent With Mixed Triggers
description: Agent with valid and invalid triggers
version: 1.0.0
triggers:
  - valid-trigger
  - "invalid trigger with spaces"
  - another_valid
  - "123-starts-with-number"
  - "@#$%^&*()"
  - valid123
---

# Instructions
Agent with mixed triggers.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // Should only include valid triggers
      expect(agent.metadata.triggers).toBeDefined();
      expect(agent.metadata.triggers).toEqual([
        'valid-trigger',
        'another_valid',
        '123-starts-with-number',
        'valid123'
      ]);

      // Should have logged warnings for invalid triggers
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('Rejected 2 invalid trigger(s)'),
        expect.objectContaining({
          agentName: 'Agent With Mixed Triggers',
          rejectedTriggers: expect.arrayContaining([
            expect.stringContaining('invalid trigger with spaces')
          ]),
          acceptedCount: 4
        })
      );
    });

    it('should enforce maximum trigger count', async () => {
      const triggers = Array.from({ length: 25 }, (_, i) => `trigger-${i + 1}`);
      const agentContent = `---
name: Agent With Many Triggers
description: Agent with too many triggers
version: 1.0.0
triggers:
${triggers.map(t => `  - ${t}`).join('\n')}
---

# Instructions
Agent with many triggers.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // Should be limited to 20 triggers
      expect(agent.metadata.triggers).toBeDefined();
      expect(agent.metadata.triggers).toHaveLength(20);
      expect(agent.metadata.triggers).toEqual(triggers.slice(0, 20));

      // Should have logged warning about truncation
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('Trigger count exceeds limit (25 > 20)'),
        expect.objectContaining({
          agentName: 'Agent With Many Triggers',
          totalTriggers: 25,
          truncatedTriggers: triggers.slice(20)
        })
      );
    });

    it('should preserve triggers when saving agent', async () => {
      const agentContent = `---
name: Persistent Triggers Agent
description: Agent to test trigger persistence
version: 1.0.0
triggers:
  - persist
  - save
  - maintain
---

# Instructions
Testing trigger persistence.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);

      // Load the agent
      const agent = await agentManager.load(testAgentPath);
      expect(agent.metadata.triggers).toEqual(['persist', 'save', 'maintain']);

      // Update the agent (change description)
      agent.metadata.description = 'Updated description';
      await agentManager.save(agent, 'test-agent'); // Pass name without extension

      // Reload and verify triggers are preserved
      const reloadedAgent = await agentManager.load(testAgentPath);
      expect(reloadedAgent.metadata.triggers).toEqual(['persist', 'save', 'maintain']);
      expect(reloadedAgent.metadata.description).toBe('Updated description');
    });

    it('should handle empty trigger after sanitization', async () => {
      const agentContent = `---
name: Agent With Empty Triggers
description: Agent with triggers that become empty after sanitization
version: 1.0.0
triggers:
  - "   "
  - ""
  - valid-trigger
  - "!@#$%"
---

# Instructions
Testing empty triggers.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // Should only have the valid trigger
      expect(agent.metadata.triggers).toEqual(['valid-trigger']);

      // Should have logged warnings
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('Rejected 3 invalid trigger(s)'),
        expect.objectContaining({
          agentName: 'Agent With Empty Triggers',
          rejectedTriggers: expect.arrayContaining([
            expect.stringContaining('empty after sanitization')
          ])
        })
      );
    });


    it('should export agent with triggers to JSON format', async () => {
      const agentContent = `---
name: Export Test Agent
description: Agent for export testing
version: 1.0.0
triggers:
  - export
  - transform
---

# Instructions
Export test.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // Export to JSON
      const exported = await agentManager.exportElement(agent, 'json');
      const parsed = JSON.parse(exported);

      expect(parsed.metadata.triggers).toEqual(['export', 'transform']);
    });

    it('should export agent with triggers to markdown format', async () => {
      const agentContent = `---
name: Markdown Export Agent
description: Agent for markdown export testing
version: 1.0.0
triggers:
  - markdown
  - export
---

# Instructions
Markdown export test.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // Export to markdown
      const exported = await agentManager.exportElement(agent, 'markdown');

      // Verify triggers are in the exported frontmatter
      expect(exported).toContain('triggers:');
      expect(exported).toContain('- markdown');
      expect(exported).toContain('- export');
    });
  });

  describe('Trigger Validation Edge Cases', () => {
    it('should handle triggers with only hyphens and underscores', async () => {
      const agentContent = `---
name: Special Char Agent
description: Agent with special character triggers
version: 1.0.0
triggers:
  - valid-with-hyphens
  - valid_with_underscores
  - valid-mix_of-both_123
  - 123_numbers-ok_456
---

# Instructions
Special characters test.`;

      await fs.writeFile(path.join(agentsDir, testAgentPath), agentContent);
      const agent = await agentManager.load(testAgentPath);

      // All should be valid
      expect(agent.metadata.triggers).toEqual([
        'valid-with-hyphens',
        'valid_with_underscores',
        'valid-mix_of-both_123',
        '123_numbers-ok_456'
      ]);
    });
  });
});