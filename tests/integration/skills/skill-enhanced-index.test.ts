/**
 * Integration tests for Skill trigger extraction with Enhanced Index
 * Verifies that Skills with triggers are properly indexed and searchable
 * (Issue #1121)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ElementType } from '../../../src/portfolio/types.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createIntegrationContainer, IntegrationContainer } from '../../helpers/integration-container.js';
import { PortfolioIndexManager } from '../../../src/portfolio/PortfolioIndexManager.js';
import { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';

describe('Skill Enhanced Index Integration', () => {
  let tempDir: string;
  let skillsDir: string;
  let enhancedIndex: EnhancedIndexManager;
  let portfolioIndex: PortfolioIndexManager;
  let originalTestConfigDir: string | undefined;
  let containerContext: IntegrationContainer;
  let originalIndexPath: string | undefined;

  beforeEach(async () => {
    // Create temporary directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-test-'));

    originalTestConfigDir = process.env.TEST_CONFIG_DIR;
    process.env.TEST_CONFIG_DIR = tempDir;

    containerContext = await createIntegrationContainer({
      portfolioDir: path.join(tempDir, '.dollhouse', 'portfolio')
    });
    skillsDir = path.join(containerContext.portfolioDir, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });

    containerContext.container.resolve<IndexConfigManager>('IndexConfigManager');
    containerContext.container.resolve('ConfigManager');
    portfolioIndex = containerContext.container.resolve<PortfolioIndexManager>('PortfolioIndexManager');
    enhancedIndex = containerContext.container.resolve<EnhancedIndexManager>('EnhancedIndexManager');

    // Mock the index file path
    originalIndexPath = Reflect.get(enhancedIndex as any, 'indexPath');
    Reflect.set(enhancedIndex as any, 'indexPath', path.join(tempDir, 'capability-index.yaml'));
  });

  afterEach(async () => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    if (originalIndexPath !== undefined) {
      Reflect.set(enhancedIndex as any, 'indexPath', originalIndexPath);
      originalIndexPath = undefined;
    }

    await containerContext.dispose();

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (originalTestConfigDir !== undefined) {
      process.env.TEST_CONFIG_DIR = originalTestConfigDir;
    } else {
      delete process.env.TEST_CONFIG_DIR;
    }
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // Test verb search for "debug"
      const debugResults = await enhancedIndex.getElementsByAction('debug');
      expect(debugResults).toBeDefined();
      expect(debugResults.length).toBeGreaterThan(0);
      expect(debugResults).toEqual(expect.arrayContaining(['Debug Detective']));

      // Test verb search for "analyze"
      const analyzeResults = await enhancedIndex.getElementsByAction('analyze');
      expect(analyzeResults).toBeDefined();
      expect(analyzeResults.length).toBeGreaterThan(0);
      expect(analyzeResults).toEqual(expect.arrayContaining(['Code Analyzer']));

      // Test verb search for "troubleshoot"
      const troubleshootResults = await enhancedIndex.getElementsByAction('troubleshoot');
      expect(troubleshootResults).toBeDefined();
      expect(troubleshootResults.length).toBeGreaterThan(0);
      expect(troubleshootResults).toEqual(expect.arrayContaining(['Debug Detective']));
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // Verify skill is indexed but not in trigger searches
      const index = await enhancedIndex.getIndex();
      expect(index.elements[ElementType.SKILL]).toBeDefined();
      expect(index.elements[ElementType.SKILL]['Simple Skill']).toBeDefined();

      // Should not appear in verb searches
      const results = await enhancedIndex.getElementsByAction('debug');
      expect(results.every(name => name !== 'Simple Skill')).toBe(true);
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // Test overlapping trigger "improve"
      const improveResults = await enhancedIndex.getElementsByAction('improve');
      expect(improveResults).toBeDefined();
      expect(improveResults.length).toBeGreaterThanOrEqual(2);
      expect(improveResults).toEqual(expect.arrayContaining(['Optimizer Pro', 'Code Enhancer']));

      // Test unique trigger "optimize"
      const optimizeResults = await enhancedIndex.getElementsByAction('optimize');
      expect(optimizeResults).toBeDefined();
      expect(optimizeResults).toContain('Optimizer Pro');
      expect(optimizeResults).not.toContain('Code Enhancer');

      // Test unique trigger "refactor"
      const refactorResults = await enhancedIndex.getElementsByAction('refactor');
      expect(refactorResults).toBeDefined();
      expect(refactorResults).toContain('Code Enhancer');
      expect(refactorResults).not.toContain('Optimizer Pro');
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // Only valid triggers should be searchable
      const validResults = await enhancedIndex.getElementsByAction('valid-trigger');
      expect(validResults).toContain('Mixed Triggers Skill');

      const anotherResults = await enhancedIndex.getElementsByAction('another-valid');
      expect(anotherResults).toContain('Mixed Triggers Skill');

      const numericResults = await enhancedIndex.getElementsByAction('123numeric');
      expect(numericResults).toHaveLength(0);

      // Invalid triggers should not work
      const spacesResults = await enhancedIndex.getElementsByAction('has spaces');
      expect(spacesResults.length).toBe(0);

      const invalidResults = await enhancedIndex.getElementsByAction('@invalid!');
      expect(invalidResults.length).toBe(0);
    });

    it('should respect trigger limit of 20 per skill', async () => {
      // Create skill with many triggers
      const triggerLimit = 50;
      const extraTriggers = 5;
      const manyTriggers = Array.from({ length: triggerLimit + extraTriggers }, (_, i) =>
        `trigger${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`
      );
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // First 20 triggers should be searchable
      for (let i = 0; i < triggerLimit; i++) {
        const results = await enhancedIndex.getElementsByAction(manyTriggers[i]);
        expect(results).toContain('Many Triggers Skill');
      }

      // Triggers beyond 20 should not be indexed
      for (let i = triggerLimit; i < triggerLimit + extraTriggers; i++) {
        const results = await enhancedIndex.getElementsByAction(manyTriggers[i]);
        expect(results).not.toContain('Many Triggers Skill');
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
      const personasDir = path.join(containerContext.portfolioDir, 'personas');
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
      await enhancedIndex.getIndex({ forceRebuild: true });

      // Search for "debug" should return both
      const debugResults = await enhancedIndex.getElementsByAction('debug');
      expect(debugResults).toBeDefined();
      expect(debugResults.length).toBeGreaterThanOrEqual(2);
      expect(debugResults).toEqual(expect.arrayContaining(['Debug Skill', 'Debug Persona']));

      // Search for "fix" should only return skill
      const fixResults = await enhancedIndex.getElementsByAction('fix');
      expect(fixResults).toContain('Debug Skill');
      expect(fixResults).not.toContain('Debug Persona');

      // Search for "investigate" should only return persona
      const investigateResults = await enhancedIndex.getElementsByAction('investigate');
      expect(investigateResults).toContain('Debug Persona');
      expect(investigateResults).not.toContain('Debug Skill');
    });
  });
});
