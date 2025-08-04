/**
 * Tests for SkillManager
 * Verifies CRUD operations and security features
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillManager } from '../../../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../../../src/elements/skills/Skill.js';
import { FileLockManager } from '../../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../../src/security/securityMonitor.js';
import { PortfolioManager } from '../../../../../src/portfolio/PortfolioManager.js';

// Mock dependencies
jest.mock('../../../../../src/security/fileLockManager.js');
jest.mock('../../../../../src/security/securityMonitor.js');
jest.mock('../../../../../src/utils/logger.js');

describe('SkillManager', () => {
  let testDir: string;
  let skillManager: SkillManager;
  let portfolioManager: PortfolioManager;

  beforeEach(async () => {
    // Create temporary test directory path (but don't create it yet)
    testDir = path.join(os.tmpdir(), `skill-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
    portfolioManager = PortfolioManager.getInstance();
    await portfolioManager.initialize();
    
    // Create skill manager
    skillManager = new SkillManager();
    
    // Set up mocks
    jest.clearAllMocks();
    
    // Mock FileLockManager - make atomicWriteFile actually write the file
    (FileLockManager as any).atomicWriteFile = jest.fn().mockImplementation(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    });
    (FileLockManager as any).atomicReadFile = jest.fn().mockImplementation(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    });
    
    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  describe('load', () => {
    it('should load a skill from file', async () => {
      // Create a test skill file
      const skillContent = `---
name: Test Skill
description: A test skill for unit testing
tags: [testing, example]
---
# Test Skill Instructions

This is a test skill.`;
      
      const skillPath = path.join(portfolioManager.getElementDir('skill'), 'test-skill.md');
      await fs.writeFile(skillPath, skillContent);
      
      // Load the skill
      const skill = await skillManager.load('test-skill.md');
      
      expect(skill).toBeInstanceOf(Skill);
      expect(skill.metadata.name).toBe('Test Skill');
      expect(skill.metadata.description).toBe('A test skill for unit testing');
      expect(skill.instructions).toContain('This is a test skill.');
      
      // Verify security logging
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'SkillManager.load',
        details: expect.stringContaining('Skill successfully loaded: Test Skill')
      });
    });

    it('should handle missing file gracefully', async () => {
      await expect(skillManager.load('non-existent.md'))
        .rejects.toThrow();
    });

    it('should validate file paths', async () => {
      await expect(skillManager.load('../../../etc/passwd'))
        .rejects.toThrow('Invalid skill path');
    });
  });

  describe('save', () => {
    it('should save a skill to file', async () => {
      const skill = new Skill({
        name: 'Save Test',
        description: 'Testing save functionality',
        tags: ['test']
      }, 'Save test instructions');
      
      await skillManager.save(skill, 'save-test.md');
      
      // Verify file was created
      const savedPath = path.join(portfolioManager.getElementDir('skill'), 'save-test.md');
      const exists = await fs.access(savedPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      
      // Verify atomic write was used
      expect(FileLockManager.atomicWriteFile).toHaveBeenCalledWith(
        savedPath,
        expect.stringContaining('name: Save Test'),
        { encoding: 'utf-8' }
      );
      
      // Verify security logging
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'SkillManager.save',
        details: 'Saving skill: Save Test'
      });
    });

    it('should prevent path traversal attacks', async () => {
      const skill = new Skill({ name: 'Test' }, 'content');
      
      await expect(skillManager.save(skill, '../../../etc/passwd'))
        .rejects.toThrow('Invalid skill path');
    });
  });

  describe('list', () => {
    it('should list all skill files', async () => {
      // Create test skill files
      const skillsDir = portfolioManager.getElementDir('skill');
      await fs.writeFile(path.join(skillsDir, 'skill1.md'), '---\nname: Skill 1\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'skill2.md'), '---\nname: Skill 2\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'not-a-skill.txt'), 'Should be ignored');
      
      // Mock atomicReadFile to read actual files
      (FileLockManager as any).atomicReadFile = jest.fn().mockImplementation(async (filePath: string) => {
        return fs.readFile(filePath, 'utf-8');
      });
      
      const skills = await skillManager.list();
      
      expect(skills).toHaveLength(2);
      expect(skills[0].metadata.name).toBe('Skill 1');
      expect(skills[1].metadata.name).toBe('Skill 2');
    });

    it('should handle empty directory', async () => {
      const skills = await skillManager.list();
      expect(skills).toEqual([]);
    });

    it('should handle load errors gracefully', async () => {
      // Create an invalid skill file with malformed YAML frontmatter
      const skillsDir = portfolioManager.getElementDir('skill');
      await fs.writeFile(path.join(skillsDir, 'invalid.md'), '---\ninvalid: [unclosed\n---\ncontent');
      
      const skills = await skillManager.list();
      
      // Should return empty array and log error
      expect(skills).toEqual([]);
    });
  });

  describe('find', () => {
    beforeEach(async () => {
      // Create test skills
      const skillsDir = portfolioManager.getElementDir('skill');
      await fs.writeFile(path.join(skillsDir, 'javascript.md'), '---\nname: JavaScript Expert\ntags: [programming, web]\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'python.md'), '---\nname: Python Developer\ntags: [programming, data]\n---\nContent');
      
      // Mock atomicReadFile
      (FileLockManager as any).atomicReadFile = jest.fn().mockImplementation(async (filePath: string) => {
        return fs.readFile(filePath, 'utf-8');
      });
    });

    it('should find skill by predicate', async () => {
      const skill = await skillManager.find(s => s.metadata.name === 'JavaScript Expert');
      
      expect(skill).toBeDefined();
      expect(skill?.metadata.name).toBe('JavaScript Expert');
    });

    it('should return undefined when no match', async () => {
      const skill = await skillManager.find(s => s.metadata.name === 'Non-existent');
      
      expect(skill).toBeUndefined();
    });
  });

  describe('validate', () => {
    it('should validate a valid skill', async () => {
      const skill = new Skill({
        name: 'Valid Skill',
        description: 'A valid skill',
        tags: ['test']
      }, 'Valid instructions');
      
      const result = await skillManager.validate(skill);
      
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect invalid skills', async () => {
      const skill = new Skill({
        name: '', // Empty name
        description: 'Invalid skill'
      }, '');
      
      const result = await skillManager.validate(skill);
      
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('delete', () => {
    it('should delete a skill file', async () => {
      // Create a skill file
      const skillPath = path.join(portfolioManager.getElementDir('skill'), 'to-delete.md');
      await fs.writeFile(skillPath, '---\nname: To Delete\n---\nContent');
      
      // Mock atomicReadFile
      (FileLockManager as any).atomicReadFile = jest.fn().mockResolvedValue('---\nname: To Delete\n---\nContent');
      
      await skillManager.delete('to-delete.md');
      
      // Verify file was deleted
      const exists = await fs.access(skillPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
      
      // Verify security logging
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ELEMENT_DELETED',
        severity: 'MEDIUM',
        source: 'SkillManager.delete',
        details: 'Attempting to delete skill: to-delete.md'
      });
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'ELEMENT_DELETED',
        severity: 'LOW',
        source: 'SkillManager.delete',
        details: 'Skill successfully deleted: to-delete.md'
      });
    });
  });

  describe('importElement', () => {
    it('should import from YAML format', async () => {
      const yamlData = `name: Imported Skill
description: Imported from YAML
tags:
  - import
  - test`;
      
      const skill = await skillManager.importElement(yamlData, 'yaml');
      
      expect(skill.metadata.name).toBe('Imported Skill');
      expect(skill.metadata.description).toBe('Imported from YAML');
      expect(skill.metadata.tags).toEqual(['import', 'test']);
      
      // Verify YAML security logging
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith({
        type: 'YAML_PARSE_SUCCESS',
        severity: 'LOW',
        source: 'SkillManager.importElement',
        details: 'YAML content safely parsed during import'
      });
    });

    it('should import from JSON format', async () => {
      const jsonData = JSON.stringify({
        name: 'JSON Skill',
        description: 'Imported from JSON',
        tags: ['json']
      });
      
      const skill = await skillManager.importElement(jsonData, 'json');
      
      expect(skill.metadata.name).toBe('JSON Skill');
      expect(skill.metadata.description).toBe('Imported from JSON');
    });

    it('should handle invalid YAML gracefully', async () => {
      const invalidYaml = `{invalid yaml content}:`;
      
      await expect(skillManager.importElement(invalidYaml, 'yaml'))
        .rejects.toThrow();
    });
  });

  describe('exportElement', () => {
    it('should export to YAML format', async () => {
      const skill = new Skill({
        name: 'Export Test',
        description: 'Testing export',
        tags: ['export']
      }, 'Export instructions');
      
      const yaml = await skillManager.exportElement(skill, 'yaml');
      
      expect(yaml).toContain('name: Export Test');
      expect(yaml).toContain('description: Testing export');
      expect(yaml).toContain('tags:');
      expect(yaml).toContain('- export');
    });

    it('should export to JSON format', async () => {
      const skill = new Skill({
        name: 'JSON Export',
        description: 'Testing JSON export'
      }, 'Instructions');
      
      const json = await skillManager.exportElement(skill, 'json');
      const parsed = JSON.parse(json);
      
      expect(parsed.name).toBe('JSON Export');
      expect(parsed.description).toBe('Testing JSON export');
    });
  });

  describe('Security Features', () => {
    it('should use FileLockManager for all file operations', async () => {
      const skill = new Skill({ name: 'Security Test' }, 'content');
      
      await skillManager.save(skill, 'security-test.md');
      
      expect(FileLockManager.atomicWriteFile).toHaveBeenCalled();
    });

    it('should log all security-relevant operations', async () => {
      const skill = new Skill({ name: 'Audit Test' }, 'content');
      
      await skillManager.save(skill, 'audit-test.md');
      
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledTimes(1);
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'SkillManager.save',
          severity: 'LOW'
        })
      );
    });
  });
});