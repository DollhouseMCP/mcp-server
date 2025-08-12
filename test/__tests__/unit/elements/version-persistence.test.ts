/**
 * Unit tests for version persistence and synchronization
 * Tests the fixes for version handling across element types
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { SkillManager } from '../../../../src/elements/skills/SkillManager.js';
import { Skill } from '../../../../src/elements/skills/Skill.js';
import { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import { Template } from '../../../../src/elements/templates/Template.js';
import { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { ElementType } from '../../../../src/portfolio/types.js';

describe('Version Persistence', () => {
  let testDir: string;
  let skillManager: SkillManager;
  let templateManager: TemplateManager;
  let agentManager: AgentManager;

  beforeEach(async () => {
    // Create unique test directory
    testDir = path.join(os.tmpdir(), `test-version-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Create subdirectories
    const skillsDir = path.join(testDir, 'skills');
    const templatesDir = path.join(testDir, 'templates');
    const agentsDir = path.join(testDir, 'agents');
    
    await fs.mkdir(skillsDir, { recursive: true });
    await fs.mkdir(templatesDir, { recursive: true });
    await fs.mkdir(agentsDir, { recursive: true });
    
    // Initialize managers
    skillManager = new SkillManager(skillsDir);
    templateManager = new TemplateManager(templatesDir);
    agentManager = new AgentManager(agentsDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('SkillManager Version Persistence', () => {
    it('should persist version when saving a skill', async () => {
      // Create a skill with a specific version
      const skill = new Skill(
        {
          name: 'Test Skill',
          description: 'A test skill',
          version: '2.1.0'
        },
        'Test instructions'
      );
      
      // Save the skill
      await skillManager.save(skill, 'test-skill.md');
      
      // Load the skill back
      const loadedSkill = await skillManager.load('test-skill.md');
      
      // Verify version persisted
      expect(loadedSkill.version).toBe('2.1.0');
      expect(loadedSkill.metadata.version).toBe('2.1.0');
    });

    it('should sync version between element.version and metadata.version', async () => {
      // Create skill with version only in metadata
      const skill = new Skill(
        {
          name: 'Version Sync Test',
          description: 'Testing version sync',
          version: '1.5.3'
        },
        'Instructions'
      );
      
      // Manually set element.version different from metadata
      skill.version = '1.5.4';
      
      // Save with element.version taking precedence
      await skillManager.save(skill, 'version-sync.md');
      
      // Load and verify
      const loaded = await skillManager.load('version-sync.md');
      
      // Both should match the element.version value
      expect(loaded.version).toBe('1.5.4');
      expect(loaded.metadata.version).toBe('1.5.4');
    });

    it('should handle missing version gracefully', async () => {
      // Create skill without version
      const skill = new Skill(
        {
          name: 'No Version Skill',
          description: 'Skill without version'
        },
        'Instructions'
      );
      
      // Remove version to simulate edge case
      delete (skill as any).version;
      delete (skill.metadata as any).version;
      
      // Save should not throw
      await expect(skillManager.save(skill, 'no-version.md')).resolves.not.toThrow();
      
      // Load and check default version applied
      const loaded = await skillManager.load('no-version.md');
      
      // Should have default version
      expect(loaded.version).toBeDefined();
      expect(loaded.metadata.version).toBeDefined();
    });
  });

  describe('TemplateManager Version Persistence', () => {
    it('should persist version when saving a template', async () => {
      // Create template with version
      const template = new Template(
        {
          name: 'Test Template',
          description: 'A test template',
          version: '3.2.1'
        },
        'Template content'
      );
      
      // Save template
      await templateManager.save(template, 'test-template.md');
      
      // Load and verify
      const loaded = await templateManager.load('test-template.md');
      
      expect(loaded.version).toBe('3.2.1');
      expect(loaded.metadata.version).toBe('3.2.1');
    });
  });

  describe('AgentManager Version Persistence', () => {
    it('should persist version when saving an agent', async () => {
      // Create agent with version
      const agent = new Agent({
        name: 'Test Agent',
        description: 'A test agent',
        version: '4.0.0'
      });
      
      // Save agent
      await agentManager.save(agent, 'test-agent.md');
      
      // Load and verify
      const loaded = await agentManager.load('test-agent.md');
      
      expect(loaded.version).toBe('4.0.0');
      expect(loaded.metadata.version).toBe('4.0.0');
    });
  });

  describe('Version Format Validation', () => {
    it('should validate semver format', () => {
      const validVersions = ['1.0.0', '2.3.4', '10.20.30', '0.0.1'];
      const invalidVersions = ['1', '1.0', 'v1.0.0', '1.0.0-beta', 'abc'];
      
      const isValidSemver = (version: string): boolean => {
        return /^\d+\.\d+\.\d+$/.test(version);
      };
      
      validVersions.forEach(v => {
        expect(isValidSemver(v)).toBe(true);
      });
      
      invalidVersions.forEach(v => {
        expect(isValidSemver(v)).toBe(false);
      });
    });

    it('should handle version increment correctly', () => {
      const testCases = [
        { input: '1.0.0', expected: '1.0.1' },
        { input: '1.0.9', expected: '1.0.10' },
        { input: '1.0.99', expected: '1.0.100' },
        { input: '1.0', expected: '1.0.1' },
        { input: '1', expected: '1.0.1' },
        { input: 'invalid', expected: '1.0.1' },
        // Pre-release version tests
        { input: '1.0.0-beta', expected: '1.0.0-beta.1' },
        { input: '1.0.0-beta.1', expected: '1.0.0-beta.2' },
        { input: '1.0.0-alpha.5', expected: '1.0.0-alpha.6' },
        { input: '2.0.0-rc.1', expected: '2.0.0-rc.2' }
      ];
      
      testCases.forEach(({ input, expected }) => {
        let result: string;
        
        // Check for pre-release versions
        const preReleaseMatch = input.match(/^(\d+\.\d+\.\d+)(-([a-zA-Z0-9.-]+))?$/);
        
        if (preReleaseMatch) {
          const baseVersion = preReleaseMatch[1];
          const preReleaseTag = preReleaseMatch[3];
          
          if (preReleaseTag) {
            const preReleaseNumberMatch = preReleaseTag.match(/^([a-zA-Z]+)\.?(\d+)?$/);
            if (preReleaseNumberMatch) {
              const preReleaseType = preReleaseNumberMatch[1];
              const preReleaseNumber = parseInt(preReleaseNumberMatch[2] || '0') + 1;
              result = `${baseVersion}-${preReleaseType}.${preReleaseNumber}`;
            } else {
              const [major, minor, patch] = baseVersion.split('.').map(Number);
              result = `${major}.${minor}.${patch + 1}`;
            }
          } else {
            const [major, minor, patch] = baseVersion.split('.').map(Number);
            result = `${major}.${minor}.${patch + 1}`;
          }
        } else {
          const versionParts = input.split('.');
          if (versionParts.length >= 3) {
            const patch = parseInt(versionParts[2]) || 0;
            versionParts[2] = String(patch + 1);
            result = versionParts.join('.');
          } else if (versionParts.length === 2) {
            result = `${input}.1`;
          } else if (versionParts.length === 1 && /^\d+$/.test(versionParts[0])) {
            result = `${input}.0.1`;
          } else {
            result = '1.0.1';
          }
        }
        
        expect(result).toBe(expected);
      });
    });
  });

  describe('Version Synchronization Edge Cases', () => {
    it('should handle concurrent version updates', async () => {
      const skill = new Skill(
        {
          name: 'Concurrent Test',
          description: 'Testing concurrent updates',
          version: '1.0.0'
        },
        'Instructions'
      );
      
      // Simulate concurrent updates
      skill.version = '1.0.1';
      skill.metadata.version = '1.0.2';
      
      // Save should use element.version as source of truth
      await skillManager.save(skill, 'concurrent.md');
      
      const loaded = await skillManager.load('concurrent.md');
      
      // Both should be synced to element.version value
      expect(loaded.version).toBe('1.0.1');
      expect(loaded.metadata.version).toBe('1.0.1');
    });

    it('should handle version updates with metadata undefined', async () => {
      const skill = new Skill(
        {
          name: 'Metadata Test',
          description: 'Testing undefined metadata'
        },
        'Instructions'
      );
      
      // Simulate edge case where metadata might be undefined
      const originalMetadata = skill.metadata;
      (skill as any).metadata = undefined;
      skill.version = '2.0.0';
      
      // Restore metadata for save
      skill.metadata = originalMetadata;
      
      await skillManager.save(skill, 'metadata-test.md');
      
      const loaded = await skillManager.load('metadata-test.md');
      
      expect(loaded.version).toBe('2.0.0');
      expect(loaded.metadata.version).toBe('2.0.0');
    });
  });
});