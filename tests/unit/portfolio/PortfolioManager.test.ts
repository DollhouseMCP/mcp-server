/**
 * Tests for PortfolioManager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

// Create shared file operations service for tests using di-mocks helper
const fileOperations = createTestFileOperationsService();

describe('PortfolioManager', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  
  beforeEach(async () => {
    // Create a unique test directory path (but don't create it yet)
    testDir = path.join(tmpdir(), `portfolio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });
  
  afterEach(async () => {
    // Restore environment variable
    if (originalEnv) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalEnv;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }

    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('constructor', () => {
    it('should create independent instances', () => {
      const instance1 = new PortfolioManager(fileOperations, { baseDir: testDir });
      const instance2 = new PortfolioManager(fileOperations, { baseDir: testDir });
      expect(instance1).not.toBe(instance2);
    });

    it('should use default directory when no config provided', () => {
      portfolioManager = new PortfolioManager(fileOperations);
      const baseDir = portfolioManager.getBaseDir();
      expect(baseDir).toMatch(/\.dollhouse[/\\]portfolio$/);
    });

    it('should use config baseDir when provided', () => {
      const customDir = path.join(testDir, 'custom-portfolio');
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: customDir });
      expect(portfolioManager.getBaseDir()).toBe(customDir);
    });

    it('should prioritize environment variable over config', () => {
      const envDir = path.join(testDir, 'env-portfolio');
      const configDir = path.join(testDir, 'config-portfolio');

      process.env.DOLLHOUSE_PORTFOLIO_DIR = envDir;
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: configDir });

      expect(portfolioManager.getBaseDir()).toBe(envDir);
    });
  });

  describe('initialize', () => {
    beforeEach(() => {
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    });
    
    it('should create all element type directories', async () => {
      await portfolioManager.initialize();
      
      // Check each element type directory
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });
    
    it('should create special directories for stateful elements', async () => {
      await portfolioManager.initialize();
      
      // Check agent state directory
      const agentStateDir = path.join(portfolioManager.getElementDir(ElementType.AGENT), '.state');
      await expect(fs.access(agentStateDir)).resolves.toBeUndefined();
      
      // Memory type has been removed from ElementType
    });
    
    it('should be idempotent', async () => {
      // Initialize twice
      await portfolioManager.initialize();
      await portfolioManager.initialize();

      // Should not throw and directories should still exist
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });

    it('should recreate missing subdirectories if deleted', async () => {
      // Initial setup
      await portfolioManager.initialize();

      // Delete subdirectories (simulating test cleanup pollution)
      const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
      await fs.rm(skillsDir, { recursive: true, force: true });

      // Verify it was deleted
      await expect(fs.access(skillsDir)).rejects.toThrow();

      // Initialize again - should recreate missing directory
      await portfolioManager.initialize();

      // Verify all directories now exist
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });

    it('should recreate all subdirectories if all are deleted', async () => {
      // Initial setup
      await portfolioManager.initialize();

      // Delete ALL subdirectories but keep base directory
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await fs.rm(elementDir, { recursive: true, force: true });
      }

      // Base directory still exists
      await expect(fs.access(testDir)).resolves.toBeUndefined();

      // Initialize again - should recreate all missing directories
      await portfolioManager.initialize();

      // Verify all directories now exist
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });

    it('should recreate .state directory if deleted', async () => {
      // Initial setup
      await portfolioManager.initialize();

      // Delete just the .state directory
      const stateDir = path.join(portfolioManager.getElementDir(ElementType.AGENT), '.state');
      await fs.rm(stateDir, { recursive: true, force: true });

      // Verify it was deleted
      await expect(fs.access(stateDir)).rejects.toThrow();

      // Initialize again - should recreate .state directory
      await portfolioManager.initialize();

      // Verify .state directory exists
      await expect(fs.access(stateDir)).resolves.toBeUndefined();
    });

    it('should handle partial subdirectory deletion', async () => {
      // Initial setup
      await portfolioManager.initialize();

      // Delete only some subdirectories
      await fs.rm(portfolioManager.getElementDir(ElementType.SKILL), { recursive: true, force: true });
      await fs.rm(portfolioManager.getElementDir(ElementType.TEMPLATE), { recursive: true, force: true });

      // Keep others intact
      await expect(fs.access(portfolioManager.getElementDir(ElementType.AGENT))).resolves.toBeUndefined();

      // Initialize again - should recreate only missing directories
      await portfolioManager.initialize();

      // Verify all directories now exist
      for (const elementType of Object.values(ElementType)) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });
  });
  
  describe('exists', () => {
    beforeEach(() => {
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    });

    it('should return false when portfolio does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      const pm = new PortfolioManager(fileOperations, { baseDir: nonExistentDir });
      expect(await pm.exists()).toBe(false);
    });
    
    it('should return true after initialization', async () => {
      await portfolioManager.initialize();
      expect(await portfolioManager.exists()).toBe(true);
    });
  });
  
  describe('element operations', () => {
    beforeEach(async () => {
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
      await portfolioManager.initialize();
    });
    
    describe('listElements', () => {
      it('should return empty array for new element type', async () => {
        const skills = await portfolioManager.listElements(ElementType.SKILL);
        expect(skills).toEqual([]);
      });
      
      it('should list only .md files', async () => {
        const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
        
        // Create test files
        await fs.writeFile(path.join(personasDir, 'test1.md'), 'content1');
        await fs.writeFile(path.join(personasDir, 'test2.md'), 'content2');
        await fs.writeFile(path.join(personasDir, 'test.txt'), 'ignored');
        await fs.writeFile(path.join(personasDir, '.hidden.md'), 'hidden');
        
        const personas = await portfolioManager.listElements(ElementType.PERSONA);
        expect(personas).toContain('test1.md');
        expect(personas).toContain('test2.md');
        expect(personas).toContain('.hidden.md');
        expect(personas).not.toContain('test.txt');
      });
      
      it('should handle non-existent directory gracefully', async () => {
        // Remove a directory after initialization
        await fs.rmdir(portfolioManager.getElementDir(ElementType.TEMPLATE));
        
        const templates = await portfolioManager.listElements(ElementType.TEMPLATE);
        expect(templates).toEqual([]);
      });
    });
    
    describe('getElementPath', () => {
      it('should return correct path with .md extension', () => {
        const path1 = portfolioManager.getElementPath(ElementType.PERSONA, 'test');
        expect(path1).toMatch(/personas[/\\]test\.md$/);
        
        const path2 = portfolioManager.getElementPath(ElementType.PERSONA, 'sample.md');
        expect(path2).toMatch(/personas[/\\]sample\.md$/);
      });
    });
    
    describe('elementExists', () => {
      it('should return false for non-existent element', async () => {
        const exists = await portfolioManager.elementExists(ElementType.SKILL, 'non-existent.md');
        expect(exists).toBe(false);
      });
      
      it('should return true for existing element', async () => {
        const skillPath = portfolioManager.getElementPath(ElementType.SKILL, 'test-skill.md');
        await fs.writeFile(skillPath, 'content');
        
        const exists = await portfolioManager.elementExists(ElementType.SKILL, 'test-skill.md');
        expect(exists).toBe(true);
      });
    });
    
    describe('getStatistics', () => {
      it('should return counts for all element types', async () => {
        // Add some elements
        const personasDir = portfolioManager.getElementDir(ElementType.PERSONA);
        await fs.writeFile(path.join(personasDir, 'p1.md'), 'content');
        await fs.writeFile(path.join(personasDir, 'p2.md'), 'content');
        
        const skillsDir = portfolioManager.getElementDir(ElementType.SKILL);
        await fs.writeFile(path.join(skillsDir, 's1.md'), 'content');
        
        const stats = await portfolioManager.getStatistics();
        
        expect(stats[ElementType.PERSONA]).toBe(2);
        expect(stats[ElementType.SKILL]).toBe(1);
        expect(stats[ElementType.TEMPLATE]).toBe(0);
        expect(stats[ElementType.AGENT]).toBe(0);
        // ENSEMBLE and MEMORY types have been removed
      });
    });
  });
  
  describe('isTestElement', () => {
    beforeEach(() => {
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
    });

    describe('dangerous patterns detection', () => {
      it('should filter bin-sh patterns', () => {
        expect(portfolioManager.isTestElement('bin-sh')).toBe(true);
        expect(portfolioManager.isTestElement('BIN-SH')).toBe(true);
        expect(portfolioManager.isTestElement('bin-sh-attack.md')).toBe(true);
        expect(portfolioManager.isTestElement('prefix-bin-sh.md')).toBe(false);
      });

      it('should filter rm-rf patterns', () => {
        expect(portfolioManager.isTestElement('rm-rf')).toBe(true);
        expect(portfolioManager.isTestElement('RM-RF')).toBe(true);
        expect(portfolioManager.isTestElement('rm-rf-dangerous.md')).toBe(true);
        expect(portfolioManager.isTestElement('safe-rm-rf.md')).toBe(false);
      });

      it('should filter nc-e-bin patterns', () => {
        expect(portfolioManager.isTestElement('nc-e-bin')).toBe(true);
        expect(portfolioManager.isTestElement('NC-E-BIN')).toBe(true);
        expect(portfolioManager.isTestElement('nc-e-bin-shell.md')).toBe(true);
        expect(portfolioManager.isTestElement('normal-nc-e-bin.md')).toBe(false);
      });

      it('should filter python-c-import patterns', () => {
        expect(portfolioManager.isTestElement('python-c-import')).toBe(true);
        expect(portfolioManager.isTestElement('PYTHON-C-IMPORT')).toBe(true);
        expect(portfolioManager.isTestElement('python-c-import-os.md')).toBe(true);
        expect(portfolioManager.isTestElement('safe-python-c-import.md')).toBe(false);
      });

      it('should filter curl evil patterns', () => {
        expect(portfolioManager.isTestElement('curl-evil')).toBe(true);
        expect(portfolioManager.isTestElement('CURL-EVIL')).toBe(true);
        expect(portfolioManager.isTestElement('curl-something-evil')).toBe(true);
        expect(portfolioManager.isTestElement('curl-safe.md')).toBe(false);
      });

      it('should filter wget malicious patterns', () => {
        expect(portfolioManager.isTestElement('wget-malicious')).toBe(true);
        expect(portfolioManager.isTestElement('WGET-MALICIOUS')).toBe(true);
        expect(portfolioManager.isTestElement('wget-something-malicious')).toBe(true);
        expect(portfolioManager.isTestElement('wget-safe.md')).toBe(false);
      });

      it('should filter eval patterns', () => {
        expect(portfolioManager.isTestElement('eval-')).toBe(true);
        expect(portfolioManager.isTestElement('EVAL-')).toBe(true);
        expect(portfolioManager.isTestElement('eval-code.md')).toBe(true);
        expect(portfolioManager.isTestElement('eval-injection.md')).toBe(true);
        expect(portfolioManager.isTestElement('evaluation.md')).toBe(false);
        expect(portfolioManager.isTestElement('safe-eval.md')).toBe(false);
      });

      it('should filter exec patterns', () => {
        expect(portfolioManager.isTestElement('exec-')).toBe(true);
        expect(portfolioManager.isTestElement('EXEC-')).toBe(true);
        expect(portfolioManager.isTestElement('exec-command.md')).toBe(true);
        expect(portfolioManager.isTestElement('exec-shell.md')).toBe(true);
        expect(portfolioManager.isTestElement('execution.md')).toBe(false);
        expect(portfolioManager.isTestElement('safe-exec.md')).toBe(false);
      });

      it('should filter bash-c patterns', () => {
        expect(portfolioManager.isTestElement('bash-c-')).toBe(true);
        expect(portfolioManager.isTestElement('BASH-C-')).toBe(true);
        expect(portfolioManager.isTestElement('bash-c-command.md')).toBe(true);
        expect(portfolioManager.isTestElement('bash-script.md')).toBe(false);
      });

      it('should filter sh-c patterns', () => {
        expect(portfolioManager.isTestElement('sh-c-')).toBe(true);
        expect(portfolioManager.isTestElement('SH-C-')).toBe(true);
        expect(portfolioManager.isTestElement('sh-c-command.md')).toBe(true);
        expect(portfolioManager.isTestElement('shell-script.md')).toBe(false);
      });

      it('should filter powershell patterns', () => {
        expect(portfolioManager.isTestElement('powershell-')).toBe(true);
        expect(portfolioManager.isTestElement('POWERSHELL-')).toBe(true);
        expect(portfolioManager.isTestElement('powershell-command.md')).toBe(true);
        expect(portfolioManager.isTestElement('powershell-script.md')).toBe(true);
        expect(portfolioManager.isTestElement('safe-powershell.md')).toBe(false);
      });

      it('should filter cmd-c patterns', () => {
        expect(portfolioManager.isTestElement('cmd-c-')).toBe(true);
        expect(portfolioManager.isTestElement('CMD-C-')).toBe(true);
        expect(portfolioManager.isTestElement('cmd-c-command.md')).toBe(true);
        expect(portfolioManager.isTestElement('cmd-script.md')).toBe(false);
      });

      it('should filter shell-injection patterns', () => {
        expect(portfolioManager.isTestElement('shell-injection')).toBe(true);
        expect(portfolioManager.isTestElement('SHELL-INJECTION')).toBe(true);
        expect(portfolioManager.isTestElement('test-shell-injection.md')).toBe(true);
        expect(portfolioManager.isTestElement('shell-safe.md')).toBe(false);
      });
    });

    // NOTE: Test pattern filtering was removed in Issue #287
    // Users can legitimately name elements with "test" in the name.
    // Only dangerous patterns (security concerns) are now filtered.
    describe('test patterns are NOT filtered (Issue #287)', () => {
      it('should allow test- patterns', () => {
        expect(portfolioManager.isTestElement('test-')).toBe(false);
        expect(portfolioManager.isTestElement('test-persona.md')).toBe(false);
        expect(portfolioManager.isTestElement('testing.md')).toBe(false);
      });

      it('should allow test-skill patterns', () => {
        expect(portfolioManager.isTestElement('test-skill')).toBe(false);
        expect(portfolioManager.isTestElement('my-test-skill.md')).toBe(false);
        expect(portfolioManager.isTestElement('skill-safe.md')).toBe(false);
      });

      it('should allow test-persona patterns', () => {
        expect(portfolioManager.isTestElement('test-persona')).toBe(false);
        expect(portfolioManager.isTestElement('my-test-persona.md')).toBe(false);
      });

      it('should allow test-data patterns', () => {
        expect(portfolioManager.isTestElement('test-data')).toBe(false);
        expect(portfolioManager.isTestElement('my-test-data.md')).toBe(false);
      });
    });

    describe('edge cases and validation', () => {
      it('should handle empty strings safely', () => {
        expect(portfolioManager.isTestElement('')).toBe(false);
      });

      it('should handle null and undefined safely', () => {
        expect(() => portfolioManager.isTestElement(null as any)).not.toThrow();
        expect(() => portfolioManager.isTestElement(undefined as any)).not.toThrow();
      });

      it('should handle special characters in dangerous patterns', () => {
        // eval- is a dangerous pattern and should be filtered
        expect(portfolioManager.isTestElement('eval-<script>.md')).toBe(true);
        // test- is no longer filtered (Issue #287)
        expect(portfolioManager.isTestElement('test-!@#$%.md')).toBe(false);
        expect(portfolioManager.isTestElement('safe-!@#$%.md')).toBe(false);
      });

      it('should handle unicode characters in dangerous patterns', () => {
        // eval- is a dangerous pattern and should be filtered
        expect(portfolioManager.isTestElement('eval-тест.md')).toBe(true);
        // test- is no longer filtered (Issue #287)
        expect(portfolioManager.isTestElement('test-文件.md')).toBe(false);
        expect(portfolioManager.isTestElement('安全-文件.md')).toBe(false);
      });

      it('should handle very long filenames', () => {
        // test- prefix no longer filtered (Issue #287)
        const testFilename = 'test-' + 'a'.repeat(1000) + '.md';
        expect(portfolioManager.isTestElement(testFilename)).toBe(false);

        // eval- is dangerous and should be filtered
        const dangerousFilename = 'eval-' + 'a'.repeat(1000) + '.md';
        expect(portfolioManager.isTestElement(dangerousFilename)).toBe(true);

        const safeLongFilename = 'safe-' + 'a'.repeat(1000) + '.md';
        expect(portfolioManager.isTestElement(safeLongFilename)).toBe(false);
      });

      it('should handle path separators correctly', () => {
        // test- prefix no longer filtered (Issue #287)
        expect(portfolioManager.isTestElement('test-file/path.md')).toBe(false);
        expect(portfolioManager.isTestElement('test-file\\path.md')).toBe(false);
        expect(portfolioManager.isTestElement('safe-file/path.md')).toBe(false);
      });

      it('should be case insensitive for dangerous patterns', () => {
        // Only dangerous patterns are now filtered
        const dangerousCases = [
          ['eval-code', 'EVAL-code', 'Eval-CODE'],
          ['shell-injection', 'SHELL-injection', 'Shell-INJECTION']
        ];

        dangerousCases.forEach(cases => {
          cases.forEach(testCase => {
            expect(portfolioManager.isTestElement(testCase)).toBe(true);
          });
        });

        // test- is no longer filtered (Issue #287)
        expect(portfolioManager.isTestElement('test-file')).toBe(false);
        expect(portfolioManager.isTestElement('TEST-file')).toBe(false);
      });
    });

    describe('legitimate files should not be filtered', () => {
      it('should allow legitimate persona files', () => {
        const legitimateFiles = [
          'expert-analyst.md',
          'creative-writer.md',
          'code-reviewer.md',
          'project-manager.md',
          'technical-writer.md'
        ];

        legitimateFiles.forEach(filename => {
          expect(portfolioManager.isTestElement(filename)).toBe(false);
        });
      });

      it('should allow legitimate skill files', () => {
        const legitimateFiles = [
          'python-development.md',
          'data-analysis.md',
          'web-design.md',
          'project-planning.md',
          'code-review.md'
        ];

        legitimateFiles.forEach(filename => {
          expect(portfolioManager.isTestElement(filename)).toBe(false);
        });
      });

      it('should allow legitimate template files', () => {
        const legitimateFiles = [
          'meeting-notes.md',
          'project-proposal.md',
          'technical-spec.md',
          'user-story.md',
          'bug-report.md'
        ];

        legitimateFiles.forEach(filename => {
          expect(portfolioManager.isTestElement(filename)).toBe(false);
        });
      });

      it('should allow legitimate agent files', () => {
        const legitimateFiles = [
          'research-assistant.md',
          'code-generator.md',
          'content-creator.md',
          'data-processor.md',
          'workflow-manager.md'
        ];

        legitimateFiles.forEach(filename => {
          expect(portfolioManager.isTestElement(filename)).toBe(false);
        });
      });
    });
  });

  describe('legacy support', () => {
    let mockLegacyDir: string;

    beforeEach(() => {
      portfolioManager = new PortfolioManager(fileOperations, { baseDir: testDir });
      // Mock the legacy directory to use test directory
      mockLegacyDir = path.join(testDir, 'legacy-personas');
      jest.spyOn(portfolioManager, 'getLegacyPersonasDir').mockReturnValue(mockLegacyDir);
    });
    
    it('should detect legacy personas directory', async () => {
      await fs.mkdir(mockLegacyDir, { recursive: true });
      await fs.writeFile(path.join(mockLegacyDir, 'legacy.md'), 'content');
      
      expect(await portfolioManager.hasLegacyPersonas()).toBe(true);
    });
    
    it('should return false when no legacy personas', async () => {
      expect(await portfolioManager.hasLegacyPersonas()).toBe(false);
    });
    
    it('should return false when legacy directory has no .md files', async () => {
      await fs.mkdir(mockLegacyDir, { recursive: true });
      await fs.writeFile(path.join(mockLegacyDir, 'not-persona.txt'), 'content');
      
      expect(await portfolioManager.hasLegacyPersonas()).toBe(false);
    });
  });
});