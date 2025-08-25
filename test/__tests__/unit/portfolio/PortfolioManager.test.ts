/**
 * Tests for PortfolioManager
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../../src/portfolio/PortfolioManager.js';

describe('PortfolioManager', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;
  
  beforeEach(async () => {
    // Create a unique test directory path (but don't create it yet)
    testDir = path.join(tmpdir(), `portfolio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
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
    
    // Reset singleton to ensure clean state for next test
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
  });
  
  describe('getInstance', () => {
    it('should create singleton instance', () => {
      const instance1 = PortfolioManager.getInstance();
      const instance2 = PortfolioManager.getInstance();
      expect(instance1).toBe(instance2);
    });
    
    it('should use default directory when no config provided', () => {
      portfolioManager = PortfolioManager.getInstance();
      const baseDir = portfolioManager.getBaseDir();
      expect(baseDir).toMatch(/\.dollhouse[/\\]portfolio$/);
    });
    
    it('should use config baseDir when provided', () => {
      const customDir = path.join(testDir, 'custom-portfolio');
      portfolioManager = PortfolioManager.getInstance({ baseDir: customDir });
      expect(portfolioManager.getBaseDir()).toBe(customDir);
    });
    
    it('should prioritize environment variable over config', () => {
      const envDir = path.join(testDir, 'env-portfolio');
      const configDir = path.join(testDir, 'config-portfolio');
      
      process.env.DOLLHOUSE_PORTFOLIO_DIR = envDir;
      portfolioManager = PortfolioManager.getInstance({ baseDir: configDir });
      
      expect(portfolioManager.getBaseDir()).toBe(envDir);
    });
  });
  
  describe('initialize', () => {
    beforeEach(() => {
      // Reset singleton to ensure clean state
      (PortfolioManager as any).instance = undefined;
      (PortfolioManager as any).initializationPromise = null;
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
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
  });
  
  describe('exists', () => {
    beforeEach(() => {
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
    });
    
    it('should return false when portfolio does not exist', async () => {
      const nonExistentDir = path.join(testDir, 'non-existent');
      // Reset singleton for new instance
      (PortfolioManager as any).instance = undefined;
      const pm = PortfolioManager.getInstance({ baseDir: nonExistentDir });
      expect(await pm.exists()).toBe(false);
    });
    
    it('should return true after initialization', async () => {
      await portfolioManager.initialize();
      expect(await portfolioManager.exists()).toBe(true);
    });
  });
  
  describe('element operations', () => {
    beforeEach(async () => {
      // Reset singleton to ensure clean state
      (PortfolioManager as any).instance = undefined;
      (PortfolioManager as any).initializationPromise = null;
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
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
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
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

    describe('common test patterns detection', () => {
      it('should filter test- patterns', () => {
        expect(portfolioManager.isTestElement('test-')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-')).toBe(true);
        expect(portfolioManager.isTestElement('test-persona.md')).toBe(true);
        expect(portfolioManager.isTestElement('testing.md')).toBe(false);
      });

      it('should filter memory-test- patterns', () => {
        expect(portfolioManager.isTestElement('memory-test-')).toBe(true);
        expect(portfolioManager.isTestElement('MEMORY-TEST-')).toBe(true);
        expect(portfolioManager.isTestElement('memory-test-agent.md')).toBe(true);
        expect(portfolioManager.isTestElement('memory-safe.md')).toBe(false);
      });

      it('should filter yaml-test patterns', () => {
        expect(portfolioManager.isTestElement('yaml-test')).toBe(true);
        expect(portfolioManager.isTestElement('YAML-TEST')).toBe(true);
        expect(portfolioManager.isTestElement('yaml-test-file.md')).toBe(true);
        expect(portfolioManager.isTestElement('yaml-safe.md')).toBe(false);
      });

      it('should filter perf-test- patterns', () => {
        expect(portfolioManager.isTestElement('perf-test-')).toBe(true);
        expect(portfolioManager.isTestElement('PERF-TEST-')).toBe(true);
        expect(portfolioManager.isTestElement('perf-test-benchmark.md')).toBe(true);
        expect(portfolioManager.isTestElement('performance.md')).toBe(false);
      });

      it('should filter stability-test- patterns', () => {
        expect(portfolioManager.isTestElement('stability-test-')).toBe(true);
        expect(portfolioManager.isTestElement('STABILITY-TEST-')).toBe(true);
        expect(portfolioManager.isTestElement('stability-test-0.md')).toBe(true);
        expect(portfolioManager.isTestElement('stability-check.md')).toBe(false);
      });

      it('should filter roundtrip-test patterns', () => {
        expect(portfolioManager.isTestElement('roundtrip-test')).toBe(true);
        expect(portfolioManager.isTestElement('ROUNDTRIP-TEST')).toBe(true);
        expect(portfolioManager.isTestElement('roundtrip-test-case.md')).toBe(true);
        expect(portfolioManager.isTestElement('roundtrip-safe.md')).toBe(false);
      });

      it('should filter test-persona patterns', () => {
        expect(portfolioManager.isTestElement('test-persona')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-PERSONA')).toBe(true);
        expect(portfolioManager.isTestElement('my-test-persona.md')).toBe(true);
        expect(portfolioManager.isTestElement('persona-safe.md')).toBe(false);
      });

      it('should filter test-skill patterns', () => {
        expect(portfolioManager.isTestElement('test-skill')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-SKILL')).toBe(true);
        expect(portfolioManager.isTestElement('my-test-skill.md')).toBe(true);
        expect(portfolioManager.isTestElement('skill-safe.md')).toBe(false);
      });

      it('should filter test-template patterns', () => {
        expect(portfolioManager.isTestElement('test-template')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-TEMPLATE')).toBe(true);
        expect(portfolioManager.isTestElement('my-test-template.md')).toBe(true);
        expect(portfolioManager.isTestElement('template-safe.md')).toBe(false);
      });

      it('should filter test-agent patterns', () => {
        expect(portfolioManager.isTestElement('test-agent')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-AGENT')).toBe(true);
        expect(portfolioManager.isTestElement('my-test-agent.md')).toBe(true);
        expect(portfolioManager.isTestElement('agent-safe.md')).toBe(false);
      });

      it('should filter .test. patterns', () => {
        expect(portfolioManager.isTestElement('file.test.md')).toBe(true);
        expect(portfolioManager.isTestElement('component.test.js')).toBe(true);
        expect(portfolioManager.isTestElement('testing.md')).toBe(false);
        expect(portfolioManager.isTestElement('test.md')).toBe(false);
      });

      it('should filter __test__ patterns', () => {
        expect(portfolioManager.isTestElement('__test__')).toBe(true);
        expect(portfolioManager.isTestElement('file__test__.md')).toBe(true);
        expect(portfolioManager.isTestElement('__test__file.md')).toBe(true);
        expect(portfolioManager.isTestElement('test.md')).toBe(false);
      });

      it('should filter test-data patterns', () => {
        expect(portfolioManager.isTestElement('test-data')).toBe(true);
        expect(portfolioManager.isTestElement('TEST-DATA')).toBe(true);
        expect(portfolioManager.isTestElement('my-test-data.md')).toBe(true);
        expect(portfolioManager.isTestElement('data-safe.md')).toBe(false);
      });

      it('should filter penetration-test patterns', () => {
        expect(portfolioManager.isTestElement('penetration-test')).toBe(true);
        expect(portfolioManager.isTestElement('PENETRATION-TEST')).toBe(true);
        expect(portfolioManager.isTestElement('security-penetration-test.md')).toBe(true);
        expect(portfolioManager.isTestElement('penetration-safe.md')).toBe(false);
      });

      it('should filter metadata-test patterns', () => {
        expect(portfolioManager.isTestElement('metadata-test')).toBe(true);
        expect(portfolioManager.isTestElement('METADATA-TEST')).toBe(true);
        expect(portfolioManager.isTestElement('yaml-metadata-test.md')).toBe(true);
        expect(portfolioManager.isTestElement('metadata-safe.md')).toBe(false);
      });

      it('should filter testpersona timestamp patterns', () => {
        expect(portfolioManager.isTestElement('testpersona1')).toBe(true);
        expect(portfolioManager.isTestElement('TESTPERSONA1')).toBe(true);
        expect(portfolioManager.isTestElement('testpersona123')).toBe(true);
        expect(portfolioManager.isTestElement('testpersona1234567890')).toBe(true);
        expect(portfolioManager.isTestElement('testpersona')).toBe(false);
        expect(portfolioManager.isTestElement('persona-safe.md')).toBe(false);
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

      it('should handle special characters', () => {
        expect(portfolioManager.isTestElement('test-!@#$%.md')).toBe(true);
        expect(portfolioManager.isTestElement('eval-<script>.md')).toBe(true);
        expect(portfolioManager.isTestElement('safe-!@#$%.md')).toBe(false);
      });

      it('should handle unicode characters', () => {
        expect(portfolioManager.isTestElement('test-文件.md')).toBe(true);
        expect(portfolioManager.isTestElement('eval-тест.md')).toBe(true);
        expect(portfolioManager.isTestElement('安全-文件.md')).toBe(false);
      });

      it('should handle very long filenames', () => {
        const longFilename = 'test-' + 'a'.repeat(1000) + '.md';
        expect(portfolioManager.isTestElement(longFilename)).toBe(true);
        
        const safeLongFilename = 'safe-' + 'a'.repeat(1000) + '.md';
        expect(portfolioManager.isTestElement(safeLongFilename)).toBe(false);
      });

      it('should handle path separators correctly', () => {
        expect(portfolioManager.isTestElement('test-file/path.md')).toBe(true);
        expect(portfolioManager.isTestElement('test-file\\path.md')).toBe(true);
        expect(portfolioManager.isTestElement('safe-file/path.md')).toBe(false);
      });

      it('should be case insensitive for all patterns', () => {
        const testCases = [
          ['test-file', 'TEST-file', 'Test-FILE'],
          ['eval-code', 'EVAL-code', 'Eval-CODE'],
          ['shell-injection', 'SHELL-injection', 'Shell-INJECTION']
        ];

        testCases.forEach(cases => {
          cases.forEach(testCase => {
            expect(portfolioManager.isTestElement(testCase)).toBe(true);
          });
        });
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
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
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