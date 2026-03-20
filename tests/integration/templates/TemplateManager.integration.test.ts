import { promises as fs } from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { jest } from '@jest/globals';

import { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import { Template } from '../../../src/elements/templates/Template.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { FileWatchService } from '../../../src/services/FileWatchService.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';

// Create a shared MetadataService instance for all tests
const metadataService: MetadataService = createTestMetadataService();

describe('TemplateManager (BaseElementManager integration)', () => {
  let manager: TemplateManager;
  let env: PortfolioTestEnvironment;
  let templatesDir: string;
  let securitySpy: ReturnType<typeof jest.spyOn>;

  beforeAll(async () => {
    env = await createPortfolioTestEnvironment('template-manager-test');

    const fileLockManager = new FileLockManager();
    const fileOperationsService = new FileOperationsService(fileLockManager);
    const serializationService = new SerializationService();
    const fileWatchService = new FileWatchService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    manager = new TemplateManager(
      env.portfolioManager,
      fileLockManager,
      fileOperationsService,
      validationRegistry,
      serializationService,
      metadataService,
      fileWatchService
    );

    templatesDir = env.portfolioManager.getElementDir(ElementType.TEMPLATE);
    await fs.mkdir(templatesDir, { recursive: true });
  });

  afterAll(async () => {
    // Dispose manager to clean up file watchers
    if (manager) {
      manager.dispose();
    }

    await env.cleanup();
  });

  beforeEach(() => {
    securitySpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
  });

  afterEach(async () => {
    securitySpy?.mockRestore();

    try {
      const entries = await fs.readdir(templatesDir, { withFileTypes: true });
      for (const entry of entries) {
        await fs.rm(path.join(templatesDir, entry.name), { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('saves and loads template metadata via BaseElementManager', async () => {
    const template = new Template(
      {
        name: 'Refactor Template',
        description: 'Guides refactoring steps',
        includes: ['shared/snippets.md'],
        triggers: ['draft', '']
      },
      'Refactor plan: {{steps}}',
      metadataService
    );

    await manager.save(template, 'refactor-template.md');
    const loaded = await manager.load('refactor-template.md');

    expect(loaded.metadata.name).toBe('Refactor Template');
    expect(loaded.metadata.includes).toEqual(['shared/snippets.md']);
    expect(loaded.metadata.triggers).toEqual(['draft']);
    expect(loaded.content).toContain('{{steps}}');
  });

  it('serializeElement writes versioned frontmatter with metadata', async () => {
    const template = new Template(
      {
        name: 'Serialize Template',
        description: 'Checks serialization',
        category: 'documents',
        triggers: ['write']
      },
      'Content body',
      metadataService
    );
    template.metadata.version = '1.0.1';

    await manager.save(template, 'serialize-template.md');

    const file = await fs.readFile(path.join(templatesDir, 'serialize-template.md'), 'utf-8');
    const parsed = matter(file);

    expect(parsed.data.name).toBe('Serialize Template');
    expect(parsed.data.version).toBe('1.0.1');
    expect(parsed.data.triggers).toEqual(['write']);
    expect(parsed.content.trim()).toBe('Content body');
  });

  it('create() slugifies filenames and logs events', async () => {
    const template = await manager.create({
      name: 'Fancy Template',
      description: 'Demonstrates slugging',
      content: 'Hello {{name}}'
    });

    const expectedFile = path.join(templatesDir, 'fancy-template.md');
    await expect(fs.access(expectedFile)).resolves.toBeUndefined();

    expect(template.metadata.name).toBe('Fancy Template');
    expect(securitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'TemplateManager.create',
        type: 'ELEMENT_CREATED'
      })
    );
    expect(securitySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'TemplateManager.save',
        type: 'TEMPLATE_SAVED'
      })
    );
  });

  it('getMostUsed sorts templates by usage count', async () => {
    const templateA = new Template({ name: 'Template A', usage_count: 5 }, 'A', metadataService);
    const templateB = new Template({ name: 'Template B', usage_count: 10 }, 'B', metadataService);
    const templateC = new Template({ name: 'Template C', usage_count: 1 }, 'C', metadataService);

    await manager.save(templateA, 'template-a.md');
    await manager.save(templateB, 'template-b.md');
    await manager.save(templateC, 'template-c.md');

    const mostUsed = await manager.getMostUsed(2);
    expect(mostUsed.map(t => t.metadata.name)).toEqual(['Template B', 'Template A']);
  });

  it('findByTag filters templates by sanitized tag', async () => {
    const templateA = new Template({ name: 'Template A', tags: ['refactor'] }, 'A', metadataService);
    const templateB = new Template({ name: 'Template B', tags: ['refactor', 'optimize'] }, 'B', metadataService);
    const templateC = new Template({ name: 'Template C', tags: ['review'] }, 'C', metadataService);

    await manager.save(templateA, 'template-a.md');
    await manager.save(templateB, 'template-b.md');
    await manager.save(templateC, 'template-c.md');

    const filtered = await manager.findByTag('refactor');
    expect(filtered.map(t => t.metadata.name).sort()).toEqual(['Template A', 'Template B']);
  });
});
