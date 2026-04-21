/**
 * Tests for SkillManager
 * Verifies CRUD operations and security features
 */

import { describe, it, expect, beforeEach, afterEach, jest, beforeAll, afterAll } from '@jest/globals';
import { promises as fs, realpathSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillManager } from '../../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../../src/elements/skills/Skill.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

// Mock dependencies
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

describe('SkillManager', () => {
  let testDir: string;
  let skillManager: InstanceType<typeof SkillManager>;
  let portfolioManager: InstanceType<typeof PortfolioManager>;
  let fileLockManager: InstanceType<typeof FileLockManager>;
  let metadataService: ReturnType<typeof createTestMetadataService>;

  beforeAll(async () => {
    // Create temporary test directory path (but don't create it yet)
    testDir = path.join(os.tmpdir(), `skill-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Create all required services
    fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    const serializationService = new SerializationService();
    metadataService = createTestMetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Create SkillManager with all required dependencies
    skillManager = new SkillManager({
      portfolioManager,
      fileLockManager,
      fileOperationsService: fileOperations,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
    });

    await portfolioManager.initialize();
  });

  beforeEach(async () => {
    // Set up mocks
    jest.clearAllMocks();

    // Mock FileLockManager instance methods - make atomicWriteFile actually write the file
    fileLockManager.atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    }) as any;
    fileLockManager.atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    }) as any;

    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();
  });

  afterEach(async () => {
    // Clean skills directory between tests to avoid cross-test contamination
    const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
    try {
      const files = await fs.readdir(skillsDir);
      await Promise.all(files.map(file => fs.unlink(path.join(skillsDir, file))));
    } catch {
      // Directory might not exist yet, ignore
    }
  });

  afterAll(async () => {
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
      
      const skillPath = path.join(portfolioManager.getElementDir(ElementType.SKILL), 'test-skill.md');
      await fs.writeFile(skillPath, skillContent);
      
      // Load the skill
      const skill = await skillManager.load('test-skill.md');
      
      expect(skill).toBeInstanceOf(Skill);
      expect(skill.metadata.name).toBe('Test Skill');
      expect(skill.metadata.description).toBe('A test skill for unit testing');
      expect(skill.instructions).toContain('This is a test skill.');
      
      // YAML_PARSE_SUCCESS removed from hot-path parser to reduce log noise.
      // Security audit for YAML parsing is handled at higher-level call sites.
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
      }, 'Save test instructions', metadataService);
      
      await skillManager.save(skill, 'save-sample.md');
      
      // Verify file was created
      const savedPath = path.join(portfolioManager.getElementDir(ElementType.SKILL), 'save-sample.md');
      const exists = await fs.access(savedPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Verify atomic write was used
      const calls = (fileLockManager.atomicWriteFile as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      const [actualPath, content, options] = calls[0] as [string, string, { encoding: string }];

      // Normalize paths for cross-platform comparison (handles /var → /private/var on macOS)
      // File already exists (was written by mock), so we can use realpathSync directly
      expect(realpathSync(actualPath)).toBe(realpathSync(savedPath));

      // Verify content and options
      expect(content).toContain('name: Save Test');
      expect(options).toEqual({ encoding: 'utf-8' });
      
      // Verify security logging - Expect both ELEMENT_EDITED (from SkillManager.save) and FILE_WRITTEN (from FileOperationsService)
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_EDITED',
          severity: 'LOW'
        })
      );
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FILE_WRITTEN',
          severity: 'LOW',
          details: expect.stringContaining('File written successfully')
        })
      );
    });

    it('should prevent path traversal attacks', async () => {
      const skill = new Skill({ name: 'Test' }, 'content', metadataService);

      await expect(skillManager.save(skill, '../../../etc/passwd'))
        .rejects.toThrow('Invalid skill path');
    });

    it('should reject saving skill content with top-level externalRestrictions in frontmatter', async () => {
      const skill = new Skill({
        name: 'Broken Policy Skill',
        description: 'Has misplaced external restrictions',
      }, 'content', metadataService);

      (skill.metadata as any).externalRestrictions = {
        description: 'misnested',
        denyPatterns: ['Bash:rm *'],
      };

      await expect(skillManager.save(skill, 'broken-policy.md'))
        .rejects.toThrow('externalRestrictions must be nested under gatekeeper.externalRestrictions');
    });

    it('should reject saving skill content with malformed gatekeeper externalRestrictions', async () => {
      const skill = new Skill({
        name: 'Missing Description Skill',
        description: 'Invalid gatekeeper policy',
        gatekeeper: {
          externalRestrictions: {
            denyPatterns: ['Bash:rm *'],
          },
        } as any,
      }, 'content', metadataService);

      await expect(skillManager.save(skill, 'missing-description.md'))
        .rejects.toThrow('externalRestrictions.description is required');
    });
  });

  describe('list', () => {
    it('should list all skill files', async () => {
      // Create test skill files
      const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.writeFile(path.join(skillsDir, 'skill1.md'), '---\nname: Skill 1\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'skill2.md'), '---\nname: Skill 2\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'not-a-skill.txt'), 'Should be ignored');
      
      // Mock atomicReadFile to read actual files
      (FileLockManager as any).atomicReadFile = jest.fn(async (filePath: string) => {
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
      const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.writeFile(path.join(skillsDir, 'invalid.md'), '---\ninvalid: [unclosed\n---\ncontent');
      
      const skills = await skillManager.list();
      
      // Should return empty array and log error
      expect(skills).toEqual([]);
    });
  });

  describe('find', () => {
    beforeEach(async () => {
      // Create test skills
      const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.writeFile(path.join(skillsDir, 'javascript.md'), '---\nname: JavaScript Expert\ntags: [programming, web]\n---\nContent');
      await fs.writeFile(path.join(skillsDir, 'python.md'), '---\nname: Python Developer\ntags: [programming, data]\n---\nContent');
      
      // Mock atomicReadFile
      (FileLockManager as any).atomicReadFile = jest.fn(async (filePath: string) => {
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
    it('should validate a valid skill', () => {
      const skill = new Skill({
        name: 'Valid Skill',
        description: 'A valid skill',
        tags: ['test']
      }, 'Valid instructions', metadataService);

      const result = skillManager.validate(skill);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect invalid skills', () => {
      const skill = new Skill({
        name: '', // Empty name
        description: 'Invalid skill'
      }, '', metadataService);

      const result = skillManager.validate(skill);

      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it('should warn when domains array is empty', async () => {
      const skill = new Skill({
        name: 'Domain Test Skill',
        description: 'A skill with empty domains',
        domains: [],
        tags: ['test']
      }, 'Valid instructions', metadataService);

      const result = skill.validate();

      expect(result.warnings?.some(w => w.message.includes('domain categories'))).toBe(true);
    });

    it('should warn when examples array is empty', async () => {
      const skill = new Skill({
        name: 'Example Test Skill',
        description: 'A skill with empty examples',
        examples: [],
        tags: ['test']
      }, 'Valid instructions', metadataService);

      const result = skill.validate();

      expect(result.warnings?.some(w => w.message.includes('usage examples'))).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete a skill file', async () => {
      // Create a skill file
      const skillPath = path.join(portfolioManager.getElementDir(ElementType.SKILL), 'to-delete.md');
      await fs.writeFile(skillPath, '---\nname: To Delete\n---\nContent');
      
      // Mock atomicReadFile
      (FileLockManager as any).atomicReadFile = jest.fn(() => Promise.resolve('---\nname: To Delete\n---\nContent'));
      
      await skillManager.delete('to-delete.md');
      
      // Verify file was deleted
      const exists = await fs.access(skillPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
      
      // Verify security logging - Expect ELEMENT_DELETED (from SkillManager) and FILE_DELETED (from FileOperationsService)
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ELEMENT_DELETED',
          severity: 'MEDIUM'
        })
      );
      // FileOperationsService produces a more descriptive message with element type and filename
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'FILE_DELETED',
          severity: 'MEDIUM',
          details: expect.stringContaining('Deleted skills file: to-delete.md')
        })
      );
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
        details: 'YAML content safely parsed'
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
      }, 'Export instructions', metadataService);

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
      }, 'Instructions', metadataService);

      const json = await skillManager.exportElement(skill, 'json');
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe('JSON Export');
      expect(parsed.description).toBe('Testing JSON export');
    });
  });

  describe('Security Features', () => {
    it('should use FileLockManager for all file operations', async () => {
      const skill = new Skill({ name: 'Security Test' }, 'content', metadataService);

      await skillManager.save(skill, 'security-sample.md');

      expect(fileLockManager.atomicWriteFile).toHaveBeenCalled();
    });

    it('should log all security-relevant operations', async () => {
      // Recreate the mock to ensure fresh state
      (SecurityMonitor as any).logSecurityEvent = jest.fn();

      const skill = new Skill({ name: 'Audit Test' }, 'content', metadataService);

      await skillManager.save(skill, 'audit-sample.md');

      // Verify that SkillManager.save logged a security event
      // Note: Other operations (like parsing, base class logging) may also log,
      // so we check that AT LEAST ONE call matches our expected signature
      expect(SecurityMonitor.logSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'SkillManager.save',
          severity: 'LOW',
          details: expect.stringContaining('Saving skill: Audit Test')
        })
      );
    });
  });
});
