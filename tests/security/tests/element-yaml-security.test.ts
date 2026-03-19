import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { IElement, ElementStatus } from '../../../src/types/elements/IElement.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';

class TestElement implements IElement {
  id: string;
  version: string;
  type: ElementType;
  metadata: { name: string; description?: string };
  content: string;

  constructor(metadata: { name: string; description?: string }, content: string) {
    this.id = `test-${metadata.name}`;
    this.version = '1.0.0';
    this.type = ElementType.SKILL;
    this.metadata = metadata;
    this.content = content;
  }

  deserialize(_: string): void {
    // Not needed for this test
  }

  getStatus(): ElementStatus {
    return ElementStatus.ACTIVE;
  }

  validate() {
    return { valid: true, errors: [] };
  }

  serialize(): string {
    return `---\nname: ${this.metadata.name}\n---\n\n${this.content}`;
  }
}

class TestElementManager extends BaseElementManager<TestElement> {
  protected async parseMetadata(data: any): Promise<TestElement['metadata']> {
    return { name: data.name ?? 'unknown', description: data.description };
  }

  protected createElement(metadata: TestElement['metadata'], content: string): TestElement {
    return new TestElement(metadata, content.trim());
  }

  protected async serializeElement(element: TestElement): Promise<string> {
    return element.serialize();
  }

  protected getElementLabel(): string {
    return 'skill';
  }

  getFileExtension(): string {
    return '.md';
  }

  async importElement(_: string): Promise<TestElement> {
    throw new Error('Not implemented in tests');
  }

  async exportElement(element: TestElement): Promise<string> {
    return element.serialize();
  }
}

describe('Element YAML security (BaseElementManager integration)', () => {
  let tempDir: string;
  let elementsDir: string;
  let portfolioManager: PortfolioManager;
  let fileLockManager: FileLockManager;
  let fileOperationsService: FileOperationsService;
  let validationRegistry: ValidationRegistry;
  let manager: TestElementManager;

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturesDir = path.resolve(__dirname, '../../fixtures/security');

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'element-yaml-security-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;

    fileLockManager = new FileLockManager();
    fileOperationsService = new FileOperationsService(fileLockManager);
    portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: tempDir });
    await portfolioManager.initialize();

    elementsDir = portfolioManager.getElementDir(ElementType.SKILL);
    await fs.mkdir(elementsDir, { recursive: true });

    // Mock FileLockManager methods to actually perform file operations
    fileLockManager.atomicReadFile = jest.fn(async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    }) as any;
    fileLockManager.atomicWriteFile = jest.fn(async (filePath: string, content: string) => {
      await fs.writeFile(filePath, content, 'utf-8');
    }) as any;

    // Create ValidationRegistry with real services
    const metadataService = new MetadataService();
    validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Create TestElementManager with proper DI including ValidationRegistry
    manager = new TestElementManager(ElementType.SKILL, portfolioManager, fileLockManager, {}, fileOperationsService, validationRegistry);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });

  it('rejects YAML bombs during load()', async () => {
    const source = path.join(fixturesDir, 'yaml-bomb.md');
    const target = path.join(elementsDir, 'yaml-bomb.md');
    await fs.copyFile(source, target);

    await expect(manager.load('yaml-bomb.md')).rejects.toThrow(/yaml/i);
  });

  it('rejects YAML code-injection payloads during load()', async () => {
    const source = path.join(fixturesDir, 'code-injection.md');
    const target = path.join(elementsDir, 'code-injection.md');
    await fs.copyFile(source, target);

    await expect(manager.load('code-injection.md')).rejects.toThrow(/security|yaml|malicious/i);
  });

  it('rejects symlinked files that escape the element directory', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'element-yaml-security-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.md');
    await fs.writeFile(
      outsideFile,
      [
        '---',
        'name: Outside',
        'description: Should not be readable',
        '---',
        '',
        'Forbidden'
      ].join('\n'),
      'utf-8'
    );

    const symlinkPath = path.join(elementsDir, 'escaped.md');
    await fs.symlink(outsideFile, symlinkPath);

    await expect(manager.load('escaped.md')).rejects.toThrow(/access|denied|invalid/i);

    await fs.rm(outsideDir, { recursive: true, force: true });
  });
});
