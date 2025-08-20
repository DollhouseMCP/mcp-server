/**
 * Integration tests for isTestElement() filtering across all element managers
 * Verifies that dangerous and test elements are filtered consistently
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { PortfolioManager, ElementType } from '../../../../src/portfolio/PortfolioManager.js';

describe('Portfolio Filtering Integration', () => {
  let testDir: string;
  let portfolioManager: PortfolioManager;
  const originalEnv = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  beforeEach(async () => {
    // Create a unique test directory
    testDir = path.join(tmpdir(), `portfolio-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    
    // Clear environment variable
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
    
    // Initialize managers
    portfolioManager = PortfolioManager.getInstance({ baseDir: testDir });
    await portfolioManager.initialize();
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
    
    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
  });

  describe('dangerous pattern filtering across element types', () => {
    const dangerousFiles = [
      'eval-malicious-code.md',
      'exec-dangerous-command.md',
      'bash-c-rm-rf.md',
      'sh-c-malware.md',
      'powershell-bypass.md',
      'cmd-c-exploit.md',
      'shell-injection-attack.md',
      'bin-sh-reverse.md',
      'rm-rf-everything.md',
      'nc-e-bin-backdoor.md',
      'python-c-import-os.md',
      'curl-evil-payload.md',
      'wget-malicious-script.md'
    ];

    it('should filter dangerous files from PortfolioManager.listElements() across all element types', async () => {
      // Test all element types
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];
      
      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);
        
        // Create dangerous files
        for (const filename of dangerousFiles) {
          await fs.writeFile(path.join(elementDir, filename), `# Dangerous ${filename}\nContent goes here.`);
        }
        
        // Create legitimate files
        await fs.writeFile(path.join(elementDir, 'legitimate-file.md'), '# Legitimate File\nSafe content.');
        await fs.writeFile(path.join(elementDir, 'another-safe-file.md'), '# Another Safe File\nMore safe content.');
        
        // List elements - should only return legitimate files
        const elements = await portfolioManager.listElements(elementType);
        
        // Verify no dangerous files are returned
        for (const filename of dangerousFiles) {
          expect(elements).not.toContain(filename);
        }
        
        // Verify legitimate files are returned
        expect(elements).toContain('legitimate-file.md');
        expect(elements).toContain('another-safe-file.md');
        expect(elements).toHaveLength(2);
      }
    });

    it('should verify centralized filtering through PortfolioManager', async () => {
      // Test that all dangerous patterns are consistently filtered
      for (const filename of dangerousFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(true);
      }
      
      // Test that legitimate files are not filtered
      const legitimateFiles = [
        'legitimate-file.md',
        'production-agent.md',
        'code-assistant.md',
        'data-analysis.md',
        'meeting-notes.md'
      ];
      
      for (const filename of legitimateFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(false);
      }
    });
  });

  describe('test pattern filtering across element types', () => {
    const testFiles = [
      'test-persona.md',
      'memory-test-agent.md',
      'yaml-test-skill.md',
      'perf-test-template.md',
      'stability-test-1.md',
      'roundtrip-test-data.md',
      'test-agent.md',
      'test-skill.md',
      'test-template.md',
      'file.test.md',
      '__test__file.md',
      'test-data-sample.md',
      'penetration-test-case.md',
      'metadata-test-file.md',
      'testpersona123.md'
    ];

    it('should filter test files consistently across all element types', async () => {
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];
      
      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);
        
        // Create test files
        for (const filename of testFiles) {
          await fs.writeFile(path.join(elementDir, filename), `# Test File: ${filename}\nThis is test content.`);
        }
        
        // Create legitimate files
        await fs.writeFile(path.join(elementDir, 'production-ready.md'), '# Production Element\nProduction ready content.');
        
        // List elements via PortfolioManager
        const elements = await portfolioManager.listElements(elementType);
        
        // Should only contain legitimate files
        expect(elements).toHaveLength(1);
        expect(elements).toContain('production-ready.md');
        
        // Verify test files are filtered
        for (const filename of testFiles) {
          expect(elements).not.toContain(filename);
        }
      }
    });
    
    it('should verify test pattern recognition', () => {
      // Test that all test patterns are correctly identified
      for (const filename of testFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(true);
      }
    });
  });

  describe('centralized filtering verification', () => {
    it('should provide centralized isTestElement method', () => {
      // Verify the method exists and is callable
      expect(typeof portfolioManager.isTestElement).toBe('function');
      
      // Verify it works for both dangerous and test patterns
      expect(portfolioManager.isTestElement('eval-dangerous.md')).toBe(true);
      expect(portfolioManager.isTestElement('test-file.md')).toBe(true);
      expect(portfolioManager.isTestElement('legitimate-file.md')).toBe(false);
    });

    it('should maintain consistent filtering behavior', () => {
      // Test a mix of patterns to ensure consistency
      const testCases = [
        { filename: 'eval-code.md', shouldFilter: true },
        { filename: 'exec-command.md', shouldFilter: true },
        { filename: 'shell-injection.md', shouldFilter: true },
        { filename: 'test-persona.md', shouldFilter: true },
        { filename: 'stability-test-1.md', shouldFilter: true },
        { filename: 'legitimate-agent.md', shouldFilter: false },
        { filename: 'production-skill.md', shouldFilter: false },
        { filename: 'user-template.md', shouldFilter: false }
      ];
      
      for (const testCase of testCases) {
        expect(portfolioManager.isTestElement(testCase.filename)).toBe(testCase.shouldFilter);
      }
    });
  });

  describe('integration edge cases', () => {
    it('should handle mixed legitimate and dangerous files correctly', async () => {
      const testDir = portfolioManager.getElementDir(ElementType.AGENT);
      
      // Create a mix of files
      const files = [
        { name: 'eval-attack.md', shouldFilter: true },
        { name: 'legitimate-agent.md', shouldFilter: false },
        { name: 'test-persona.md', shouldFilter: true },
        { name: 'code-assistant.md', shouldFilter: false },
        { name: 'shell-injection.md', shouldFilter: true },
        { name: 'data-processor.md', shouldFilter: false }
      ];
      
      for (const file of files) {
        await fs.writeFile(path.join(testDir, file.name), `# ${file.name}\nContent for ${file.name}`);
      }
      
      // List elements through PortfolioManager
      const elements = await portfolioManager.listElements(ElementType.AGENT);
      
      // Verify filtering - only legitimate files should be returned
      const expectedFiles = files.filter(f => !f.shouldFilter).map(f => f.name);
      expect(elements).toHaveLength(expectedFiles.length);
      
      for (const expectedFile of expectedFiles) {
        expect(elements).toContain(expectedFile);
      }
      
      // Verify dangerous files are filtered out
      const filteredFiles = files.filter(f => f.shouldFilter).map(f => f.name);
      for (const filteredFile of filteredFiles) {
        expect(elements).not.toContain(filteredFile);
      }
    });
    
    it('should work consistently across different element directories', async () => {
      const testFileName = 'eval-dangerous.md';
      const safeFileName = 'safe-element.md';
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];
      
      // Create files in each directory
      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await fs.writeFile(path.join(elementDir, testFileName), '# Dangerous\nDangerous content');
        await fs.writeFile(path.join(elementDir, safeFileName), '# Safe\nSafe content');
      }
      
      // Verify consistent filtering across all directories
      for (const elementType of elementTypes) {
        const elements = await portfolioManager.listElements(elementType);
        expect(elements).toHaveLength(1);
        expect(elements).toContain(safeFileName);
        expect(elements).not.toContain(testFileName);
      }
    });
  });
});