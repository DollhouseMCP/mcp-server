import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../../../src/index.js';
import { ElementType } from '../../../../../src/portfolio/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Generic Element Tools Integration', () => {
  let server: DollhouseMCPServer;
  const testDir = path.join(__dirname, 'test-portfolio');
  
  beforeEach(async () => {
    // Set up test portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    
    // Clean up test directory if it exists
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Directory might not exist, that's ok
    }
    
    // Create test directory structure
    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(path.join(testDir, 'skill'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'template'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'agent'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'persona'), { recursive: true });
    
    server = new DollhouseMCPServer();
  });
  
  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Directory might not exist, that's ok
    }
    
    // Clean up environment
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });
  
  describe('create_element', () => {
    it('should create a skill element successfully', async () => {
      const args = {
        name: 'code-review',
        type: ElementType.SKILL,
        description: 'Reviews code for quality and best practices',
        metadata: {
          domain: 'development',
          proficiency: 4
        }
      };
      
      const result = await server.createElement(args);
      
      expect(result.content[0].text).toContain('✅ Created skill');
      expect(result.content[0].text).toContain('code-review');
      
      // Verify file was created
      const skillFile = path.join(testDir, 'skill', 'code-review.md');
      const exists = await fs.access(skillFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
    
    it('should create a template element successfully', async () => {
      const args = {
        name: 'meeting-notes',
        type: ElementType.TEMPLATE,
        description: 'Template for meeting notes',
        content: '# Meeting Notes\n\nDate: {{date}}\nAttendees: {{attendees}}',
        metadata: {
          variables: ['date', 'attendees']
        }
      };
      
      const result = await server.createElement(args);
      
      expect(result.content[0].text).toContain('✅ Created template');
      expect(result.content[0].text).toContain('meeting-notes');
      
      // Verify file was created
      const templateFile = path.join(testDir, 'template', 'meeting-notes.md');
      const exists = await fs.access(templateFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
    
    it('should create an agent element successfully', async () => {
      const args = {
        name: 'project-manager',
        type: ElementType.AGENT,
        description: 'Manages project tasks and deadlines',
        content: 'You are a project manager agent.',
        metadata: {
          goals: ['Track progress', 'Identify blockers']
        }
      };
      
      const result = await server.createElement(args);
      
      expect(result.content[0].text).toContain('✅ Created agent');
      expect(result.content[0].text).toContain('project-manager');
      
      // Verify file was created
      const agentFile = path.join(testDir, 'agent', 'project-manager.md');
      const exists = await fs.access(agentFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
    
    it('should reject invalid element type', async () => {
      const args = {
        name: 'test',
        type: 'invalid-type',
        description: 'Test description'
      };
      
      const result = await server.createElement(args);
      
      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('Valid types:');
    });
  });
  
  describe('edit_element', () => {
    beforeEach(async () => {
      // Create a test skill
      await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Original description',
        metadata: { domain: 'testing', proficiency: 3 }
      });
    });
    
    it('should edit a skill element field successfully', async () => {
      const args = {
        name: 'test-skill',
        type: ElementType.SKILL,
        field: 'description',
        value: 'Updated description'
      };
      
      const result = await server.editElement(args);
      
      expect(result.content[0].text).toContain('✅ Updated skill');
      expect(result.content[0].text).toContain('description set to');
      expect(result.content[0].text).toContain('Updated description');
    });
    
    it('should edit nested metadata fields using dot notation', async () => {
      const args = {
        name: 'test-skill',
        type: ElementType.SKILL,
        field: 'metadata.proficiency',
        value: 5
      };
      
      const result = await server.editElement(args);
      
      expect(result.content[0].text).toContain('✅ Updated skill');
      expect(result.content[0].text).toContain('metadata.proficiency set to: 5');
    });
    
    it('should reject edits to non-existent elements', async () => {
      const args = {
        name: 'non-existent',
        type: ElementType.SKILL,
        field: 'description',
        value: 'New value'
      };
      
      const result = await server.editElement(args);
      
      expect(result.content[0].text).toContain('❌ skill \'non-existent\' not found');
    });
  });
  
  describe('validate_element', () => {
    beforeEach(async () => {
      // Create a test skill
      const createResult = await server.createElement({
        name: 'valid-skill',
        type: ElementType.SKILL,
        description: 'A well-formed skill for testing validation',
        content: '# Valid Skill\n\nThis skill performs code validation.',
        metadata: { 
          domain: 'testing', 
          proficiency: 4
        }
      });
      
      // Ensure the skill was created successfully
      expect(createResult.content[0].text).toContain('✅ Created skill');
    });
    
    it('should validate a valid skill element', async () => {
      const args = {
        name: 'valid-skill',
        type: ElementType.SKILL,
        strict: false
      };
      
      const result = await server.validateElement(args);
      
      expect(result.content[0].text).toContain('✅ Status: Valid');
    });
    
    it('should report validation errors for incomplete elements', async () => {
      // Create an incomplete skill
      await server.createElement({
        name: 'incomplete-skill',
        type: ElementType.SKILL,
        description: '', // Empty description
        metadata: {}
      });
      
      const args = {
        name: 'incomplete-skill',
        type: ElementType.SKILL,
        strict: false
      };
      
      const result = await server.validateElement(args);
      
      expect(result.content[0].text).toContain('❌ Status: Invalid');
      expect(result.content[0].text).toContain('❌ Errors');
    });
    
    it('should apply strict validation when requested', async () => {
      const args = {
        name: 'valid-skill',
        type: ElementType.SKILL,
        strict: true
      };
      
      const result = await server.validateElement(args);
      
      expect(result.content[0].text).toContain('📋 Strict Mode: Additional quality checks applied');
    });
    
    it('should reject validation of non-existent elements', async () => {
      const args = {
        name: 'non-existent',
        type: ElementType.SKILL,
        strict: false
      };
      
      const result = await server.validateElement(args);
      
      expect(result.content[0].text).toContain('❌ skill \'non-existent\' not found');
    });
  });
  
  describe('Element Type Support', () => {
    it('should report unsupported element types for creation', async () => {
      const args = {
        name: 'test-memory',
        type: 'memories', // Not in ElementType enum yet
        description: 'Test memory element'
      };
      
      const result = await server.createElement(args);
      
      expect(result.content[0].text).toContain('❌ Invalid element type');
    });
    
    it('should report unsupported element types for editing', async () => {
      const args = {
        name: 'test-ensemble',
        type: 'ensembles', // Not in ElementType enum yet
        field: 'description',
        value: 'New value'
      };
      
      const result = await server.editElement(args);
      
      expect(result.content[0].text).toContain('❌ Invalid element type');
    });
    
    it('should report unsupported element types for validation', async () => {
      const args = {
        name: 'test-memory',
        type: 'memories', // Not in ElementType enum yet
        strict: false
      };
      
      const result = await server.validateElement(args);
      
      expect(result.content[0].text).toContain('❌ Invalid element type');
    });
  });
});