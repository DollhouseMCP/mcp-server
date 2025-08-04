/**
 * Integration tests for delete_element MCP tool
 * Tests actual file operations and data file handling
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DollhouseMCPServer } from '../../../../../src/index.js';
import { PortfolioManager } from '../../../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../../../src/portfolio/types.js';

describe('Delete Element Tool Integration', () => {
  let server: DollhouseMCPServer;
  let portfolioManager: PortfolioManager;
  let testDir: string;
  
  beforeEach(async () => {
    // Create test directory
    testDir = path.join(process.cwd(), 'test-delete-element-' + Date.now());
    
    // Set test portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    
    // Create directory structure
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(path.join(testDir, 'skills'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'templates'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'agents'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'agents', '.state'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'personas'), { recursive: true });
    
    // Initialize portfolio manager first
    portfolioManager = PortfolioManager.getInstance();
    
    // Initialize server
    server = new DollhouseMCPServer();
    
    // Create test elements
    await createTestSkill('test-skill');
    await createTestTemplate('test-template');
    await createTestAgent('test-agent');
  });
  
  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Clear the singleton instance for next test
    (PortfolioManager as any).instance = undefined;
  });
  
  async function createTestSkill(name: string) {
    const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
    const content = `---
name: ${name}
description: Test skill for deletion
type: skill
version: 1.0.0
---
# Test Skill

This is a test skill.`;
    await fs.writeFile(path.join(skillsDir, `${name}.md`), content, 'utf-8');
  }
  
  async function createTestTemplate(name: string) {
    const templatesDir = portfolioManager.getElementDir(ElementType.TEMPLATE);
    const content = `---
name: ${name}
description: Test template for deletion
type: template
version: 1.0.0
---
# Test Template

Hello {{name}}!`;
    await fs.writeFile(path.join(templatesDir, `${name}.md`), content, 'utf-8');
  }
  
  async function createTestAgent(name: string, withState: boolean = false) {
    const agentsDir = portfolioManager.getElementDir(ElementType.AGENT);
    const content = `---
name: ${name}
description: Test agent for deletion
type: agent
version: 1.0.0
---
# Test Agent

Goals:
- Test deletion`;
    await fs.writeFile(path.join(agentsDir, `${name}.md`), content, 'utf-8');
    
    // Create state file if requested
    if (withState) {
      const stateDir = path.join(agentsDir, '.state');
      await fs.mkdir(stateDir, { recursive: true });
      const stateData = {
        currentGoal: "Test deletion",
        progress: 50,
        lastUpdated: new Date().toISOString()
      };
      await fs.writeFile(
        path.join(stateDir, `${name}-state.json`),
        JSON.stringify(stateData, null, 2),
        'utf-8'
      );
    }
  }
  
  describe('Basic deletion', () => {
    it('should delete a skill element successfully', async () => {
      const args = {
        name: 'test-skill',
        type: 'skills',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted skills \'test-skill\'');
      
      // Verify file is deleted
      const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
      const files = await fs.readdir(skillsDir);
      expect(files).not.toContain('test-skill.md');
    });
    
    it('should delete a template element successfully', async () => {
      const args = {
        name: 'test-template',
        type: 'templates',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted templates \'test-template\'');
    });
    
    it('should delete an agent element without state', async () => {
      const args = {
        name: 'test-agent',
        type: 'agents',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted agents \'test-agent\'')
    });
    
    it('should report error for non-existent element', async () => {
      const args = {
        name: 'non-existent',
        type: 'skills',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('❌ skills \'non-existent\' not found');
    });
    
    it('should report error for invalid element type', async () => {
      const args = {
        name: 'test',
        type: 'invalid-type',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('❌ Invalid element type: invalid-type');
      expect(result.content[0].text).toContain('Valid types:');
    });
  });
  
  describe('Data file handling', () => {
    it('should prompt about data files when deleteData is undefined', async () => {
      // Create agent with state
      await createTestAgent('agent-with-state', true);
      
      const args = {
        name: 'agent-with-state',
        type: 'agents'
        // deleteData is undefined
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('⚠️  This agents has associated data files:');
      expect(result.content[0].text).toContain('.state/agent-with-state-state.json');
      expect(result.content[0].text).toContain('Would you like to delete these data files as well?');
      expect(result.content[0].text).toContain('To delete everything (element + data), say: "Yes, delete all data"');
      expect(result.content[0].text).toContain('To keep the data files, say: "No, keep the data"');
      expect(result.content[0].text).toContain('To cancel, say: "Cancel"');
    });
    
    it('should delete data files when deleteData is true', async () => {
      // Create agent with state
      await createTestAgent('agent-with-data', true);
      
      const args = {
        name: 'agent-with-data',
        type: 'agents',
        deleteData: true
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted agents \'agent-with-data\'')
      expect(result.content[0].text).toContain('Associated data files:');
      expect(result.content[0].text).toContain('✓ deleted');
      
      // Verify both files are deleted
      const agentsDir = portfolioManager.getElementDir(ElementType.AGENT);
      const mainFiles = await fs.readdir(agentsDir);
      expect(mainFiles).not.toContain('agent-with-data.md');
      
      const stateDir = path.join(agentsDir, '.state');
      const stateFiles = await fs.readdir(stateDir);
      expect(stateFiles).not.toContain('agent-with-data-state.json');
    });
    
    it('should preserve data files when deleteData is false', async () => {
      // Create agent with state
      await createTestAgent('agent-preserve-data', true);
      
      const args = {
        name: 'agent-preserve-data',
        type: 'agents',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted agents \'agent-preserve-data\'')
      expect(result.content[0].text).toContain('⚠️ Associated data files were preserved:');
      
      // Verify main file is deleted but state file remains
      const agentsDir = portfolioManager.getElementDir(ElementType.AGENT);
      const mainFiles = await fs.readdir(agentsDir);
      expect(mainFiles).not.toContain('agent-preserve-data.md');
      
      const stateDir = path.join(agentsDir, '.state');
      const stateFiles = await fs.readdir(stateDir);
      expect(stateFiles).toContain('agent-preserve-data-state.json');
    });
  });
  
  describe('Persona handling', () => {
    it('should delete a persona element', async () => {
      // Create a test persona
      const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
      const content = `---
name: test-persona
description: Test persona for deletion
---
# Test Persona`;
      await fs.writeFile(path.join(personasDir, 'test-persona.md'), content, 'utf-8');
      
      const args = {
        name: 'test-persona',
        type: 'personas',
        deleteData: false
      };
      
      const result = await server.deleteElement(args);
      
      expect(result.content[0].text).toContain('✅ Successfully deleted persona \'test-persona\'');
      
      // Verify file is deleted
      const files = await fs.readdir(personasDir);
      expect(files).not.toContain('test-persona.md');
    });
  });
});