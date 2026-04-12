/**
 * PersonaElementManager Integration Tests
 *
 * Tests PersonaManager's proper integration with BaseElementManager pattern.
 * This ensures the template methods are correctly implemented and the inheritance
 * chain works as expected.
 *
 * CRITICAL: PersonaManager must properly extend BaseElementManager and implement
 * all required abstract methods while maintaining security guarantees.
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';
import type { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import type { FileLockManager } from '../../../src/security/fileLockManager.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import type { PersonaImporter } from '../../../src/persona/export-import/PersonaImporter.js';
import type { StateChangeNotifier } from '../../../src/services/StateChangeNotifier.js';
import { Persona, PersonaMetadata } from '../../../src/types/persona.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../src/config/indicator-config.js';
import { createMockPortfolioManager, createTestMetadataService } from '../../helpers/di-mocks.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../../src/services/SerializationService.js';

describe('PersonaElementManager Integration', () => {
  let personaManager: PersonaManager;
  let mockPortfolioManager: ReturnType<typeof createMockPortfolioManager>;
  let mockFileLockManager: jest.Mocked<FileLockManager>;
  let mockFileOperationsService: jest.Mocked<FileOperationsService>;
  let mockPersonaImporter: jest.Mocked<PersonaImporter>;
  let mockNotifier: jest.Mocked<StateChangeNotifier>;
  const mockPersonasDir = path.join(os.tmpdir(), 'test-personas');

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock portfolio manager
    mockPortfolioManager = createMockPortfolioManager({
      getElementDir: jest.fn().mockReturnValue(mockPersonasDir)
    });

    // Mock FileLockManager
    mockFileLockManager = {
      withLock: jest.fn().mockImplementation(async (_path, callback) => await callback()),
      acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
      release: jest.fn(),
      atomicWriteFile: jest.fn().mockResolvedValue(undefined),
      atomicReadFile: jest.fn().mockResolvedValue(''),
    } as any;

    // Mock FileOperationsService
    mockFileOperationsService = {
      readFile: jest.fn().mockResolvedValue(''),
      writeFile: jest.fn().mockResolvedValue(undefined),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      listDirectory: jest.fn().mockResolvedValue([]),
      createDirectory: jest.fn().mockResolvedValue(undefined),
      resolvePath: jest.fn((p: string) => p),
      validatePath: jest.fn().mockReturnValue(true),
    } as any;

    // Mock PersonaImporter
    mockPersonaImporter = {
      importPersona: jest.fn().mockResolvedValue({ success: true, message: 'Imported' }),
    } as any;

    // Mock StateChangeNotifier
    mockNotifier = {
      notifyPersonaChange: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
    } as any;

    // Create service instances for DI
    const metadataService = createTestMetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    // Create PersonaManager instance
    personaManager = new PersonaManager({
      portfolioManager: mockPortfolioManager as unknown as PortfolioManager,
      indicatorConfig: DEFAULT_INDICATOR_CONFIG,
      fileLockManager: mockFileLockManager,
      fileOperationsService: mockFileOperationsService,
      validationRegistry,
      serializationService: new SerializationService(),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
      personaImporter: mockPersonaImporter,
      notifier: mockNotifier,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================================
  // 1. BaseElementManager Integration Tests (5 scenarios)
  // ============================================================================

  describe('BaseElementManager Integration', () => {
    it('should extend BaseElementManager correctly', () => {
      expect(personaManager).toBeInstanceOf(BaseElementManager);
      expect(personaManager).toBeInstanceOf(PersonaManager);
    });

    it('should implement all required abstract methods', () => {
      // Verify template methods exist and are callable
      expect(typeof (personaManager as any).parseMetadata).toBe('function');
      expect(typeof (personaManager as any).createElement).toBe('function');
      expect(typeof (personaManager as any).serializeElement).toBe('function');
      expect(typeof personaManager.getFileExtension).toBe('function');
      expect(typeof personaManager.importElement).toBe('function');
      expect(typeof personaManager.exportElement).toBe('function');
    });

    it('should use correct element type from base class', () => {
      const elementType = personaManager.getElementType();
      expect(elementType).toBe(ElementType.PERSONA);
    });

    it('should properly access protected properties from base class', () => {
      // Verify portfolioManager is accessible and functional
      expect(mockPortfolioManager.getElementDir).toHaveBeenCalled();

      // Verify fileLockManager is accessible
      const lockManager = (personaManager as any).fileLockManager;
      expect(lockManager).toBeDefined();
      expect(lockManager).toBe(mockFileLockManager);
    });

    it('should inherit cache management from base class', () => {
      const cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats).toHaveProperty('elementCount');
      expect(cacheStats).toHaveProperty('pathMappings');
      expect(cacheStats.elementCount).toBe(0);
      expect(cacheStats.pathMappings).toBe(0);
    });
  });

  // ============================================================================
  // 2. Element Factory Pattern Tests (4 scenarios)
  // ============================================================================

  describe('Element Factory Pattern', () => {
    it('should create persona with valid metadata using createElement', () => {
      const metadata: PersonaMetadata = {
        name: 'Test Persona',
        description: 'A test persona for factory testing',
        unique_id: 'test-persona_20250101_testuser',
        author: 'testuser',
        version: '1.0',
        category: 'general',
        age_rating: 'all',
        content_flags: ['user-created']
      };
      const content = 'You are a helpful test assistant.';

      const persona = (personaManager as any).createElement(metadata, content);

      expect(persona).toBeDefined();
      expect(persona.metadata.name).toBe('Test Persona');
      expect(persona.instructions).toBe(content);
      expect(persona.id).toBe(metadata.unique_id);
      expect(persona.unique_id).toBe(metadata.unique_id);
      expect(persona.type).toBe(ElementType.PERSONA);
    });

    it('should create persona with minimal metadata (defaults)', () => {
      const minimalMetadata: PersonaMetadata = {
        name: 'Minimal Persona',
        description: 'Minimal test',
        unique_id: 'minimal_20250101_testuser',
        author: 'testuser'
      };
      const content = 'Minimal content.';

      const persona = (personaManager as any).createElement(minimalMetadata, content);

      expect(persona).toBeDefined();
      expect(persona.metadata.name).toBe('Minimal Persona');
      // Verify defaults are applied by createElement to element.version
      // BaseElement normalizes version to X.Y.Z format
      expect(persona.version).toBe('1.0.0');
    });

    it('should create persona with full metadata (all fields)', () => {
      const fullMetadata: PersonaMetadata = {
        name: 'Complete Persona',
        description: 'A fully specified persona',
        unique_id: 'complete-persona_20250101_testuser',
        author: 'testuser',
        version: '2.5',
        category: 'professional',
        age_rating: '18+',
        content_flags: ['user-created', 'advanced'],
        triggers: ['expert', 'professional', 'advanced'],
        price: 'free',
        license: 'MIT',
        created_date: '2025-01-01',
        ai_generated: false,
        generation_method: 'manual'
      };
      const content = 'You are a professional expert assistant.';

      const persona = (personaManager as any).createElement(fullMetadata, content);

      expect(persona).toBeDefined();
      expect(persona.metadata.name).toBe('Complete Persona');
      expect(persona.metadata.version).toBe('2.5.0');  // MetadataService normalizes version to semver
      expect(persona.metadata.category).toBe('professional');
      expect(persona.metadata.age_rating).toBe('18+');
      expect(persona.metadata.triggers).toEqual(['expert', 'professional', 'advanced']);
      expect(persona.metadata.ai_generated).toBe(false);
    });

    it('should handle createElement with missing optional fields correctly', () => {
      const metadataWithoutOptionals: PersonaMetadata = {
        name: 'No Optionals',
        description: 'Testing optional field handling',
        unique_id: 'no-optionals_20250101_testuser',
        author: 'testuser'
        // triggers, version, etc. not provided
      };
      const content = 'Content without optional metadata.';

      const persona = (personaManager as any).createElement(metadataWithoutOptionals, content);

      expect(persona).toBeDefined();
      expect(persona.metadata.name).toBe('No Optionals');
      expect(persona.instructions).toBe(content);
      // Optional fields should either be undefined or have defaults from createElement
      // BaseElement normalizes version to X.Y.Z format
      expect(persona.version).toBe('1.0.0'); // Default applied to element.version
      expect(persona.metadata.triggers).toBeUndefined();
    });
  });

  // ============================================================================
  // 3. Cache Management Tests (3 scenarios)
  // ============================================================================

  describe('Cache Management', () => {
    it('should cache elements after creation', () => {
      const metadata: PersonaMetadata = {
        name: 'Cached Persona',
        description: 'Testing cache behavior',
        unique_id: 'cached-persona_20250101_testuser',
        author: 'testuser'
      };
      const content = 'Cached content';
      const persona = (personaManager as any).createElement(metadata, content);

      // Cache the element using protected method
      (personaManager as any).cacheElement(persona, 'cached-persona.md');

      const cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(1);
      expect(cacheStats.pathMappings).toBe(1);

      // Verify we can retrieve from cache
      const cached = (personaManager as any).elements.get(persona.id);
      expect(cached).toBeDefined();
      expect(cached.metadata.name).toBe('Cached Persona');
    });

    it('should invalidate cache on clear', () => {
      const metadata: PersonaMetadata = {
        name: 'Clearable Persona',
        description: 'Testing cache clear',
        unique_id: 'clearable-persona_20250101_testuser',
        author: 'testuser'
      };
      const content = 'Clearable content';
      const persona = (personaManager as any).createElement(metadata, content);

      (personaManager as any).cacheElement(persona, 'clearable-persona.md');

      // Verify cache has entry
      let cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(1);

      // Clear cache
      personaManager.clearCache();

      // Verify cache is empty
      cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(0);
      expect(cacheStats.pathMappings).toBe(0);
    });

    it('should handle LRU cache eviction with size limits', () => {
      // Create multiple personas to test LRU behavior
      const personas: Persona[] = [];
      for (let i = 0; i < 25; i++) {
        const metadata: PersonaMetadata = {
          name: `Persona ${i}`,
          description: `Testing LRU eviction ${i}`,
          unique_id: `persona-${i}_20250101_testuser`,
          author: 'testuser'
        };
        const content = `Content for persona ${i}`;
        const persona = (personaManager as any).createElement(metadata, content);
        personas.push(persona);
        (personaManager as any).cacheElement(persona, `persona-${i}.md`);
      }

      // Verify cache is managing entries (should have all 25 since limit is 1000)
      const cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(25);
      expect(cacheStats.pathMappings).toBe(25);

      // Access first persona to update LRU order
      const firstPersona = (personaManager as any).elements.get(personas[0].id);
      expect(firstPersona).toBeDefined();
    });
  });

  // ============================================================================
  // 4. Serialization and Parsing Tests (3 scenarios)
  // ============================================================================

  describe('Serialization and Parsing', () => {
    it('should serialize persona to markdown with frontmatter', async () => {
      const metadata: PersonaMetadata = {
        name: 'Serializable Persona',
        description: 'Testing serialization',
        unique_id: 'serializable_20250101_testuser',
        author: 'testuser',
        version: '1.0',
        category: 'general',
        age_rating: 'all',
        content_flags: ['user-created']
      };
      const content = 'You are a serializable assistant.';
      const persona = (personaManager as any).createElement(metadata, content);

      const serialized = await (personaManager as any).serializeElement(persona);

      expect(serialized).toContain('---');
      expect(serialized).toContain('name:');
      expect(serialized).toContain('Serializable Persona');
      expect(serialized).toContain('description:');
      expect(serialized).toContain('Testing serialization');
      expect(serialized).toContain('# Serializable Persona');
      expect(serialized).toContain('You are a serializable assistant.');
    });

    it('should parse metadata correctly', async () => {
      const rawMetadata = {
        name: 'Parseable Persona',
        description: 'Testing parsing',
        unique_id: 'parseable_20250101_testuser',
        author: 'testuser'
      };

      const parsed = await (personaManager as any).parseMetadata(rawMetadata);

      expect(parsed).toBeDefined();
      expect(parsed.name).toBe('Parseable Persona');
      expect(parsed.description).toBe('Testing parsing');
      expect(parsed.unique_id).toBe('parseable_20250101_testuser');
    });

    it('should handle import and export roundtrip', async () => {
      const originalMetadata: PersonaMetadata = {
        name: 'Roundtrip Persona',
        description: 'Testing roundtrip',
        unique_id: 'roundtrip_20250101_testuser',
        author: 'testuser',
        version: '1.5',
        category: 'test',
        triggers: ['test', 'roundtrip']
      };
      const originalContent = 'You are a roundtrip test assistant.';
      const originalPersona = (personaManager as any).createElement(originalMetadata, originalContent);

      // Export to markdown
      const exported = await personaManager.exportElement(originalPersona, 'markdown');
      expect(exported).toBeDefined();
      expect(typeof exported).toBe('string');

      // Import back
      const imported = await personaManager.importElement(exported, 'markdown');
      expect(imported).toBeDefined();
      expect(imported.metadata.name).toBe('Roundtrip Persona');
      expect(imported.instructions.trim()).toContain('You are a roundtrip test assistant.');
    });
  });

  // ============================================================================
  // 5. Error Handling Tests (3 scenarios)
  // ============================================================================

  describe('Error Handling', () => {
    it('should handle corrupted YAML gracefully', async () => {
      const corruptedYaml = `---
name: Test
description: [unclosed array
---
Content`;

      await expect(
        personaManager.importElement(corruptedYaml, 'markdown')
      ).rejects.toThrow();
    });

    it('should handle missing required metadata fields', async () => {
      const incompleteMetadata = {
        // Missing name
        description: 'Incomplete metadata test'
      };

      const parsed = await (personaManager as any).parseMetadata(incompleteMetadata);

      // parseMetadata should provide defaults for missing fields
      expect(parsed.name).toBe('Untitled Persona');
      expect(parsed.description).toBe('Incomplete metadata test');
    });

    it('should provide proper error messages for validation failures', async () => {
      const _maliciousMetadata = {
        '__proto__': 'evil',
        name: 'Malicious Persona',
        description: 'Attempting prototype pollution'
      };

      const yamlContent = `---
__proto__: evil
name: Malicious Persona
description: Attempting prototype pollution
---
Content`;

      // importElement should reject malicious metadata
      await expect(
        personaManager.importElement(yamlContent, 'markdown')
      ).rejects.toThrow();
    });
  });

  // ============================================================================
  // 6. Lifecycle Hooks Tests (2 scenarios)
  // ============================================================================

  describe('Lifecycle Hooks', () => {
    it('should call beforeSave hook if defined', async () => {
      const metadata: PersonaMetadata = {
        name: 'Lifecycle Test',
        description: 'Testing lifecycle hooks',
        unique_id: 'lifecycle_20250101_testuser',
        author: 'testuser'
      };
      const content = 'Lifecycle content';
      const persona = (personaManager as any).createElement(metadata, content);

      // Mock beforeSave to verify it's called
      const beforeSaveSpy = jest.fn();
      (personaManager as any).beforeSave = beforeSaveSpy;

      await personaManager.save(persona, 'lifecycle-test.md');

      expect(beforeSaveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ name: 'Lifecycle Test' }) }),
        'lifecycle-test.md'
      );
    });

    it('should properly dispose and clean up resources', () => {
      // Add some cached elements
      const metadata: PersonaMetadata = {
        name: 'Disposable',
        description: 'Testing disposal',
        unique_id: 'disposable_20250101_testuser',
        author: 'testuser'
      };
      const persona = (personaManager as any).createElement(metadata, 'Content');
      (personaManager as any).cacheElement(persona, 'disposable.md');

      // Verify cache has entries
      let cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(1);

      // Dispose
      personaManager.dispose();

      // Verify cleanup
      cacheStats = (personaManager as any).getCacheStats();
      expect(cacheStats.elementCount).toBe(0);
      expect(cacheStats.pathMappings).toBe(0);
    });
  });

  // ============================================================================
  // 7. File Extension Tests (1 scenario)
  // ============================================================================

  describe('File Extension', () => {
    it('should return correct file extension for personas', () => {
      const extension = personaManager.getFileExtension();
      expect(extension).toBe('.md');
    });
  });
});
