/**
 * Integration tests for Skill trigger extraction with Enhanced Index
 * Verifies that Skills with triggers are properly indexed and searchable
 * (Issue #1121)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EnhancedIndexManager } from '../../src/portfolio/EnhancedIndexManager.js';
import { PortfolioIndexManager } from '../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Skill Enhanced Index Integration', () => {
  let tempDir: string;
  let skillsDir: string;
  let enhancedIndex: EnhancedIndexManager;
  let portfolioIndex: PortfolioIndexManager;

  beforeEach(async () => {
    // Create temporary directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-test-'));
    skillsDir = path.join(tempDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    // Mock portfolio paths
    jest.spyOn(PortfolioManager, 'getInstance').mockReturnValue({
      getElementDir: (type: ElementType) => {
        if (type === ElementType.SKILL) return skillsDir;
        return path.join(tempDir, type);
      },
      getPortfolioDir: () => tempDir,
      listElements: jest.fn().mockResolvedValue([])
    } as any);

    // Create instances
    portfolioIndex = PortfolioIndexManager.getInstance();
    enhancedIndex = EnhancedIndexManager.getInstance();

    // Mock the index file path
    jest.spyOn(enhancedIndex as any, 'indexFilePath', 'get').mockReturnValue(
      path.join(tempDir, 'capability-index.yaml')
    );
  });

  afterEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }

    // Clear singletons
    (PortfolioIndexManager as any).instance = null;
    (EnhancedIndexManager as any).instance = null;
  });

  describe('Skill Trigger Indexing', () => {
    it('should index skills with triggers and make them searchable', async () => {
      // Create test skills with triggers
      const debugSkill = `---
name: Debug Detective
description: Advanced debugging and troubleshooting skill
version: 1.0.0
triggers:
  - debug
  - troubleshoot
  - investigate
  - diagnose
---

# Debug Detective Instructions
Expert debugging techniques and strategies.`;

      const analyzeSkill = `---
name: Code Analyzer
description: Static code analysis and review
version: 1.0.0
triggers:
  - analyze
  - review
  - audit
  - validate
---

# Code Analyzer Instructions
Comprehensive code analysis procedures.`;

      await fs.writeFile(path.join(skillsDir, 'debug-detective.md'), debugSkill);
      await fs.writeFile(path.join(skillsDir, 'code-analyzer.md'), analyzeSkill);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // Test verb search for "debug"
      const debugResults = await enhancedIndex.searchByVerb('debug');
      expect(debugResults).toBeDefined();
      expect(debugResults.length).toBeGreaterThan(0);
      expect(debugResults.some(r => r.element === 'Debug Detective')).toBe(true);

      // Test verb search for "analyze"
      const analyzeResults = await enhancedIndex.searchByVerb('analyze');
      expect(analyzeResults).toBeDefined();
      expect(analyzeResults.length).toBeGreaterThan(0);
      expect(analyzeResults.some(r => r.element === 'Code Analyzer')).toBe(true);

      // Test verb search for "troubleshoot"
      const troubleshootResults = await enhancedIndex.searchByVerb('troubleshoot');
      expect(troubleshootResults).toBeDefined();
      expect(troubleshootResults.length).toBeGreaterThan(0);
      expect(troubleshootResults.some(r => r.element === 'Debug Detective')).toBe(true);
    });

    it('should handle skills without triggers', async () => {
      // Create skill without triggers
      const simpleSkill = `---
name: Simple Skill
description: A basic skill without triggers
version: 1.0.0
---

# Simple Skill Instructions`;

      await fs.writeFile(path.join(skillsDir, 'simple-skill.md'), simpleSkill);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // Verify skill is indexed but not in trigger searches
      const index = await enhancedIndex.getIndex();
      expect(index.elements[ElementType.SKILL]).toBeDefined();
      expect(index.elements[ElementType.SKILL]['Simple Skill']).toBeDefined();

      // Should not appear in verb searches
      const results = await enhancedIndex.searchByVerb('debug');
      expect(results.every(r => r.element !== 'Simple Skill')).toBe(true);
    });

    it('should handle multiple skills with overlapping triggers', async () => {
      // Create skills with some overlapping triggers
      const skill1 = `---
name: Optimizer Pro
description: Performance optimization skill
version: 1.0.0
triggers:
  - optimize
  - improve
  - enhance
---

# Instructions`;

      const skill2 = `---
name: Code Enhancer
description: Code improvement skill
version: 1.0.0
triggers:
  - enhance
  - refactor
  - improve
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, 'optimizer-pro.md'), skill1);
      await fs.writeFile(path.join(skillsDir, 'code-enhancer.md'), skill2);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // Test overlapping trigger "improve"
      const improveResults = await enhancedIndex.searchByVerb('improve');
      expect(improveResults).toBeDefined();
      expect(improveResults.length).toBeGreaterThanOrEqual(2);
      expect(improveResults.some(r => r.element === 'Optimizer Pro')).toBe(true);
      expect(improveResults.some(r => r.element === 'Code Enhancer')).toBe(true);

      // Test unique trigger "optimize"
      const optimizeResults = await enhancedIndex.searchByVerb('optimize');
      expect(optimizeResults).toBeDefined();
      expect(optimizeResults.some(r => r.element === 'Optimizer Pro')).toBe(true);
      expect(optimizeResults.every(r => r.element !== 'Code Enhancer')).toBe(true);

      // Test unique trigger "refactor"
      const refactorResults = await enhancedIndex.searchByVerb('refactor');
      expect(refactorResults).toBeDefined();
      expect(refactorResults.some(r => r.element === 'Code Enhancer')).toBe(true);
      expect(refactorResults.every(r => r.element !== 'Optimizer Pro')).toBe(true);
    });

    it('should properly filter invalid triggers during indexing', async () => {
      // Create skill with mixed valid/invalid triggers
      const mixedSkill = `---
name: Mixed Triggers Skill
description: Skill with various trigger formats
version: 1.0.0
triggers:
  - valid-trigger
  - "has spaces"
  - "@invalid!"
  - another-valid
  - ""
  - 123numeric
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, 'mixed-triggers.md'), mixedSkill);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // Only valid triggers should be searchable
      const validResults = await enhancedIndex.searchByVerb('valid-trigger');
      expect(validResults.some(r => r.element === 'Mixed Triggers Skill')).toBe(true);

      const anotherResults = await enhancedIndex.searchByVerb('another-valid');
      expect(anotherResults.some(r => r.element === 'Mixed Triggers Skill')).toBe(true);

      const numericResults = await enhancedIndex.searchByVerb('123numeric');
      expect(numericResults.some(r => r.element === 'Mixed Triggers Skill')).toBe(true);

      // Invalid triggers should not work
      const spacesResults = await enhancedIndex.searchByVerb('has spaces');
      expect(spacesResults.length).toBe(0);

      const invalidResults = await enhancedIndex.searchByVerb('@invalid!');
      expect(invalidResults.length).toBe(0);
    });

    it('should respect trigger limit of 20 per skill', async () => {
      // Create skill with many triggers
      const manyTriggers = Array.from({ length: 30 }, (_, i) => `trigger${i}`);
      const manyTriggersSkill = `---
name: Many Triggers Skill
description: Skill with excessive triggers
version: 1.0.0
triggers: ${JSON.stringify(manyTriggers)}
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, 'many-triggers.md'), manyTriggersSkill);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // First 20 triggers should be searchable
      for (let i = 0; i < 20; i++) {
        const results = await enhancedIndex.searchByVerb(`trigger${i}`);
        expect(results.some(r => r.element === 'Many Triggers Skill')).toBe(true);
      }

      // Triggers beyond 20 should not be indexed
      for (let i = 20; i < 25; i++) {
        const results = await enhancedIndex.searchByVerb(`trigger${i}`);
        expect(results.every(r => r.element !== 'Many Triggers Skill')).toBe(true);
      }
    });
  });

  describe('Cross-Element Type Trigger Search', () => {
    it('should return skills alongside other element types in verb searches', async () => {
      // Create a skill
      const skill = `---
name: Debug Skill
description: Debugging skill
version: 1.0.0
triggers:
  - debug
  - fix
---

# Instructions`;

      // Create a persona directory and file
      const personasDir = path.join(tempDir, 'personas');
      await fs.mkdir(personasDir, { recursive: true });

      const persona = `---
name: Debug Persona
description: Debugging focused persona
version: 1.0.0
triggers:
  - debug
  - investigate
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, 'debug-skill.md'), skill);
      await fs.writeFile(path.join(personasDir, 'debug-persona.md'), persona);

      // Rebuild indices
      await portfolioIndex.rebuildIndex();
      await enhancedIndex.rebuildIndex();

      // Search for "debug" should return both
      const debugResults = await enhancedIndex.searchByVerb('debug');
      expect(debugResults).toBeDefined();
      expect(debugResults.length).toBeGreaterThanOrEqual(2);

      const resultNames = debugResults.map(r => r.element);
      expect(resultNames).toContain('Debug Skill');
      expect(resultNames).toContain('Debug Persona');

      // Search for "fix" should only return skill
      const fixResults = await enhancedIndex.searchByVerb('fix');
      expect(fixResults.some(r => r.element === 'Debug Skill')).toBe(true);
      expect(fixResults.every(r => r.element !== 'Debug Persona')).toBe(true);

      // Search for "investigate" should only return persona
      const investigateResults = await enhancedIndex.searchByVerb('investigate');
      expect(investigateResults.some(r => r.element === 'Debug Persona')).toBe(true);
      expect(investigateResults.every(r => r.element !== 'Debug Skill')).toBe(true);
    });
  });
});