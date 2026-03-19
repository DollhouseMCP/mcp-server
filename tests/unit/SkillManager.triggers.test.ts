/**
 * Unit tests for Skill trigger extraction (Issue #1121)
 * Following pattern from MemoryManager.triggers.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Skill } from '../../src/elements/skills/Skill.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { createRealSkillManager, createTestMetadataService } from '../helpers/di-mocks.js';
import type { SkillManager } from '../../src/elements/skills/SkillManager.js';
import type { MetadataService } from '../../src/services/MetadataService.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock dependencies
jest.mock('../../src/security/securityMonitor.js');
jest.mock('../../src/utils/logger.js');

describe('SkillManager - Trigger Extraction', () => {
  let skillManager: SkillManager;
  let tempDir: string;
  let skillsDir: string;
  let testSkillPath: string;
  let portfolioManager: PortfolioManager;
  let metadataService: MetadataService;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-trigger-test-'));

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;

    // Initialize PortfolioManager with FileOperationsService
    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: tempDir });
    await portfolioManager.initialize();

    // Get skills directory
    skillsDir = portfolioManager.getElementDir(ElementType.SKILL);

    // Ensure skills directory exists
    await fs.mkdir(skillsDir, { recursive: true });

    // Create skill manager using factory function
    skillManager = createRealSkillManager(tempDir, {
      portfolioManager
    });

    // Set up mocks
    jest.clearAllMocks();

    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    testSkillPath = 'test-skill.md';
    metadataService = createTestMetadataService();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  describe('Loading Skills with Triggers', () => {
    it('should extract triggers from skill frontmatter', async () => {
      const skillContent = `---
name: Code Review Skill
description: Performs code review and analysis
version: 1.0.0
triggers:
  - analyze
  - review
  - validate
  - audit
---

# Instructions
This skill performs comprehensive code reviews.`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeDefined();
      expect(skill.metadata.triggers).toEqual(['analyze', 'review', 'validate', 'audit']);
    });

    it('should handle skills without triggers', async () => {
      const skillContent = `---
name: Basic Skill
description: A simple skill without triggers
version: 1.0.0
---

# Instructions
Basic skill instructions.`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeUndefined();
    });

    it('should filter out invalid trigger characters', async () => {
      const skillContent = `---
name: Filtered Skill
description: Skill with invalid trigger characters
version: 1.0.0
triggers:
  - valid-trigger
  - another_valid
  - "invalid trigger!"
  - "@special#chars"
  - valid123
  - "has spaces"
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeDefined();
      expect(skill.metadata.triggers).toEqual(['valid-trigger', 'another_valid', 'valid123']);
    });

    it('should limit triggers to 20 maximum', async () => {
      const manyTriggers = Array.from({ length: 30 }, (_, i) => `trigger${i}`);
      const skillContent = `---
name: Many Triggers Skill
description: Skill with many triggers
version: 1.0.0
triggers: ${JSON.stringify(manyTriggers)}
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeDefined();
      expect(skill.metadata.triggers?.length).toBe(20);
      expect(skill.metadata.triggers).toEqual(manyTriggers.slice(0, 20));
    });

    it('rejects triggers that exceed allowed length', async () => {
      const longTrigger = 'a'.repeat(100);
      const skillContent = `---
name: Long Trigger Skill
description: Skill with long trigger names
version: 1.0.0
triggers:
  - ${longTrigger}
  - normal
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      await expect(skillManager.load(testSkillPath)).rejects.toThrow(/triggers/i);
    });

    it('rejects non-array trigger values', async () => {
      const skillContent = `---
name: Invalid Triggers Skill
description: Skill with invalid trigger format
version: 1.0.0
triggers: "not an array"
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      await expect(skillManager.load(testSkillPath)).rejects.toThrow(/triggers/i);
    });

    it('rejects mixed trigger types instead of coercing them', async () => {
      const skillContent = `---
name: Mixed Types Skill
description: Skill with mixed trigger types
version: 1.0.0
triggers:
  - valid-string
  - 123
  - null
  - true
  - another-valid
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      await expect(skillManager.load(testSkillPath)).rejects.toThrow(/triggers/i);
    });
  });

  describe('Saving Skills with Triggers', () => {
    it('should preserve triggers when saving a skill', async () => {
      const skill = new Skill({
        name: 'Save Test Skill',
        description: 'Testing trigger preservation',
        version: '1.0.0',
        triggers: ['debug', 'test', 'validate']
      }, 'Test instructions', metadataService);

      await skillManager.save(skill, testSkillPath);

      // Read back and verify
      const savedContent = await fs.readFile(path.join(skillsDir, testSkillPath), 'utf-8');
      expect(savedContent).toContain('triggers:');
      expect(savedContent).toContain('- debug');
      expect(savedContent).toContain('- test');
      expect(savedContent).toContain('- validate');

      // Load and verify
      const loadedSkill = await skillManager.load(testSkillPath);
      expect(loadedSkill.metadata.triggers).toEqual(['debug', 'test', 'validate']);
    });

    it('should preserve empty triggers array when saving', async () => {
      const skill = new Skill({
        name: 'Empty Triggers Skill',
        description: 'Skill with empty triggers',
        version: '1.0.0',
        triggers: []
      }, 'Instructions', metadataService);

      await skillManager.save(skill, testSkillPath);

      // Read back and verify
      const savedContent = await fs.readFile(path.join(skillsDir, testSkillPath), 'utf-8');
      expect(savedContent).toContain('triggers: []');

      // Load and verify
      const loadedSkill = await skillManager.load(testSkillPath);
      expect(loadedSkill.metadata.triggers).toEqual([]);
    });

    it('should handle skills without triggers when saving', async () => {
      const skill = new Skill({
        name: 'No Triggers Skill',
        description: 'Skill without triggers field',
        version: '1.0.0'
      }, 'Instructions', metadataService);

      await skillManager.save(skill, testSkillPath);

      // Read back and verify
      const savedContent = await fs.readFile(path.join(skillsDir, testSkillPath), 'utf-8');
      expect(savedContent).not.toContain('triggers:');

      // Load and verify
      const loadedSkill = await skillManager.load(testSkillPath);
      expect(loadedSkill.metadata.triggers).toBeUndefined();
    });
  });

  describe('Round-trip Consistency', () => {
    it('should maintain triggers through load-save-load cycle', async () => {
      const originalTriggers = ['analyze', 'optimize', 'refactor', 'debug'];
      const skillContent = `---
name: Round Trip Skill
description: Testing round trip
version: 1.0.0
triggers: ${JSON.stringify(originalTriggers)}
---

Original instructions here.`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);

      // First load
      const skill1 = await skillManager.load(testSkillPath);
      expect(skill1.metadata.triggers).toEqual(originalTriggers);

      // Modify and save
      skill1.instructions = 'Modified instructions';
      const newPath = 'round-trip-saved.md';
      await skillManager.save(skill1, newPath);

      // Second load
      const skill2 = await skillManager.load(newPath);
      expect(skill2.metadata.triggers).toEqual(originalTriggers);
      expect(skill2.instructions).toContain('Modified instructions');
    });
  });
});
