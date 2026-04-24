/**
 * Unit tests for TemplateManager v2 markdown body serialization
 *
 * Tests that templates serialized without explicit content get a well-formed
 * placeholder markdown body via buildDefaultBody(), rather than a YAML-only file.
 * A template without content is a broken template, but the placeholder makes
 * the gap visible rather than leaving it blank.
 *
 * @see Issue #713 - ensure create_element produces well-formatted markdown bodies
 * @see Issue #696 - element quality: YAML-only serialization gap
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// Mock security modules before importing anything that uses them
jest.mock('../../../../src/security/fileLockManager.js');
jest.mock('../../../../src/security/securityMonitor.js');
jest.mock('../../../../src/utils/logger.js');

import { TemplateManager } from '../../../../src/elements/templates/TemplateManager.js';
import { Template } from '../../../../src/elements/templates/Template.js';
import type { TemplateMetadata } from '../../../../src/elements/templates/Template.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';
import type { MetadataService } from '../../../../src/services/MetadataService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ElementEventDispatcher } from '../../../../src/events/ElementEventDispatcher.js';
import { createTestStorageFactory } from '../../../helpers/createTestStorageFactory.js';

const metadataService: MetadataService = createTestMetadataService();

describe('TemplateManager — element quality: markdown body (#713)', () => {
  let templateManager: InstanceType<typeof TemplateManager>;
  let testDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();

    testDir = path.join(os.tmpdir(), 'template-v2-test-' + Math.random().toString(36).substring(7));
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ElementType.TEMPLATE), { recursive: true });

    const mockPortfolioManager = {
      listElements: jest.fn<() => Promise<string[]>>().mockResolvedValue([]),
      getElementDir: jest.fn<(type: ElementType) => string>((type: ElementType) => path.join(testDir, type)),
      getBaseDir: jest.fn<() => string>(() => testDir)
    };

    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService();
    const serializationService = new SerializationService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    templateManager = new TemplateManager({
      portfolioManager: mockPortfolioManager as any,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    storageLayerFactory: createTestStorageFactory(),
    });
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('element quality — markdown body (#713)', () => {
    it('generated file contains a placeholder body when content is empty', async () => {
      const metadata: Partial<TemplateMetadata> = {
        name: 'My Test Template',
        type: ElementType.TEMPLATE,
        version: '1.0.0',
        author: 'test-user',
        description: 'A reusable template for testing'
      };
      // Template with empty content — relies on buildDefaultBody()
      const template = new Template(metadata, '', metadataService);

      const serialized = await (templateManager as any).serializeElement(template);

      // Body section must exist after the closing ---
      const parts = serialized.split(/^---\s*$/m);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# My Test Template');
      expect(body).toContain('A reusable template for testing');
      // Section format scaffold (issue #705): <template>, <style>, <script>
      expect(body).toContain('<template>');
      expect(body).toContain('<style>');
      expect(body).toContain('<script>');
    });

    it('generated file has H1 heading even with no description', async () => {
      const metadata: Partial<TemplateMetadata> = {
        name: 'Minimal Template',
        type: ElementType.TEMPLATE,
        version: '1.0.0',
        author: 'test-user'
        // no description
      };
      const template = new Template(metadata, '', metadataService);

      const serialized = await (templateManager as any).serializeElement(template);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Minimal Template');
      expect(body).toContain('<template>');
    });

    it('generates a valid body even when name is empty (MetadataService normalizes to Untitled)', async () => {
      const metadata: Partial<TemplateMetadata> = {
        name: '',
        type: ElementType.TEMPLATE,
        version: '1.0.0',
        author: 'test-user'
      };
      const template = new Template(metadata, '', metadataService);

      const serialized = await (templateManager as any).serializeElement(template);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // MetadataService normalizes '' → 'Untitled Template', so body still has a valid H1
      expect(body).toContain('# Untitled Template');
      // No broken heading like '#   ' or '# '
      expect(body).not.toMatch(/^#\s*$/m);
    });

    it('preserves explicit content over the default body', async () => {
      const metadata: Partial<TemplateMetadata> = {
        name: 'Template With Content',
        type: ElementType.TEMPLATE,
        version: '1.0.0',
        author: 'test-user',
        description: 'Description text'
      };
      const template = new Template(metadata, '# Custom Template\n\nHello, {{name}}!', metadataService);

      const serialized = await (templateManager as any).serializeElement(template);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      expect(body).toContain('# Custom Template');
      expect(body).toContain('Hello, {{name}}!');
      // Default section scaffold should NOT appear when explicit content is set
      expect(body).not.toContain('<!-- HTML content with {{variable}} substitution -->');
    });

    it('whitespace-only name and description never produce a broken H1', async () => {
      const metadata: Partial<TemplateMetadata> = {
        name: '   ',
        type: ElementType.TEMPLATE,
        version: '1.0.0',
        author: 'test-user',
        description: '   '
      };
      const template = new Template(metadata, '', metadataService);

      const serialized = await (templateManager as any).serializeElement(template);
      const parts = serialized.split(/^---\s*$/m);
      const body = parts.slice(2).join('---').trim();

      // Whitespace-only name: MetadataService normalizes to 'Untitled Template'
      expect(body).not.toMatch(/^#\s*$/m);           // No empty heading
      expect(body).not.toMatch(/^#\s{2,}/m);         // No heading with only spaces
      expect(body).toContain('# Untitled Template'); // Falls back to normalized name
    });
  });
});
