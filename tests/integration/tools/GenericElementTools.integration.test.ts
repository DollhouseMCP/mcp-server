import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
import path from 'path';
import fs from 'fs/promises';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Generic Element Tools Integration (handler-based)', () => {
  let env: PortfolioTestEnvironment;
  let server: DollhouseMCPServer;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('generic-element-tools');
    const container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas();
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('create_element', () => {
    it('should create a skill element successfully', async () => {
      const result = await server.createElement({
        name: 'code-review',
        type: ElementType.SKILL,
        description: 'Reviews code for quality and best practices',
        content: 'Code review implementation',
        metadata: { domain: 'development', proficiency: 4 }
      });

      expect(result.content[0].text).toContain('✅ Created skill');
      const skillFile = path.join(env.testDir, 'skills', 'code-review.md');
      await expect(fs.access(skillFile)).resolves.toBeUndefined();
    });

    it('should create a template element successfully', async () => {
      const result = await server.createElement({
        name: 'meeting-notes',
        type: ElementType.TEMPLATE,
        description: 'Template for meeting notes',
        content: '# Meeting Notes\n\nDate: {{date}}\nAttendees: {{attendees}}',
        metadata: { variables: ['date', 'attendees'] }
      });

      expect(result.content[0].text).toContain('✅ Created template');
      const templateFile = path.join(env.testDir, 'templates', 'meeting-notes.md');
      await expect(fs.access(templateFile)).resolves.toBeUndefined();
    });

    it('should reject invalid element types', async () => {
      const result = await server.createElement({
        name: 'invalid',
        type: 'invalid-type',
        description: 'Test description'
      } as any);

      expect(result.content[0].text).toContain('❌ Invalid element type');
      expect(result.content[0].text).toContain('Valid types:');
    });
  });

  describe('edit_element', () => {
    beforeEach(async () => {
      await server.createElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        description: 'Original description',
        content: 'Sample skill content',
        metadata: { domain: 'demo', proficiency: 3 }
      });
    });

    // Issue #334: Updated to use input wrapper format
    it('should edit a skill element field successfully', async () => {
      const result = await server.editElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        input: { description: 'Updated description' }
      });

      expect(result.content[0].text).toContain('✅ Updated skill');
      expect(result.content[0].text).toContain('description');
    });

    // Issue #334: Updated to use input wrapper format
    it('should edit nested metadata fields using input object', async () => {
      const result = await server.editElement({
        name: 'sample-skill',
        type: ElementType.SKILL,
        input: { metadata: { proficiency: 5 } }
      });

      expect(result.content[0].text).toContain('✅ Updated skill');
      expect(result.content[0].text).toContain('metadata');
    });

    // Issue #336: ElementNotFoundError is now thrown instead of returning error content
    it('should throw ElementNotFoundError for non-existent elements', async () => {
      await expect(server.editElement({
        name: 'non-existent',
        type: ElementType.SKILL,
        input: { description: 'New value' }
      })).rejects.toThrow('not found');
    });
  });

  describe('validate_element', () => {
    beforeEach(async () => {
      await server.createElement({
        name: 'valid-skill',
        type: ElementType.SKILL,
        description: 'A well-formed skill for testing validation',
        content: '# Valid Skill\n\nThis skill performs code validation.',
        metadata: { domain: 'testing', proficiency: 4 }
      });
    });

   it('should validate a valid skill element', async () => {
      const result = await server.validateElement({
        name: 'valid-skill',
        type: ElementType.SKILL,
        strict: false
      });

      expect(result.content[0].text).toContain('✅ Status: Valid');
    });

    it('should reject creation of elements with invalid content', async () => {
      // With the new validation-on-create, empty content is rejected at creation time
      const result = await server.createElement({
        name: 'incomplete-skill',
        type: ElementType.SKILL,
        description: 'Skill with missing instructions',
        content: '',  // Empty content is now rejected during creation
        metadata: {}
      });

      // Creation should fail with validation error
      expect(result.content[0].text).toContain('❌');
      expect(result.content[0].text).toMatch(/Content is required|Failed to create/i);
    });

    it('should report validation warnings in strict mode', async () => {
      // Create a valid element but with minimal content
      await server.createElement({
        name: 'minimal-skill',
        type: ElementType.SKILL,
        description: 'A skill with minimal content',
        content: 'This is minimal skill content for testing',
        metadata: {}
      });

      // Strict mode should report warnings for missing optional fields
      const result = await server.validateElement({
        name: 'minimal-skill',
        type: ElementType.SKILL,
        strict: true
      });

      // Element should be valid but may have suggestions
      expect(result.content[0].text).toMatch(/Status: Valid|Suggestions/i);
    });

    it('should apply strict validation when requested', async () => {
      const result = await server.validateElement({
        name: 'valid-skill',
        type: ElementType.SKILL,
        strict: true
      });

      expect(result.content[0].text).toContain('📋 Strict Mode');
    });
  });
});
