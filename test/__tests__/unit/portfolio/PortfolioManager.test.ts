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
    // Create a unique test directory
    testDir = path.join(tmpdir(), `portfolio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
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
      portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
    });
    
    it('should create all element type directories', async () => {
      await portfolioManager.initialize();
      
      // Check each element type directory
      for (const elementType of Object.values(ElementType)) {
        const elementDir = path.join(testDir, elementType);
        await expect(fs.access(elementDir)).resolves.toBeUndefined();
      }
    });
    
    it('should create special directories for stateful elements', async () => {
      await portfolioManager.initialize();
      
      // Check agent state directory
      const agentStateDir = path.join(testDir, ElementType.AGENT, '.state');
      await expect(fs.access(agentStateDir)).resolves.toBeUndefined();
      
      // Check memory storage directory
      const memoryStorageDir = path.join(testDir, ElementType.MEMORY, '.storage');
      await expect(fs.access(memoryStorageDir)).resolves.toBeUndefined();
    });
    
    it('should be idempotent', async () => {
      // Initialize twice
      await portfolioManager.initialize();
      await portfolioManager.initialize();
      
      // Should not throw and directories should still exist
      for (const elementType of Object.values(ElementType)) {
        const elementDir = path.join(testDir, elementType);
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
        
        const path2 = portfolioManager.getElementPath(ElementType.PERSONA, 'test.md');
        expect(path2).toMatch(/personas[/\\]test\.md$/);
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
        expect(stats[ElementType.ENSEMBLE]).toBe(0);
        expect(stats[ElementType.AGENT]).toBe(0);
        expect(stats[ElementType.MEMORY]).toBe(0);
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