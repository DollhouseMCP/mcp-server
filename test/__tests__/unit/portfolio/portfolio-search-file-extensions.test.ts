/**
 * Integration test for portfolio search file extension display
 *
 * Tests Issue #1213 fix:
 * - Portfolio search should display .yaml extension for memories
 * - Portfolio search should display .md extension for other element types
 *
 * This test verifies the formatting logic in src/index.ts search_portfolio handler
 * correctly displays file extensions based on element type.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { PortfolioManager, ElementType } from '../../../../src/portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../../../../src/portfolio/PortfolioIndexManager.js';
import type { SearchResult } from '../../../../src/portfolio/PortfolioIndexManager.js';

describe('Portfolio Search File Extension Display (Issue #1213)', () => {
  let testPortfolioDir: string;
  let portfolioManager: PortfolioManager;
  let indexManager: PortfolioIndexManager;

  beforeEach(async () => {
    // Create a unique test portfolio directory
    testPortfolioDir = path.join(homedir(), '.dollhouse', 'portfolio-test-' + Date.now());
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testPortfolioDir;

    // Initialize portfolio manager and index manager
    portfolioManager = PortfolioManager.getInstance({ baseDir: testPortfolioDir });
    await portfolioManager.initialize();

    indexManager = PortfolioIndexManager.getInstance();
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testPortfolioDir, { recursive: true, force: true });
    } catch (error) {
      // Test directory cleanup failed - this is acceptable as it's test cleanup
      // and doesn't affect test results. Log for debugging purposes.
      console.debug('Test cleanup warning:', error instanceof Error ? error.message : String(error));
    }
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Reset singleton
    (PortfolioManager as any).instance = null;
  });

  describe('File Extension Mapping', () => {
    it('should return .yaml extension for memory element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.MEMORY);
      expect(extension).toBe('.yaml');
    });

    it('should return .md extension for persona element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.PERSONA);
      expect(extension).toBe('.md');
    });

    it('should return .md extension for skill element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.SKILL);
      expect(extension).toBe('.md');
    });

    it('should return .md extension for template element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.TEMPLATE);
      expect(extension).toBe('.md');
    });

    it('should return .md extension for agent element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.AGENT);
      expect(extension).toBe('.md');
    });

    it('should return .md extension for ensemble element type', () => {
      const extension = portfolioManager.getFileExtension(ElementType.ENSEMBLE);
      expect(extension).toBe('.md');
    });
  });

  describe('Search Result Formatting', () => {
    beforeEach(async () => {
      // Create test files for each element type

      // Memory (YAML format)
      const memoryDir = path.join(testPortfolioDir, ElementType.MEMORY, '2025-09-30');
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(
        path.join(memoryDir, 'test-memory.yaml'),
        `name: test-memory
description: Test memory for file extension display
version: 1.0.0
retention: permanent
tags:
  - test
entries: []`
      );

      // Persona (Markdown format)
      const personaDir = path.join(testPortfolioDir, ElementType.PERSONA);
      await fs.writeFile(
        path.join(personaDir, 'test-persona.md'),
        `---
name: test-persona
description: Test persona for file extension display
version: 1.0.0
tags:
  - test
---

# Test Persona

This is a test persona.`
      );

      // Skill (Markdown format)
      const skillDir = path.join(testPortfolioDir, ElementType.SKILL);
      await fs.writeFile(
        path.join(skillDir, 'test-skill.md'),
        `---
name: test-skill
description: Test skill for file extension display
version: 1.0.0
tags:
  - test
---

# Test Skill

This is a test skill.`
      );

      // Template (Markdown format)
      const templateDir = path.join(testPortfolioDir, ElementType.TEMPLATE);
      await fs.writeFile(
        path.join(templateDir, 'test-template.md'),
        `---
name: test-template
description: Test template for file extension display
version: 1.0.0
tags:
  - test
---

# Test Template

This is a test template.`
      );

      // Rebuild index
      await indexManager.rebuildIndex();
    });

    it('should format memory search results with .yaml extension', async () => {
      const results = await indexManager.search('test-memory', {
        maxResults: 10
      });

      expect(results.length).toBeGreaterThan(0);
      const memoryResult = results.find((r: SearchResult) => r.entry.elementType === ElementType.MEMORY);

      expect(memoryResult).toBeDefined();
      expect(memoryResult!.entry.elementType).toBe(ElementType.MEMORY);

      // Verify the filename doesn't have .md appended
      const extension = portfolioManager.getFileExtension(memoryResult!.entry.elementType);
      expect(extension).toBe('.yaml');

      // Simulate the formatting logic from src/index.ts
      const formattedFileName = `${memoryResult!.entry.filename}${extension}`;
      expect(formattedFileName).toBe('test-memory.yaml');
      expect(formattedFileName).not.toContain('.md');
    });

    it('should format persona search results with .md extension', async () => {
      const results = await indexManager.search('test-persona', {
        maxResults: 10
      });

      expect(results.length).toBeGreaterThan(0);
      const personaResult = results.find((r: SearchResult) => r.entry.elementType === ElementType.PERSONA);

      expect(personaResult).toBeDefined();
      expect(personaResult!.entry.elementType).toBe(ElementType.PERSONA);

      const extension = portfolioManager.getFileExtension(personaResult!.entry.elementType);
      expect(extension).toBe('.md');

      const formattedFileName = `${personaResult!.entry.filename}${extension}`;
      expect(formattedFileName).toBe('test-persona.md');
    });

    it('should format skill search results with .md extension', async () => {
      const results = await indexManager.search('test-skill', {
        maxResults: 10
      });

      expect(results.length).toBeGreaterThan(0);
      const skillResult = results.find((r: SearchResult) => r.entry.elementType === ElementType.SKILL);

      expect(skillResult).toBeDefined();
      expect(skillResult!.entry.elementType).toBe(ElementType.SKILL);

      const extension = portfolioManager.getFileExtension(skillResult!.entry.elementType);
      expect(extension).toBe('.md');

      const formattedFileName = `${skillResult!.entry.filename}${extension}`;
      expect(formattedFileName).toBe('test-skill.md');
    });

    it('should format template search results with .md extension', async () => {
      const results = await indexManager.search('test-template', {
        maxResults: 10
      });

      expect(results.length).toBeGreaterThan(0);
      const templateResult = results.find((r: SearchResult) => r.entry.elementType === ElementType.TEMPLATE);

      expect(templateResult).toBeDefined();
      expect(templateResult!.entry.elementType).toBe(ElementType.TEMPLATE);

      const extension = portfolioManager.getFileExtension(templateResult!.entry.elementType);
      expect(extension).toBe('.md');

      const formattedFileName = `${templateResult!.entry.filename}${extension}`;
      expect(formattedFileName).toBe('test-template.md');
    });

    it('should correctly distinguish between memory and non-memory elements', async () => {
      const results = await indexManager.search('test', {
        maxResults: 10
      });

      expect(results.length).toBeGreaterThan(0);

      // Verify each result has correct extension
      for (const result of results) {
        const extension = portfolioManager.getFileExtension(result.entry.elementType);
        const formattedFileName = `${result.entry.filename}${extension}`;

        if (result.entry.elementType === ElementType.MEMORY) {
          expect(extension).toBe('.yaml');
          expect(formattedFileName).toMatch(/\.yaml$/);
          expect(formattedFileName).not.toMatch(/\.md$/);
        } else {
          expect(extension).toBe('.md');
          expect(formattedFileName).toMatch(/\.md$/);
          expect(formattedFileName).not.toMatch(/\.yaml$/);
        }
      }
    });
  });

  describe('Regression Tests', () => {
    it('should never hardcode .md for all element types', () => {
      // This test verifies the bug from issue #1213 doesn't return
      const memoryExt = portfolioManager.getFileExtension(ElementType.MEMORY);
      const personaExt = portfolioManager.getFileExtension(ElementType.PERSONA);

      // These should be different
      expect(memoryExt).not.toBe(personaExt);
      expect(memoryExt).toBe('.yaml');
      expect(personaExt).toBe('.md');
    });

    it('should use getFileExtension() method for dynamic extension lookup', () => {
      // Verify the method exists and works for all element types
      const elementTypes = Object.values(ElementType);

      for (const elementType of elementTypes) {
        const extension = portfolioManager.getFileExtension(elementType);
        expect(extension).toBeTruthy();
        expect(extension).toMatch(/^\.[a-z]+$/); // Should be .xyz format
      }
    });
  });
});
