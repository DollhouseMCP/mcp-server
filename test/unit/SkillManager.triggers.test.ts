/**
 * Unit tests for Skill trigger extraction (Issue #1121)
 * Following pattern from MemoryManager.triggers.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SkillManager } from '../../src/elements/skills/SkillManager.js';
import { Skill } from '../../src/elements/skills/Skill.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { ElementType } from '../../src/portfolio/types.js';
import { SecurityMonitor } from '../../src/security/securityMonitor.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock dependencies
jest.mock('../../src/security/fileLockManager.js');
jest.mock('../../src/security/securityMonitor.js');
jest.mock('../../src/utils/logger.js');

describe('SkillManager - Trigger Extraction', () => {
  let skillManager: SkillManager;
  let tempDir: string;
  let skillsDir: string;
  let testSkillPath: string;
  let portfolioManager: PortfolioManager;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-trigger-test-'));

    // Set up portfolio directory
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;

    // Reset singleton
    (PortfolioManager as any).instance = undefined;
    (PortfolioManager as any).initializationPromise = null;
    portfolioManager = PortfolioManager.getInstance();
    await portfolioManager.initialize();

    // Get skills directory
    skillsDir = portfolioManager.getElementDir(ElementType.SKILL);

    // Ensure skills directory exists
    await fs.mkdir(skillsDir, { recursive: true });

    // Create skill manager
    skillManager = new SkillManager();

    // Set up mocks
    jest.clearAllMocks();

    // Mock FileLockManager - make atomicWriteFile actually write the file
    (FileLockManager as any).atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    });
    (FileLockManager as any).atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    });

    // Mock SecurityMonitor
    (SecurityMonitor as any).logSecurityEvent = jest.fn();

    testSkillPath = 'test-skill.md';
  });

  afterEach(async () => {
    jest.clearAllMocks();
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
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

    it('should sanitize and truncate long trigger names', async () => {
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
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeDefined();
      expect(skill.metadata.triggers?.length).toBe(2);
      expect(skill.metadata.triggers![0].length).toBeLessThanOrEqual(50);
      expect(skill.metadata.triggers![1]).toBe('normal');
    });

    it('should handle non-array trigger values gracefully', async () => {
      const skillContent = `---
name: Invalid Triggers Skill
description: Skill with invalid trigger format
version: 1.0.0
triggers: "not an array"
---

# Instructions`;

      await fs.writeFile(path.join(skillsDir, testSkillPath), skillContent);
      const skill = await skillManager.load(testSkillPath);

      // Should not have triggers since it wasn't an array
      expect(skill.metadata.triggers).toBeUndefined();
    });

    it('should handle mixed valid and invalid trigger types', async () => {
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
      const skill = await skillManager.load(testSkillPath);

      expect(skill.metadata.triggers).toBeDefined();
      // Numbers will be converted to strings, null and boolean filtered out
      expect(skill.metadata.triggers).toContain('valid-string');
      expect(skill.metadata.triggers).toContain('123');
      expect(skill.metadata.triggers).toContain('another-valid');
    });
  });

  describe('Saving Skills with Triggers', () => {
    it('should preserve triggers when saving a skill', async () => {
      const skill = new Skill({
        name: 'Save Test Skill',
        description: 'Testing trigger preservation',
        version: '1.0.0',
        triggers: ['debug', 'test', 'validate']
      }, 'Test instructions');

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
      }, 'Instructions');

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
      }, 'Instructions');

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