/**
 * Unit tests for TemplateManager class
 * Note: These are simplified tests without mocks due to Jest configuration issues
 */

import { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import { Template } from '../../../../src/elements/templates/Template.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { DollhouseContainer } from '../../../../src/di/Container.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';

// Create a shared MetadataService instance for all tests
const metadataService = createTestMetadataService();

describe('TemplateManager', () => {
  let container: InstanceType<typeof DollhouseContainer>;
  let manager: InstanceType<typeof TemplateManager>;
  let portfolioManager: InstanceType<typeof PortfolioManager>;
  let testDir: string;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = path.join(os.tmpdir(), `template-manager-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    // Create DI container and register services
    container = new DollhouseContainer();

    // Register all required services for TemplateManager
    container.register('FileLockManager', () => new FileLockManager());
    container.register('FileOperationsService', () => new FileOperationsService(container.resolve('FileLockManager')));
    container.register('PortfolioManager', () => new PortfolioManager(container.resolve('FileOperationsService'), { baseDir: testDir }));
    container.register('SerializationService', () => new SerializationService());
    container.register('MetadataService', () => metadataService);
    container.register('ValidationRegistry', () => new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    ));
    container.register('TemplateManager', () => new TemplateManager(
      container.resolve('PortfolioManager'),
      container.resolve('FileLockManager'),
      container.resolve('FileOperationsService'),
      container.resolve('ValidationRegistry'),
      container.resolve('SerializationService'),
      container.resolve('MetadataService')
    ));

    portfolioManager = container.resolve('PortfolioManager');
    await portfolioManager.initialize();

    manager = container.resolve('TemplateManager');
  });

  afterEach(async () => {
    // Dispose DI container
    await container.dispose();

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  describe('importElement', () => {
    it('should import from JSON format', async () => {
      const jsonData = JSON.stringify({
        metadata: {
          name: 'Imported Template',
          description: 'Test import',
          variables: [{ name: 'test', type: 'string' }]
        },
        content: 'Imported content {{test}}'
      });

      const template = await manager.importElement(jsonData, 'json');
      
      expect(template).toBeInstanceOf(Template);
      expect(template.metadata.name).toBe('Imported Template');
      expect(template.content).toBe('Imported content {{test}}');
    });

    it('should import from markdown format', async () => {
      const markdownData = `---
name: Markdown Template
description: Test import from markdown
category: creative
---

# Markdown Content

Hello {{name}}!`;

      const template = await manager.importElement(markdownData, 'markdown');

      expect(template).toBeInstanceOf(Template);
      expect(template.metadata.name).toBe('Markdown Template');
      expect(template.metadata.description).toBe('Test import from markdown');
      expect(template.metadata.category).toBe('creative');
      expect(template.content.trim()).toBe('# Markdown Content\n\nHello {{name}}!');
    });

    it('should validate imported templates', async () => {
      const invalidData = JSON.stringify({
        metadata: { name: 'Invalid' },
        content: '' // Empty content should fail validation
      });

      await expect(manager.importElement(invalidData, 'json')).rejects.toThrow('Invalid template');
    });

    it('should reject unsupported formats', async () => {
      await expect(manager.importElement('data', 'xml' as any)).rejects.toThrow('Unsupported import format: xml');
    });
  });

  describe('exportElement', () => {
    let testTemplate: Template;

    beforeEach(() => {
      testTemplate = new Template({
        name: 'Export Test',
        description: 'Test export',
        category: 'test',
        variables: [{ name: 'var1', type: 'string' }],
        tags: ['export', 'test']
      }, 'Content {{var1}}', metadataService);
      testTemplate.id = 'test-id';
      testTemplate.version = '1.0.0';
    });

    it('should export to JSON format', async () => {
      const exported = await manager.exportElement(testTemplate, 'json');
      const parsed = JSON.parse(exported);
      
      expect(parsed.metadata.name).toBe('Export Test');
      expect(parsed.metadata.description).toBe('Test export');
      expect(parsed.content).toBe('Content {{var1}}');
      expect(parsed.id).toBe('test-id');
      expect(parsed.version).toBe('1.0.0');
    });

    it('should export to YAML format', async () => {
      const exported = await manager.exportElement(testTemplate, 'yaml');
      
      expect(exported).toContain('name: Export Test');
      expect(exported).toContain('description: Test export');
      expect(exported).toContain('content: Content {{var1}}');
      expect(exported).toContain('id: test-id');
      expect(exported).toContain('version: 1.0.0');
      // Should use safe YAML (no type tags)
      expect(exported).not.toContain('!!');
    });

    it('should export to markdown format', async () => {
      const exported = await manager.exportElement(testTemplate, 'markdown');
      
      expect(exported).toMatch(/^---\n/);
      expect(exported).toContain('name: Export Test');
      expect(exported).toContain('description: Test export');
      expect(exported).toContain('category: test');
      expect(exported).toContain('---\n\nContent {{var1}}');
    });

    it('should reject unsupported export formats', async () => {
      await expect(manager.exportElement(testTemplate, 'xml' as any)).rejects.toThrow('Unsupported export format: xml');
    });
  });

  describe('validation methods', () => {
    it('should handle complex metadata during import', async () => {
      const complexData = JSON.stringify({
        metadata: {
          name: 'Complex Template',
          description: 'A complex template with many features',
          category: 'advanced',
          output_format: 'html',
          tags: ['complex', 'advanced', 'features'],
          variables: [
            {
              name: 'username',
              type: 'string',
              description: 'User name',
              required: true,
              validation: '^[a-zA-Z0-9_]+$'
            },
            {
              name: 'count',
              type: 'number',
              description: 'Item count',
              default: 10,
              min: 1,
              max: 100
            }
          ],
          examples: [
            {
              title: 'Basic Example',
              description: 'Shows basic usage',
              variables: { username: 'john_doe', count: 5 },
              output: 'Hello john_doe, you have 5 items!'
            }
          ]
        },
        content: 'Hello {{username}}, you have {{count}} items!'
      });

      const template = await manager.importElement(complexData, 'json');
      
      expect(template.metadata.variables).toHaveLength(2);
      expect(template.metadata.variables![0].name).toBe('username');
      // The sanitization removes backslashes, so they won't be in the validation pattern
      expect(template.metadata.variables![0].validation).toBe('^[a-zA-Z0-9_]+');
      expect(template.metadata.variables![1].default).toBe(10);
      expect(template.metadata.examples).toHaveLength(1);
      expect(template.metadata.tags).toEqual(['complex', 'advanced', 'features']);
    });

    it('should sanitize metadata fields', async () => {
      const unsafeData = JSON.stringify({
        metadata: {
          name: '<script>alert("xss")</script>Template',
          description: 'Description with <img src=x onerror=alert(1)>',
          category: 'test<script>category</script>',
          tags: ['<b>tag1</b>', 'normal-tag']
        },
        content: 'Safe content'
      });

      const template = await manager.importElement(unsafeData, 'json');

      // Check that XSS attempts are sanitized (removes angle brackets and quotes)
      expect(template.metadata.name).toBe('scriptalertxss/scriptTemplate');
      expect(template.metadata.description).toBe('Description with img src=x onerror=alert1');
      // ValidationService rejects invalid categories and defaults to 'general'
      // This is the correct secure behavior - invalid categories should not be allowed
      expect(template.metadata.category).toBe('general');
      expect(template.metadata.tags).toContain('btag1/b');
      expect(template.metadata.tags).toContain('normal-tag');
    });
  });

  describe('error handling', () => {
    it('should handle JSON parse errors gracefully', async () => {
      const invalidJson = '{ invalid json }';
      
      await expect(manager.importElement(invalidJson, 'json')).rejects.toThrow();
    });

    it('should handle empty metadata', async () => {
      const emptyData = JSON.stringify({
        metadata: {},
        content: 'Content without metadata'
      });

      const template = await manager.importElement(emptyData, 'json');
      
      // Should have default values
      expect(template.metadata.category).toBe('general');
      expect(template.metadata.output_format).toBe('markdown');
      expect(template.content).toBe('Content without metadata');
    });

    it('should handle missing content', async () => {
      const noContent = JSON.stringify({
        metadata: { name: 'No Content' }
        // content is missing
      });

      // Should fail validation due to empty content
      await expect(manager.importElement(noContent, 'json')).rejects.toThrow('Invalid template');
    });
  });
});