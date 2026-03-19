import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';

import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Delete Element Handler (server lifecycle)', () => {
  let env: PortfolioTestEnvironment;
  let server: InstanceType<typeof DollhouseMCPServer>;
  let agentsDir: string;
  const agentInstructions = 'Follow standard protocol.';
  const agentContent = '# Agent Reference\n\nProtocol documentation.';
  const agentDescription = 'Integration test agent';

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('delete-handler');

    // Create container after env var is set, so it picks up the test directory
    const container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    // Trigger the server's lazy initialization. This will also initialize the portfolio.
    await server.listPersonas();

    agentsDir = path.join(env.testDir, ElementType.AGENT);
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('data file handling', () => {
    it('prompts when associated data exists and deleteData is undefined', async () => {
      const agentName = 'agent-with-state';
      await server.createElement({
        name: agentName,
        type: ElementType.AGENT,
        description: agentDescription,
        instructions: agentInstructions,
        content: agentContent,
      });
      const stateDir = path.join(agentsDir, '.state');
      await fs.mkdir(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, `${agentName}-state.json`);
      await fs.writeFile(stateFile, JSON.stringify({ status: 'active' }), 'utf-8');

      const result = await server.deleteElement({
        name: 'agent-with-state',
        type: ElementType.AGENT
      });

      const text = result.content[0].text;
      expect(text).toContain('⚠️  This agent has associated data files');
      expect(text).toContain('.state/agent-with-state-state.json');
      // Should not delete file without explicit confirmation
      await expect(fs.access(stateFile)).resolves.toBeUndefined();
    });

    it('preserves data files when deleteData is false', async () => {
      const agentName = 'agent-with-data';
      await server.createElement({
        name: agentName,
        type: ElementType.AGENT,
        description: agentDescription,
        instructions: agentInstructions,
        content: agentContent,
      });
      const stateDir = path.join(agentsDir, '.state');
      await fs.mkdir(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, `${agentName}-state.json`);
      await fs.writeFile(stateFile, JSON.stringify({ status: 'active' }), 'utf-8');

      const result = await server.deleteElement({
        name: 'agent-with-data',
        type: ElementType.AGENT,
        deleteData: false,
      });

      const text = result.content[0].text;
      expect(text).toContain('✅ Successfully deleted agent \'agent-with-data\'');
      expect(text).toContain('⚠️ Associated data files were preserved');
      await expect(fs.access(stateFile)).resolves.toBeUndefined();
    });

    it('removes data files when deleteData is true', async () => {
      const agentName = 'agent-with-data';
      await server.createElement({
        name: agentName,
        type: ElementType.AGENT,
        description: agentDescription,
        instructions: agentInstructions,
        content: agentContent,
      });
      const stateDir = path.join(agentsDir, '.state');
      await fs.mkdir(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, `${agentName}-state.json`);
      await fs.writeFile(stateFile, JSON.stringify({ status: 'active' }), 'utf-8');

      const result = await server.deleteElement({
        name: 'agent-with-data',
        type: ElementType.AGENT,
        deleteData: true,
      });

      const text = result.content[0].text;
      expect(text).toContain('✅ Successfully deleted agent \'agent-with-data\'');
      expect(text).toContain('Associated data files:');
      expect(text).toContain('✓ deleted');
      await expect(fs.access(stateFile)).rejects.toThrow();
    });
  });

  describe('element lookup behavior', () => {
    it('falls back to manager.find when list is unavailable', async () => {
      const agentName = 'agent-fallback';
      await server.createElement({
        name: agentName,
        type: ElementType.AGENT,
        description: agentDescription,
        instructions: agentInstructions,
        content: agentContent,
      });
      const stateDir = path.join(agentsDir, '.state');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(path.join(stateDir, `${agentName}-state.json`), JSON.stringify({ status: 'active' }), 'utf-8');

      const handler = (server as any).elementCRUDHandler as ElementCRUDHandler;
      const agentManager = (handler as any).agentManager as Record<string, any>;
      // Simulate older environments where list is unavailable
      delete agentManager.list;

      const result = await server.deleteElement({
        name: 'agent-fallback',
        type: ElementType.AGENT,
        deleteData: false,
      });

      expect(result.content[0].text).toContain('✅ Successfully deleted agent \'agent-fallback\'');
    });

    // Issue #336: ElementNotFoundError is now thrown instead of returning error content
    it('throws ElementNotFoundError when element is missing', async () => {
      await expect(server.deleteElement({
        name: 'missing',
        type: ElementType.AGENT,
        deleteData: false,
      })).rejects.toThrow("agent 'missing' not found");
    });
  });

  describe('type validation', () => {
    it('returns legacy wording for unsupported types', async () => {
      const result = await server.deleteElement({
        name: 'sample',
        type: 'unsupported-type',
        deleteData: false,
      });

      expect(result.content[0].text).toContain("❌ Invalid element type: unsupported-type");
      expect(result.content[0].text).toContain('Valid types:');
    });
  });
});
