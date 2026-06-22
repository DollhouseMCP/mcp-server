/**
 * Unit tests for BaseElementManager.normalizeFilename()
 *
 * Tests the unified filename normalization method that ensures consistent
 * filename formatting across all element managers.
 *
 * The method handles:
 * - CamelCase splitting (MyName -> my-name)
 * - Space to hyphen conversion
 * - Underscore to hyphen conversion
 * - Invalid character stripping
 * - Multiple hyphen collapsing
 * - Leading/trailing hyphen trimming
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// We need to test the protected method, so we'll create a concrete test class
// that exposes the method publicly
import { BaseElementManager, BaseElementManagerOptions } from '../../../src/elements/base/BaseElementManager.js';
import { IElement, ElementValidationResult } from '../../../src/types/elements/IElement.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

// Mock dependencies
jest.mock('../../../src/security/fileLockManager.js');
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/utils/logger.js');

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
      options,
      fileOperationsService,
      validationRegistry
    );
  }

  // Override to return singular form like real managers do
  protected override getElementLabel(): string {
    return 'skill';
  }

  // Expose protected methods for testing
  public testNormalizeFilename(name: string): string {
    return this.normalizeFilename(name);
  }

  public testGetElementFilename(name: string): string {
    return this.getElementFilename(name);
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

describe('BaseElementManager.normalizeFilename()', () => {
  let tempDir: string;
  let manager: TestableElementManager;
  let portfolioManager: jest.Mocked<PortfolioManager>;
  let fileLockManager: jest.Mocked<FileLockManager>;
  let fileOperationsService: jest.Mocked<FileOperationsService>;
  let validationRegistry: jest.Mocked<ValidationRegistry>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-filename-test-'));

    // Create mocks
    portfolioManager = {
      getElementDir: jest.fn().mockReturnValue(tempDir),
      listElements: jest.fn().mockResolvedValue([])
    } as any;

    fileLockManager = new FileLockManager() as jest.Mocked<FileLockManager>;

    fileOperationsService = {
      createDirectory: jest.fn().mockResolvedValue(undefined),
      readElementFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      deleteFile: jest.fn().mockResolvedValue(undefined)
    } as any;

    validationRegistry = {
      getValidator: jest.fn().mockReturnValue({
        validateCreate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
        validateEdit: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] })
      })
    } as any;

    manager = new TestableElementManager(
      portfolioManager,
      fileLockManager,
      { elementDirOverride: tempDir, storageLayerFactory: createTestStorageFactory(fileOperationsService) },
      fileOperationsService,
      validationRegistry
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('CamelCase handling', () => {
    it('should split CamelCase words with hyphens', () => {
      expect(manager.testNormalizeFilename('CamelCase')).toBe('camel-case');
      expect(manager.testNormalizeFilename('CamelCaseName')).toBe('camel-case-name');
      expect(manager.testNormalizeFilename('MyAwesomeAgent')).toBe('my-awesome-agent');
    });

    it('should handle consecutive uppercase letters correctly', () => {
      // Consecutive uppercase like "HTMLParser" should become "html-parser"
      // Note: The regex only inserts hyphen between lowercase-uppercase boundaries
      expect(manager.testNormalizeFilename('HTMLParser')).toBe('htmlparser');
      expect(manager.testNormalizeFilename('XMLReader')).toBe('xmlreader');
    });

    it('should handle mixed case with existing hyphens', () => {
      expect(manager.testNormalizeFilename('CRUDV-Agent-Delta')).toBe('crudv-agent-delta');
      expect(manager.testNormalizeFilename('My-CamelCase-Name')).toBe('my-camel-case-name');
    });
  });

  describe('Space handling', () => {
    it('should convert spaces to hyphens', () => {
      expect(manager.testNormalizeFilename('Creative Writer')).toBe('creative-writer');
      expect(manager.testNormalizeFilename('My Awesome Agent')).toBe('my-awesome-agent');
    });

    it('should handle multiple consecutive spaces', () => {
      expect(manager.testNormalizeFilename('Multiple   Spaces')).toBe('multiple-spaces');
      expect(manager.testNormalizeFilename('Too    Many     Spaces')).toBe('too-many-spaces');
    });

    it('should handle leading and trailing spaces', () => {
      expect(manager.testNormalizeFilename('  Leading Spaces')).toBe('leading-spaces');
      expect(manager.testNormalizeFilename('Trailing Spaces  ')).toBe('trailing-spaces');
      expect(manager.testNormalizeFilename('  Both Sides  ')).toBe('both-sides');
    });
  });

  describe('Underscore handling', () => {
    it('should convert underscores to hyphens', () => {
      expect(manager.testNormalizeFilename('my_skill_name')).toBe('my-skill-name');
      expect(manager.testNormalizeFilename('multi_goal_agent')).toBe('multi-goal-agent');
    });

    it('should handle multiple consecutive underscores', () => {
      expect(manager.testNormalizeFilename('multiple___underscores')).toBe('multiple-underscores');
    });

    it('should handle mixed spaces and underscores', () => {
      expect(manager.testNormalizeFilename('mixed_spaces and_underscores')).toBe('mixed-spaces-and-underscores');
    });
  });

  describe('Special character handling', () => {
    it('should strip invalid characters', () => {
      expect(manager.testNormalizeFilename('Special@Chars!')).toBe('special-chars');
      expect(manager.testNormalizeFilename('Name#With$Symbols%')).toBe('name-with-symbols');
    });

    it('should handle dots', () => {
      expect(manager.testNormalizeFilename('file.name')).toBe('file-name');
      expect(manager.testNormalizeFilename('version.1.0')).toBe('version-1-0');
    });

    it('should handle parentheses and brackets', () => {
      expect(manager.testNormalizeFilename('Name(v1)')).toBe('name-v1');
      expect(manager.testNormalizeFilename('Item[0]')).toBe('item-0');
    });

    it('should preserve hyphens and alphanumerics', () => {
      expect(manager.testNormalizeFilename('already-valid-123')).toBe('already-valid-123');
    });
  });

  describe('Hyphen collapsing', () => {
    it('should collapse multiple consecutive hyphens', () => {
      expect(manager.testNormalizeFilename('multiple--hyphens')).toBe('multiple-hyphens');
      expect(manager.testNormalizeFilename('too---many----hyphens')).toBe('too-many-hyphens');
    });

    it('should collapse hyphens created by character stripping', () => {
      expect(manager.testNormalizeFilename('a@#$b')).toBe('a-b');
      expect(manager.testNormalizeFilename('x!!!y')).toBe('x-y');
    });
  });

  describe('Leading/trailing hyphen trimming', () => {
    it('should trim leading hyphens', () => {
      expect(manager.testNormalizeFilename('-leading')).toBe('leading');
      expect(manager.testNormalizeFilename('---leading')).toBe('leading');
    });

    it('should trim trailing hyphens', () => {
      expect(manager.testNormalizeFilename('trailing-')).toBe('trailing');
      expect(manager.testNormalizeFilename('trailing---')).toBe('trailing');
    });

    it('should trim both leading and trailing hyphens', () => {
      expect(manager.testNormalizeFilename('-both-sides-')).toBe('both-sides');
      expect(manager.testNormalizeFilename('---both---sides---')).toBe('both-sides');
    });

    it('should handle names that become only hyphens', () => {
      expect(manager.testNormalizeFilename('@#$%')).toBe('');
      expect(manager.testNormalizeFilename('---')).toBe('');
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      expect(manager.testNormalizeFilename('')).toBe('unnamed');
    });

    it('should handle whitespace-only string', () => {
      expect(manager.testNormalizeFilename('   ')).toBe('unnamed');
      expect(manager.testNormalizeFilename('\t\n')).toBe('unnamed');
    });

    it('should handle single character names', () => {
      expect(manager.testNormalizeFilename('a')).toBe('a');
      expect(manager.testNormalizeFilename('A')).toBe('a');
      expect(manager.testNormalizeFilename('1')).toBe('1');
    });

    it('should handle very long names', () => {
      const longName = 'A'.repeat(1000);
      const result = manager.testNormalizeFilename(longName);
      expect(result).toBe('a'.repeat(1000));
    });

    it('should handle unicode characters', () => {
      expect(manager.testNormalizeFilename('cafe')).toBe('cafe');
      // Unicode characters should be stripped
      expect(manager.testNormalizeFilename('cafeee')).toBe('cafeee');
    });

    it('should handle numbers', () => {
      expect(manager.testNormalizeFilename('Agent123')).toBe('agent123');
      // Note: The regex only inserts hyphens between lowercase-uppercase boundaries,
      // not between digits and letters. This is intentional for simple, predictable behavior.
      expect(manager.testNormalizeFilename('123Agent')).toBe('123agent');
      expect(manager.testNormalizeFilename('Agent 123 Test')).toBe('agent-123-test');
    });
  });

  describe('Real-world scenarios from design document', () => {
    it('should normalize CRUDV-Agent-Delta correctly', () => {
      expect(manager.testNormalizeFilename('CRUDV-Agent-Delta')).toBe('crudv-agent-delta');
    });

    it('should normalize Creative Writer correctly', () => {
      expect(manager.testNormalizeFilename('Creative Writer')).toBe('creative-writer');
    });

    it('should normalize my_skill_name correctly', () => {
      expect(manager.testNormalizeFilename('my_skill_name')).toBe('my-skill-name');
    });

    it('should normalize CamelCaseName correctly', () => {
      expect(manager.testNormalizeFilename('CamelCaseName')).toBe('camel-case-name');
    });

    it('should normalize Special@Chars! correctly', () => {
      expect(manager.testNormalizeFilename('Special@Chars!')).toBe('special-chars');
    });
  });

  describe('getElementFilename()', () => {
    // The type is NOT included in the filename — the directory provides type context.

    it('should normalize name and add file extension', () => {
      expect(manager.testGetElementFilename('MyAgent')).toBe('my-agent.md');
      expect(manager.testGetElementFilename('Creative Writer')).toBe('creative-writer.md');
      expect(manager.testGetElementFilename('Code Review')).toBe('code-review.md');
    });

    it('should handle already normalized names', () => {
      expect(manager.testGetElementFilename('already-normalized')).toBe('already-normalized.md');
    });

    it('should not strip type words from names that contain them', () => {
      // Names containing type words should remain intact
      expect(manager.testGetElementFilename('code-review-skill')).toBe('code-review-skill.md');
      expect(manager.testGetElementFilename('fix-persona-helper')).toBe('fix-persona-helper.md');
    });

    it('should handle edge cases with extension', () => {
      expect(manager.testGetElementFilename('')).toBe('unnamed.md');
      expect(manager.testGetElementFilename('   ')).toBe('unnamed.md');
    });

    it('should handle names that strip to empty string', () => {
      expect(manager.testGetElementFilename('@#$%')).toBe('unnamed.md');
      expect(manager.testGetElementFilename('---')).toBe('unnamed.md');
    });
  });
});
