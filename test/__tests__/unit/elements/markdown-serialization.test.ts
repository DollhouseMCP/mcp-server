/**
 * Comprehensive test suite for markdown serialization across all element types
 * Tests the serialize() method that outputs markdown with YAML frontmatter
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { PersonaElement } from '../../../../src/persona/PersonaElement.js';
import { Skill } from '../../../../src/elements/skills/Skill.js';
import { Template } from '../../../../src/elements/templates/Template.js';
import { Agent } from '../../../../src/elements/agents/Agent.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import * as yaml from 'js-yaml';

describe('Markdown Serialization', () => {
  describe('PersonaElement', () => {
    it('should serialize to markdown with YAML frontmatter', () => {
      const persona = new PersonaElement({
        name: 'Test Persona',
        description: 'A test persona',
        author: 'test-author',
        triggers: ['test', 'persona'],
        category: 'testing',
        age_rating: '13+',
        ai_generated: false,
        price: 'free'
      }, 'This is the persona content');

      const serialized = persona.serialize();
      
      // Check structure
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n/);
      
      // Extract and parse frontmatter
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).toBeTruthy();
      
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      expect(frontmatter.name).toBe('Test Persona');
      expect(frontmatter.description).toBe('A test persona');
      expect(frontmatter.author).toBe('test-author');
      expect(frontmatter.unique_id).toBeDefined(); // Should include unique_id
      expect(frontmatter.triggers).toEqual(['test', 'persona']);
      expect(frontmatter.category).toBe('testing');
      expect(frontmatter.age_rating).toBe('13+');
      expect(frontmatter.ai_generated).toBe(false);
      expect(frontmatter.price).toBe('free');
      
      // Check content
      expect(serialized).toContain('This is the persona content');
    });

    it('should handle special characters in metadata', () => {
      const persona = new PersonaElement({
        name: 'Test: Persona with "quotes"',
        description: 'Description with\nnewlines and # symbols',
        author: 'test@author.com'
      }, 'Content');

      const serialized = persona.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      expect(frontmatter.name).toBe('Test: Persona with "quotes"');
      expect(frontmatter.description).toBe('Description with\nnewlines and # symbols');
    });
  });

  describe('Skill', () => {
    it('should serialize to markdown with skill-specific content', () => {
      const skill = new Skill({
        name: 'Code Review',
        description: 'Reviews code for quality',
        author: 'dev-team'
      });
      skill.instructions = 'Analyze code for bugs and style issues';
      skill.setParameter('language', 'TypeScript');
      skill.setParameter('strictness', 'high');

      const serialized = skill.serialize();
      
      // Check structure
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n/);
      
      // Extract frontmatter
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      expect(frontmatter.name).toBe('Code Review');
      expect(frontmatter.description).toBe('Reviews code for quality');
      expect(frontmatter.type).toBe(ElementType.SKILL);
      
      // Check content includes instructions and parameters
      expect(serialized).toContain('## Instructions');
      expect(serialized).toContain('Analyze code for bugs and style issues');
      expect(serialized).toContain('## Parameters');
      expect(serialized).toContain('language');
      expect(serialized).toContain('TypeScript');
      expect(serialized).toContain('strictness');
    });
  });

  describe('Template', () => {
    it('should serialize to markdown with template content', () => {
      const template = new Template({
        name: 'Meeting Notes',
        description: 'Template for meeting notes',
        author: 'org-admin'
      }, '# Meeting: {{title}}\nDate: {{date}}\n\n## Attendees\n{{attendees}}\n\n## Notes\n{{notes}}');

      const serialized = template.serialize();
      
      // Check structure
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n/);
      
      // Extract frontmatter
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      expect(frontmatter.name).toBe('Meeting Notes');
      expect(frontmatter.description).toBe('Template for meeting notes');
      expect(frontmatter.type).toBe(ElementType.TEMPLATE);
      
      // Check content
      expect(serialized).toContain('# Meeting: {{title}}');
      expect(serialized).toContain('## Attendees');
      expect(serialized).toContain('{{attendees}}');
    });
  });

  describe('Agent', () => {
    it('should serialize to markdown with agent state', () => {
      const agent = new Agent({
        name: 'Project Manager',
        description: 'Manages project tasks',
        author: 'pm-team'
      });
      
      // Add a goal
      agent.addGoal({
        description: 'Complete sprint planning',
        priority: 'high'
      });
      
      // Add context
      agent.updateContext('sprint', 'Sprint 23');
      agent.updateContext('team_size', 5);

      const serialized = agent.serialize();
      
      // Check structure
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n/);
      
      // Extract frontmatter
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      expect(frontmatter.name).toBe('Project Manager');
      expect(frontmatter.description).toBe('Manages project tasks');
      expect(frontmatter.type).toBe(ElementType.AGENT);
      
      // Check content includes goals and context
      expect(serialized).toContain('## Current Goals');
      expect(serialized).toContain('Complete sprint planning');
      expect(serialized).toContain('Priority**: high');
      expect(serialized).toContain('## Context');
      expect(serialized).toContain('sprint');
      expect(serialized).toContain('Sprint 23');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty arrays in metadata', () => {
      const persona = new PersonaElement({
        name: 'Empty Arrays',
        triggers: [],
        content_flags: []
      }, 'Content');

      const serialized = persona.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      // Empty arrays should be preserved
      expect(frontmatter.triggers).toEqual([]);
      expect(frontmatter.content_flags).toEqual([]);
    });

    it('should handle undefined and null values', () => {
      const persona = new PersonaElement({
        name: 'Test',
        description: undefined as any,
        author: null as any
      }, 'Content');

      const serialized = persona.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      const frontmatter = yaml.load(frontmatterMatch![1]) as any;
      
      // Undefined/null should be filtered out
      expect(frontmatter.name).toBe('Test');
      expect(frontmatter.description).toBe(''); // IElementMetadata sets default
      expect(frontmatter.author).toBeUndefined(); // null is filtered
    });

    it('should handle very long content', () => {
      const longContent = 'x'.repeat(10000);
      const persona = new PersonaElement({
        name: 'Long Content'
      }, longContent);

      const serialized = persona.serialize();
      expect(serialized.length).toBeGreaterThan(10000);
      expect(serialized).toContain(longContent);
    });

    it('should validate YAML generation', () => {
      const skill = new Skill({
        name: 'Test Skill',
        description: 'With various: special! characters @#$%'
      });

      const serialized = skill.serialize();
      const frontmatterMatch = serialized.match(/^---\n([\s\S]*?)\n---/);
      
      // Should be able to parse the YAML back
      expect(() => {
        yaml.load(frontmatterMatch![1]);
      }).not.toThrow();
    });
  });

  describe('Backward Compatibility', () => {
    it('should provide JSON serialization through serializeToJSON', () => {
      const persona = new PersonaElement({
        name: 'JSON Test'
      }, 'Content');

      const json = persona.serializeToJSON();
      const parsed = JSON.parse(json);
      
      expect(parsed.metadata.name).toBe('JSON Test');
      expect(parsed.content).toBe('Content');
      expect(parsed.type).toBe(ElementType.PERSONA);
    });

    it('should deserialize from JSON format', () => {
      const original = new Skill({
        name: 'Original Skill'
      });
      original.instructions = 'Do something';

      const json = original.serializeToJSON();
      
      const restored = new Skill({});
      restored.deserialize(json);
      
      expect(restored.metadata.name).toBe('Original Skill');
      expect(restored.instructions).toBe('Do something');
    });
  });
});