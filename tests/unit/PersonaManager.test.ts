import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../../src/persona/PersonaManager.js';
import { BaseElementManager } from '../../src/elements/base/BaseElementManager.js';
import type { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import type { FileLockManager } from '../../src/security/fileLockManager.js';
import type { FileOperationsService } from '../../src/services/FileOperationsService.js';
import type { PersonaImporter } from '../../src/persona/export-import/PersonaImporter.js';
import type { StateChangeNotifier } from '../../src/services/StateChangeNotifier.js';
import { Persona } from '../../src/types/persona.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../src/config/indicator-config.js';
import { createMockPortfolioManager, createTestMetadataService } from '../helpers/di-mocks.js';
import { ValidationRegistry } from '../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../src/services/validation/ValidationService.js';
import { ElementEventDispatcher } from '../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../src/services/SerializationService.js';

/**
 * PersonaManager Unit Tests
 *
 * Tests the core PersonaManager class with mocked dependencies.
 * Uses DI pattern with mock factories from test helpers.
 */
describe('PersonaManager', () => {
  let personaManager: PersonaManager;
  let mockPortfolioManager: ReturnType<typeof createMockPortfolioManager>;
  let mockFileLockManager: jest.Mocked<FileLockManager>;
  let mockFileOperationsService: jest.Mocked<FileOperationsService>;
  let mockPersonaImporter: jest.Mocked<PersonaImporter>;
  let mockNotifier: jest.Mocked<StateChangeNotifier>;
  const mockPersonasDir = path.join(os.tmpdir(), 'test-personas');

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock portfolio manager using DI mock helper
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
      readElementFile: jest.fn().mockResolvedValue(''),
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

const seedPersonaCache = (entries: Array<[string, Persona]>) => {
  // Seed the BaseElementManager cache directly
  const elementsCache = (personaManager as any).elements;
  const filenames: string[] = [];
  const fileContents: Record<string, string> = {};

  for (const [filename, persona] of entries) {
    // Use persona.id as the cache key (BaseElementManager uses ID-based caching)
    elementsCache.set(persona.id || persona.unique_id || persona.metadata.unique_id, persona);
    filenames.push(filename);

    // Create mock file content for this persona
    const frontmatter = Object.entries(persona.metadata)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join('\n');
    fileContents[filename] = `---\n${frontmatter}\n---\n\n${persona.instructions || persona.content}`;
  }

  // Mock PortfolioManager to return these filenames when listElements is called
  mockPortfolioManager.listElements = jest.fn().mockResolvedValue(filenames);

  // Mock FileOperationsService.readElementFile to return persona content when files are read
  // BaseElementManager.load() uses fileOperations.readElementFile(), not fileLockManager.atomicReadFile()
  mockFileOperationsService.readElementFile.mockImplementation(async (filepath: string) => {
    const filename = path.basename(filepath);
    return fileContents[filename] || '';
  });
};

  describe('Persona Lifecycle', () => {
    it('should create a PersonaManager instance', () => {
      expect(personaManager).toBeDefined();
      expect(personaManager).toBeInstanceOf(PersonaManager);
    });

    it('should get personas directory from portfolio manager', () => {
      expect(mockPortfolioManager.getElementDir).toHaveBeenCalled();
    });
  });

  describe('Persona Activation', () => {
    const testPersona: Persona = {
      metadata: {
        name: 'Test Persona',
        description: 'A test persona',
        unique_id: 'test-persona_20250101-120000_tester'
      },
      instructions: 'You are a test assistant',
      content: '',
      filename: 'test-persona.md',
      unique_id: 'test-persona_20250101-120000_tester'
    };

    beforeEach(() => {
      // Manually set up personas map for testing
      seedPersonaCache([
        ['test-persona.md', testPersona],
        ['Test Persona', testPersona]
      ]);
    });

    it('should activate a persona by name', async () => {
      const result = await personaManager.activatePersona('Test Persona');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Test Persona');
      expect(personaManager.getActivePersona()).toBe(testPersona);
    });

    it('should activate a persona by filename', async () => {
      const result = await personaManager.activatePersona('test-persona.md');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Activated');
    });

    it('should activate a persona by unique_id', async () => {
      const result = await personaManager.activatePersona('test-persona_20250101-120000_tester');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Activated');
    });

    it('should return error for non-existent persona', async () => {
      const result = await personaManager.activatePersona('NonExistent');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should notify state change when activating', async () => {
      await personaManager.activatePersona('Test Persona');

      // Notifier should be called with an object containing the change details
      expect(mockNotifier.notifyPersonaChange).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'persona-activated',
          previousValue: null,
          newValue: 'test-persona.md'
        })
      );
    });
  });

  describe('Cache miss → disk fallback (Issue #843)', () => {
    const testPersona: Persona = {
      metadata: {
        name: 'Evicted Persona',
        description: 'A persona that was evicted from cache',
        unique_id: 'evicted-persona_20250101-120000_tester'
      },
      instructions: 'You are an evicted persona',
      content: '',
      filename: 'evicted-persona.md',
      unique_id: 'evicted-persona_20250101-120000_tester'
    };

    beforeEach(() => {
      // Set up the persona on disk but NOT in cache — simulates cache eviction
      const fileContents: Record<string, string> = {
        'evicted-persona.md': `---\nname: Evicted Persona\ndescription: "A persona that was evicted from cache"\nunique_id: "evicted-persona_20250101-120000_tester"\n---\n\nYou are an evicted persona`,
      };

      mockPortfolioManager.listElements = jest.fn().mockResolvedValue(['evicted-persona.md']);
      mockFileOperationsService.readElementFile.mockImplementation(async (filepath: string) => {
        const filename = path.basename(filepath);
        if (fileContents[filename]) return fileContents[filename];
        throw new Error(`ENOENT: no such file: ${filename}`);
      });
    });

    it('should recover persona from disk when cache is empty', async () => {
      // Cache is empty — findPersona() would return undefined
      expect(personaManager.findPersona('Evicted Persona')).toBeUndefined();

      // findPersonaAsync should recover from disk
      const found = await (personaManager as any).findPersonaAsync('Evicted Persona');
      expect(found).toBeDefined();
      expect(found.metadata.name).toBe('Evicted Persona');
    });

    it('should activate persona recovered from disk after cache eviction', async () => {
      // Cache is empty — synchronous findPersona would fail
      expect(personaManager.findPersona('Evicted Persona')).toBeUndefined();

      // But async activatePersona should recover from disk
      const result = await personaManager.activatePersona('Evicted Persona');
      expect(result.success).toBe(true);
      expect(result.persona).toBeDefined();
      expect(result.persona!.metadata.name).toBe('Evicted Persona');
    });

    it('should reject false positives from disk fallback', async () => {
      // Looking for a completely different name — disk has 'Evicted Persona'
      const found = await (personaManager as any).findPersonaAsync('Totally Different Name');
      expect(found).toBeUndefined();
    });

    it('should prefer cache over disk when persona is cached', async () => {
      // First, seed the cache with the persona
      seedPersonaCache([['evicted-persona.md', testPersona]]);

      // findPersonaAsync should return from cache without hitting disk
      const found = await (personaManager as any).findPersonaAsync('Evicted Persona');
      expect(found).toBeDefined();
      expect(found.metadata.name).toBe('Evicted Persona');
    });

    it('should return not-found for non-existent persona on disk', async () => {
      // Set up empty disk
      mockPortfolioManager.listElements = jest.fn().mockResolvedValue([]);

      const found = await (personaManager as any).findPersonaAsync('Ghost Persona');
      expect(found).toBeUndefined();
    });

    it('should handle disk read errors gracefully', async () => {
      // Make disk reads throw
      mockFileOperationsService.readElementFile.mockRejectedValue(new Error('Disk failure'));

      const found = await (personaManager as any).findPersonaAsync('Evicted Persona');
      // Should return undefined, not throw
      expect(found).toBeUndefined();
    });

    it('should deduplicate concurrent lookups for the same identifier', async () => {
      // Fire two concurrent lookups for the same persona
      const [result1, result2] = await Promise.all([
        (personaManager as any).findPersonaAsync('Evicted Persona'),
        (personaManager as any).findPersonaAsync('Evicted Persona'),
      ]);

      // Both should return the same persona
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1.metadata.name).toBe('Evicted Persona');
      expect(result2.metadata.name).toBe('Evicted Persona');
    });
  });

  describe('Persona Deactivation', () => {
    const testPersona: Persona = {
      metadata: {
        name: 'Test Persona',
        description: 'A test persona',
        unique_id: 'test-persona_20250101-120000_tester'
      },
      instructions: 'Test content',
      content: '',
      filename: 'test-persona.md',
      unique_id: 'test-persona_20250101-120000_tester'
    };

    beforeEach(() => {
      seedPersonaCache([['Test Persona', testPersona]]);
    });

    it('should deactivate the active persona', async () => {
      // First activate
      await personaManager.activatePersona('Test Persona');

      // Then deactivate - Issue #281: Now requires name parameter
      const result = personaManager.deactivatePersona('Test Persona');

      expect(result.success).toBe(true);
      expect(result.message).toContain('Deactivated');
      expect(personaManager.getActivePersona()).toBeNull();
    });

    it('should handle deactivation when no persona is active', () => {
      const result = personaManager.deactivatePersona();

      expect(result.success).toBe(false);
      expect(result.message).toContain('No persona is currently active');
    });

    // Issue #335: Ensure deactivatePersona without identifier returns error when persona is active
    // Note: Internal API uses 'identifier' param; MCP-AQL layer uses 'element_name' (Issue #323)
    it('should require identifier parameter when persona is active (Issue #281)', async () => {
      // First activate a persona
      await personaManager.activatePersona('Test Persona');
      expect(personaManager.getActivePersona()).not.toBeNull();

      // Calling deactivatePersona() without an identifier should return an error
      const result = personaManager.deactivatePersona();

      expect(result.success).toBe(false);
      expect(result.message).toContain('Persona name is required');

      // The persona should STILL be active (not deactivated)
      expect(personaManager.getActivePersona()).not.toBeNull();
    });

    it('should notify state change when deactivating', async () => {
      await personaManager.activatePersona('Test Persona');
      // Issue #281: Now requires name parameter
      personaManager.deactivatePersona('Test Persona');

      expect(mockNotifier.notifyPersonaChange).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'persona-deactivated',
          previousValue: 'test-persona.md',
          newValue: null
        })
      );
    });
  });

  describe('List and Find Operations', () => {
    const testPersonas: Persona[] = [
      {
        metadata: { name: 'Persona 1', description: 'First', unique_id: 'p1' },
        instructions: 'Content 1',
        content: '',
        filename: 'p1.md',
        unique_id: 'p1'
      },
      {
        metadata: { name: 'Persona 2', description: 'Second', unique_id: 'p2' },
        instructions: 'Content 2',
        content: '',
        filename: 'p2.md',
        unique_id: 'p2'
      }
    ];

    beforeEach(() => {
      seedPersonaCache([
        ['p1.md', testPersonas[0]],
        ['p2.md', testPersonas[1]]
      ]);
    });

    it('should list all personas', async () => {
      const result = await personaManager.list();

      expect(result).toHaveLength(2);
      // Check key properties instead of exact equality (personas now have additional fields from BaseElementManager)
      expect(result[0].metadata.name).toBe('Persona 1');
      expect(result[0].instructions).toContain('Content 1');
      expect(result[0].unique_id).toBe('p1');
      expect(result[1].metadata.name).toBe('Persona 2');
      expect(result[1].instructions).toContain('Content 2');
      expect(result[1].unique_id).toBe('p2');
    });

    it('should find persona by predicate', async () => {
      const result = await personaManager.find(p => p.metadata.name === 'Persona 1');

      expect(result).toBeDefined();
      expect(result?.metadata.name).toBe('Persona 1');
    });

    it('should return undefined when persona not found by predicate', async () => {
      const result = await personaManager.find(p => p.metadata.name === 'NonExistent');

      expect(result).toBeUndefined();
    });

    it('should find persona by identifier', () => {
      const result = personaManager.findPersona('p1.md');

      expect(result).toBeDefined();
      expect(result?.metadata.name).toBe('Persona 1');
    });

    it('should find persona by name (case-insensitive)', () => {
      const result = personaManager.findPersona('persona 1');

      expect(result).toBeDefined();
      expect(result?.metadata.name).toBe('Persona 1');
    });

    it('should find persona by unique_id', () => {
      const result = personaManager.findPersona('p1');

      expect(result).toBeDefined();
      expect(result?.unique_id).toBe('p1');
    });
  });

  describe('Import Persona', () => {
    const importedPersona: Persona = {
      metadata: {
        name: 'Imported Persona',
        description: 'Imported description',
        unique_id: 'imported-123',
        author: 'tester'
      },
      instructions: 'Imported content',
      content: '',
      filename: 'imported-persona.md',
      unique_id: 'imported-123',
      id: 'imported-123',
      version: '1.0.0',
      type: 'persona' as any
    };

    let saveSpy: jest.SpyInstance;
    let reloadSpy: jest.SpyInstance;

    beforeEach(() => {
      (personaManager as any).personasHydrated = true;
      saveSpy = jest.spyOn(BaseElementManager.prototype as any, 'save').mockResolvedValue(undefined);
      reloadSpy = jest.spyOn(personaManager, 'reload').mockResolvedValue(undefined);
    });

    afterEach(() => {
      saveSpy.mockRestore();
      reloadSpy.mockRestore();
    });

    it('should successfully import a persona', async () => {
      mockPersonaImporter.importPersona.mockResolvedValue({
        success: true,
        message: 'Imported successfully',
        persona: importedPersona,
        filename: importedPersona.filename
      });

      const result = await personaManager.importPersona('source-data', false);

      expect(result.success).toBe(true);
      expect(mockPersonaImporter.importPersona).toHaveBeenCalledWith(
        'source-data',
        expect.any(Map),
        false
      );
      expect(saveSpy).toHaveBeenCalled();
      // Issue #491: reload() intentionally removed from importPersona —
      // import only adds files, no active persona cleanup needed.
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it('should handle import conflicts', async () => {
      mockPersonaImporter.importPersona.mockResolvedValue({
        success: false,
        message: 'Persona already exists'
      });

      const result = await personaManager.importPersona('source-data', false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should allow overwrite when specified', async () => {
      mockPersonaImporter.importPersona.mockResolvedValue({
        success: true,
        message: 'Overwritten successfully',
        persona: importedPersona,
        filename: importedPersona.filename
      });

      const result = await personaManager.importPersona('source-data', true);

      expect(result.success).toBe(true);
      expect(mockPersonaImporter.importPersona).toHaveBeenCalledWith(
        'source-data',
        expect.any(Map),
        true
      );
      expect(saveSpy).toHaveBeenCalled();
    });

    it('should handle v1 import with bold markdown without YAML corruption (#906)', async () => {
      // v1 format: no instructions in metadata, markdown body with **bold** patterns
      const v1PersonaWithBold: Persona = {
        metadata: {
          name: 'Enterprise Decision Maker',
          description: 'A synthetic survey respondent for market research',
          unique_id: 'enterprise-dm_20250711-120000_tester',
          author: 'tester'
        },
        instructions: '',  // v1 has no instructions
        content: '# Enterprise Decision Maker\n\nYou are a **highly experienced** executive with **deep expertise** in **enterprise procurement** and **vendor evaluation**. You have **strong opinions** about **value propositions** and **ROI frameworks**.',
        filename: 'enterprise-decision-maker.md',
        unique_id: 'enterprise-dm_20250711-120000_tester',
        id: 'enterprise-dm_20250711-120000_tester',
        version: '1.0.0',
        type: 'persona' as any
      };

      mockPersonaImporter.importPersona.mockResolvedValue({
        success: true,
        message: 'Imported successfully',
        persona: v1PersonaWithBold,
        filename: v1PersonaWithBold.filename
      });

      const result = await personaManager.importPersona('source-data', false);

      expect(result.success).toBe(true);
      // Fix #906: The markdown body must be in content (document body), not instructions
      // If instructions were stuffed with the markdown body, YAML serialization would
      // trigger false-positive amplification detection from **bold** patterns
      const saved = result.persona;
      expect(saved).toBeDefined();
      // Instructions should be the description (v1→v2 import path), not the full body
      expect(saved!.instructions).toBe('A synthetic survey respondent for market research');
      // Content (body below ---) should contain the markdown with bold
      expect(saved!.content).toContain('**highly experienced**');
      expect(saved!.content).toContain('**enterprise procurement**');
    });

    it('should handle missing importer', async () => {
      (personaManager as any).personaImporter = undefined;

      const result = await personaManager.importPersona('source-data', false);

      expect(result.success).toBe(false);
      expect(result.message).toContain('not available');
    });
  });

  describe('User Attribution', () => {
    it('should return current user for attribution', () => {
      const user = personaManager.getCurrentUserForAttribution();

      expect(typeof user).toBe('string');
    });

    it('should resolve OS username when no explicit user is set', () => {
      // Save and clear DOLLHOUSE_USER to test OS username fallback
      const originalUser = process.env.DOLLHOUSE_USER;
      delete process.env.DOLLHOUSE_USER;

      try {
        // Create a fresh MetadataService without any user set
        const freshMetadataService = createTestMetadataService();
        const freshValidationRegistry = new ValidationRegistry(
          new ValidationService(),
          new TriggerValidationService(),
          freshMetadataService
        );

        // Create a fresh PersonaManager with the clean metadata service
        const freshPersonaManager = new PersonaManager({
          portfolioManager: mockPortfolioManager as unknown as PortfolioManager,
          indicatorConfig: DEFAULT_INDICATOR_CONFIG,
          fileLockManager: mockFileLockManager,
          fileOperationsService: mockFileOperationsService,
          validationRegistry: freshValidationRegistry,
          serializationService: new SerializationService(),
          metadataService: freshMetadataService,
          eventDispatcher: new ElementEventDispatcher(),
          personaImporter: mockPersonaImporter,
          notifier: mockNotifier,
        });

        const user = freshPersonaManager.getCurrentUserForAttribution();

        // Should resolve to OS username (not anonymous) on standard platforms
        expect(typeof user).toBe('string');
        expect(user.length).toBeGreaterThan(0);
        expect(user.startsWith('anon-')).toBe(false);
      } finally {
        // Restore the original env var
        if (originalUser !== undefined) {
          process.env.DOLLHOUSE_USER = originalUser;
        }
      }
    });
  });

  describe('Persona State', () => {
    it('should get active persona', async () => {
      const testPersona: Persona = {
        metadata: { name: 'Test', description: 'Test', unique_id: 'test' },
        instructions: 'Content',
        content: '',
        filename: 'test.md',
        unique_id: 'test'
      };

      seedPersonaCache([['test.md', testPersona]]);
      await personaManager.activatePersona('test.md');

      const active = personaManager.getActivePersona();

      expect(active).toBe(testPersona);
    });

    it('should return null when no persona is active', () => {
      const active = personaManager.getActivePersona();

      expect(active).toBeNull();
    });

    it('should get all personas as readonly map', () => {
      const testPersona: Persona = {
        metadata: { name: 'Test', description: 'Test', unique_id: 'test' },
        instructions: 'Content',
        content: '',
        filename: 'test.md',
        unique_id: 'test'
      };

      seedPersonaCache([['test.md', testPersona]]);

      const personas = personaManager.getPersonas();

      expect(personas).toBeInstanceOf(Map);
      expect(personas.size).toBe(1);
      expect(personas.get('test.md')).toBe(testPersona);
    });
  });

  describe('Reload Personas', () => {
    it('should return MCP response format when reloading', async () => {
      const testPersona: Persona = {
        metadata: { name: 'Test', description: 'Test', unique_id: 'test' },
        instructions: 'Content',
        content: '',
        filename: 'test.md',
        unique_id: 'test'
      };

      jest.spyOn(personaManager, 'reload').mockResolvedValue(undefined);
      jest.spyOn(personaManager, 'list').mockResolvedValue([testPersona]);

      const result = await personaManager.reloadPersonas();

      expect(result).toHaveProperty('content');
      expect(result.content).toBeInstanceOf(Array);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0].text).toContain('Reloaded');
      expect(result.content[0].text).toContain('1 persona');
    });
  });

  describe('Persona Validation', () => {
    it('should validate a persona and return validation result', () => {
      // Arrange: Create a test persona using the real createElement flow
      const metadata = {
        name: 'Test Persona',
        description: 'A test persona for validation',
        author: 'test-user',
        version: '1.0.0',
        category: 'creative',
        triggers: ['test']
      };
      const content = 'This is test persona content for validation testing.';

      // Act: Use PersonaManager's protected createElement method via type casting
      // This simulates how personas are created when loaded from files
      const persona = (personaManager as any).createElement(metadata, content);

      // Add the persona to cache so findPersona can retrieve it
      (personaManager as any).cacheElement(persona, 'test-persona.md');

      // Now validate the persona
      const result = personaManager.validatePersona('test-persona.md');

      // Assert: Should return a validation result
      expect(result).toBeDefined();
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('report');
    });

    it('should throw error when validating non-existent persona', () => {
      expect(() => {
        personaManager.validatePersona('non-existent-persona');
      }).toThrow('Persona not found');
    });
  });
});
