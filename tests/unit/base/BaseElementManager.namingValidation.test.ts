/**
 * Unit tests for BaseElementManager filename handling
 *
 * Verifies that element files are loaded without type-suffix naming enforcement.
 * The {name}-{type}.ext naming convention has been removed — filenames use
 * plain {name}.ext format, and the directory structure provides type context.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { BaseElementManager, BaseElementManagerOptions } from '../../../src/elements/base/BaseElementManager.js';
import { IElement, ElementValidationResult } from '../../../src/types/elements/IElement.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { logger } from '../../../src/utils/logger.js';

// Mock dependencies
jest.mock('../../../src/security/fileLockManager.js');
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/utils/logger.js');

jest.mock('../../../src/security/pathValidator.js', () => ({
  PathValidator: {
    validateElementPathOnly: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../../../src/security/secureYamlParser.js', () => ({
  SecureYamlParser: {
    safeMatter: jest.fn((content: string) => {
      const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (match) {
        const data: Record<string, string> = {};
        for (const line of match[1].split('\n')) {
          const [key, ...rest] = line.split(':');
          if (key && rest.length) data[key.trim()] = rest.join(':').trim();
        }
        return { data, content: match[2] };
      }
      return { data: {}, content };
    })
  }
}));

// Minimal element interface for testing
interface TestMetadata {
  name: string;
  description?: string;
  version?: string;
  author?: string;
  created?: string;
  modified?: string;
}

interface TestElement extends IElement {
  metadata: TestMetadata;
  content: string;
}

// Concrete test implementation of BaseElementManager to expose protected methods
class TestableElementManager extends BaseElementManager<TestElement> {
  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    options: BaseElementManagerOptions,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry
  ) {
    super(
      ElementType.SKILL, // Use SKILL for testing
      portfolioManager,
      fileLockManager,
      { ...options, eventDispatcher: options.eventDispatcher ?? new ElementEventDispatcher() },
      fileOperationsService,
      validationRegistry
    );
  }

  // Override to return singular form like real managers do
  protected override getElementLabel(): string {
    return 'skill';
  }

  // Implement abstract methods (minimal implementations for testing)
  protected async parseMetadata(data: any): Promise<TestMetadata> {
    return data as TestMetadata;
  }

  protected createElement(metadata: TestMetadata, content: string): TestElement {
    return {
      id: 'test-id',
      type: 'skill',
      version: '1.0.0',
      metadata,
      content,
      serialize: () => JSON.stringify({ metadata, content }),
      deserialize: () => {},
      validate: (): ElementValidationResult => ({ valid: true, isValid: true })
    } as TestElement;
  }

  protected async serializeElement(element: TestElement): Promise<string> {
    return `---\nname: ${element.metadata.name}\n---\n${element.content}`;
  }

  getFileExtension(): string {
    return '.md';
  }

  async importElement(data: string, _format?: 'json' | 'yaml' | 'markdown'): Promise<TestElement> {
    return this.createElement({ name: 'imported' }, data);
  }

  async exportElement(element: TestElement, _format?: 'json' | 'yaml' | 'markdown'): Promise<string> {
    return element.content;
  }
}

describe('BaseElementManager load() without naming convention enforcement', () => {
  let tempDir: string;
  let manager: TestableElementManager;
  let portfolioManager: jest.Mocked<PortfolioManager>;
  let fileLockManager: jest.Mocked<FileLockManager>;
  let fileOperationsService: jest.Mocked<FileOperationsService>;
  let validationRegistry: jest.Mocked<ValidationRegistry>;
  let loggerWarnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'naming-validation-test-'));

    portfolioManager = {
      getElementDir: jest.fn().mockReturnValue(tempDir),
      listElements: jest.fn().mockResolvedValue([])
    } as unknown as jest.Mocked<PortfolioManager>;

    fileLockManager = new FileLockManager() as jest.Mocked<FileLockManager>;

    fileOperationsService = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      readElementFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      deleteFile: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<FileOperationsService>;

    validationRegistry = {
      getValidator: jest.fn().mockReturnValue({
        validateCreate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
        validateEdit: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
        validateMetadata: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] })
      })
    } as unknown as jest.Mocked<ValidationRegistry>;

    manager = new TestableElementManager(
      portfolioManager,
      fileLockManager,
      { elementDirOverride: tempDir, eventDispatcher: new ElementEventDispatcher() },
      fileOperationsService,
      validationRegistry
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const validFileContent = '---\nname: Creative Writer\ndescription: test\n---\nSome content';

  it('should load a plain-named file without warnings', async () => {
    fileOperationsService.readElementFile.mockResolvedValue(validFileContent);
    loggerWarnSpy = jest.spyOn(logger, 'warn');

    const element = await manager.load('creative-writer.md');

    expect(element).toBeDefined();
    expect(element.metadata.name).toBe('Creative Writer');

    // No naming convention warnings
    const namingCalls = loggerWarnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('Naming convention')
    );
    expect(namingCalls).toHaveLength(0);

    loggerWarnSpy.mockRestore();
  });

  it('should load any filename without naming convention enforcement', async () => {
    fileOperationsService.readElementFile.mockResolvedValue(validFileContent);

    // Even a file with type suffix should load fine (old convention files still work)
    const element = await manager.load('creative-writer-skill.md');
    expect(element).toBeDefined();
    expect(element.metadata.name).toBe('Creative Writer');
  });

  it('should not throw regardless of DOLLHOUSE_NAMING_VALIDATION setting', async () => {
    fileOperationsService.readElementFile.mockResolvedValue(validFileContent);
    process.env.DOLLHOUSE_NAMING_VALIDATION = 'strict';

    // Should NOT throw — naming convention enforcement has been removed
    const element = await manager.load('creative-writer.md');
    expect(element).toBeDefined();

    delete process.env.DOLLHOUSE_NAMING_VALIDATION;
  });
});
