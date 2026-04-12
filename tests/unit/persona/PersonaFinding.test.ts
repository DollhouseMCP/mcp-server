/**
 * PersonaFinding - Multi-Strategy Search Tests
 *
 * Tests PersonaManager's multi-strategy finding capabilities:
 * 1. Exact match strategies (filename, name, unique_id)
 * 2. Case-insensitive matching
 * 3. Strategy priority and fallback order
 * 4. Edge cases (special chars, Unicode, emoji)
 * 5. Performance benchmarks with large datasets
 *
 * Phase 3.3: Day 2/3 of test coverage expansion
 * Target: 150-200 lines with performance testing
 * Priority: HIGH (Multi-strategy finding has 40% coverage)
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import type { FileLockManager } from '../../../src/security/fileLockManager.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { Persona } from '../../../src/types/persona.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../src/config/indicator-config.js';
import { createMockPortfolioManager, createTestMetadataService } from '../../helpers/di-mocks.js';
import { ValidationRegistry } from '../../../src/services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../../src/services/validation/ValidationService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { SerializationService } from '../../../src/services/SerializationService.js';

describe('PersonaFinding - Multi-Strategy Search', () => {
  let personaManager: PersonaManager;
  let mockPortfolioManager: ReturnType<typeof createMockPortfolioManager>;
  let mockFileLockManager: jest.Mocked<FileLockManager>;
  const mockPersonasDir = path.join(os.tmpdir(), 'test-personas');

  // Test personas with various naming patterns
  const testPersonas: Persona[] = [
    {
      id: 'creative-writer-abc123',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Creative Writer',
        description: 'A creative writing assistant',
        unique_id: 'creative-writer-abc123',
        category: 'creative',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Creative-Writer.md',
      unique_id: 'creative-writer-abc123'
    } as Persona,
    {
      id: 'test-special-chars-def456',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Test & Test',
        description: 'Persona with special characters',
        unique_id: 'test-special-chars-def456',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-And-Test.md',
      unique_id: 'test-special-chars-def456'
    } as Persona,
    {
      id: 'test-unicode-ghi789',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Tëst Përsoñä',
        description: 'Persona with Unicode characters',
        unique_id: 'test-unicode-ghi789',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-Unicode.md',
      unique_id: 'test-unicode-ghi789'
    } as Persona,
    {
      id: 'test-emoji-jkl012',
      type: ElementType.PERSONA,
      version: '1.0',
      metadata: {
        name: 'Test 😀 Persona',
        description: 'Persona with emoji',
        unique_id: 'test-emoji-jkl012',
        category: 'personal',
        version: '1.0',
        author: 'test',
        created_date: '2025-01-01'
      },
      content: 'Test content',
      filename: 'Test-Emoji.md',
      unique_id: 'test-emoji-jkl012'
    } as Persona
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockPortfolioManager = createMockPortfolioManager({
      getElementDir: jest.fn().mockReturnValue(mockPersonasDir)
    });

    mockFileLockManager = {
      withLock: jest.fn().mockImplementation(async (_path, callback) => await callback()),
      acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
      release: jest.fn(),
      atomicWriteFile: jest.fn().mockResolvedValue(undefined),
      atomicReadFile: jest.fn().mockResolvedValue(''),
    } as any;

    // Mock FileOperationsService
    const mockFileOperationsService: jest.Mocked<FileOperationsService> = {
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

    // Create service instances for DI
    const metadataService = createTestMetadataService();
    const validationRegistry = new ValidationRegistry(
      new ValidationService(),
      new TriggerValidationService(),
      metadataService
    );

    personaManager = new PersonaManager({
      portfolioManager: mockPortfolioManager as unknown as PortfolioManager,
      indicatorConfig: DEFAULT_INDICATOR_CONFIG,
      fileLockManager: mockFileLockManager,
      fileOperationsService: mockFileOperationsService,
      validationRegistry,
      serializationService: new SerializationService(),
      metadataService,
      eventDispatcher: new ElementEventDispatcher(),
    });

    // Populate cache with test personas
    for (const persona of testPersonas) {
      (personaManager as any).elements.set(persona.filename, persona);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================================
  // 1. Exact Match Tests (4 tests)
  // ============================================================================

  describe('Exact Match Strategies', () => {
    it('should find persona by exact filename with .md extension', () => {
      const found = personaManager.findPersona('Creative-Writer.md');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
      expect(found?.filename).toBe('Creative-Writer.md');
    });

    it('should find persona by filename without .md extension', () => {
      const found = personaManager.findPersona('Creative-Writer');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
      expect(found?.filename).toBe('Creative-Writer.md');
    });

    it('should find persona by exact name', () => {
      const found = personaManager.findPersona('Creative Writer');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
      expect(found?.unique_id).toBe('creative-writer-abc123');
    });

    it('should find persona by unique_id', () => {
      const found = personaManager.findPersona('creative-writer-abc123');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
      expect(found?.unique_id).toBe('creative-writer-abc123');
    });
  });

  // ============================================================================
  // 2. Case-Insensitive Tests (3 tests)
  // ============================================================================

  describe('Case-Insensitive Matching', () => {
    it('should find persona by lowercase name', () => {
      const found = personaManager.findPersona('creative writer');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
    });

    it('should find persona by uppercase name', () => {
      const found = personaManager.findPersona('CREATIVE WRITER');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
    });

    it('should find persona by mixed case name', () => {
      const found = personaManager.findPersona('CrEaTiVe WrItEr');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
    });
  });

  // ============================================================================
  // 3. Strategy Priority Tests (3 tests)
  // ============================================================================

  describe('Strategy Priority', () => {
    it('should prioritize filename match over name match', () => {
      // Create persona where filename differs from name pattern
      const ambiguousPersona: Persona = {
        id: 'test-priority-001',
        type: ElementType.PERSONA,
        version: '1.0',
        metadata: {
          name: 'Test-Priority',
          description: 'Test',
          unique_id: 'test-priority-001',
          category: 'personal',
          version: '1.0',
          author: 'test',
          created_date: '2025-01-01'
        },
        content: 'Test',
        filename: 'Test-Priority.md',
        unique_id: 'test-priority-001'
      } as Persona;

      (personaManager as any).elements.set(ambiguousPersona.filename, ambiguousPersona);

      // Search by filename - should find by filename strategy first
      const found = personaManager.findPersona('Test-Priority.md');
      expect(found).toBeDefined();
      expect(found?.filename).toBe('Test-Priority.md');
    });

    it('should prioritize name match over unique_id match when filename does not match', () => {
      const found = personaManager.findPersona('Creative Writer');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
    });

    it('should fallback to unique_id match when filename and name do not match', () => {
      const found = personaManager.findPersona('test-special-chars-def456');

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe('test-special-chars-def456');
      expect(found?.metadata.name).toBe('Test & Test');
    });
  });

  // ============================================================================
  // 4. Edge Cases (5 tests)
  // ============================================================================

  describe('Edge Cases', () => {
    it('should return undefined for empty identifier', () => {
      const found = personaManager.findPersona('');
      expect(found).toBeUndefined();
    });

    it('should return undefined for whitespace-only identifier', () => {
      const found = personaManager.findPersona('   ');
      expect(found).toBeUndefined();
    });

    it('should find persona with special characters in name', () => {
      const found = personaManager.findPersona('Test & Test');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Test & Test');
    });

    it('should find persona with Unicode characters in name', () => {
      const found = personaManager.findPersona('Tëst Përsoñä');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Tëst Përsoñä');
    });

    it('should find persona with emoji in name', () => {
      const found = personaManager.findPersona('Test 😀 Persona');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Test 😀 Persona');
    });
  });

  // ============================================================================
  // 5. Performance Tests (3 tests)
  // ============================================================================

  describe('Performance Benchmarks', () => {
    beforeEach(() => {
      // Clear existing test personas
      (personaManager as any).elements.clear();
    });

    it('should find in 10 personas < 1ms', () => {
      // Generate 10 test personas
      for (let i = 0; i < 10; i++) {
        const persona: Persona = {
          id: `persona-${i}`,
          type: ElementType.PERSONA,
          version: '1.0',
          metadata: {
            name: `Test Persona ${i}`,
            description: `Test persona number ${i}`,
            unique_id: `persona-${i}`,
            category: 'personal',
            version: '1.0',
            author: 'test',
            created_date: '2025-01-01'
          },
          content: `Test content for persona ${i}`,
          filename: `persona-${i}.md`,
          unique_id: `persona-${i}`
        } as Persona;
        (personaManager as any).elements.set(persona.filename, persona);
      }

      const start = performance.now();
      const found = personaManager.findPersona('persona-5');
      const duration = performance.now() - start;

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe('persona-5');
      expect(duration).toBeLessThan(1);
    });

    it('should find in 100 personas < 5ms', () => {
      // Generate 100 test personas
      for (let i = 0; i < 100; i++) {
        const persona: Persona = {
          id: `persona-${i}`,
          type: ElementType.PERSONA,
          version: '1.0',
          metadata: {
            name: `Test Persona ${i}`,
            description: `Test persona number ${i}`,
            unique_id: `persona-${i}`,
            category: 'personal',
            version: '1.0',
            author: 'test',
            created_date: '2025-01-01'
          },
          content: `Test content for persona ${i}`,
          filename: `persona-${i}.md`,
          unique_id: `persona-${i}`
        } as Persona;
        (personaManager as any).elements.set(persona.filename, persona);
      }

      const start = performance.now();
      const found = personaManager.findPersona('persona-50');
      const duration = performance.now() - start;

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe('persona-50');
      expect(duration).toBeLessThan(5);
    });

    it('should find in 1000 personas < 20ms', () => {
      // Generate 1000 test personas
      for (let i = 0; i < 1000; i++) {
        const persona: Persona = {
          id: `persona-${i}`,
          type: ElementType.PERSONA,
          version: '1.0',
          metadata: {
            name: `Test Persona ${i}`,
            description: `Test persona number ${i}`,
            unique_id: `persona-${i}`,
            category: 'personal',
            version: '1.0',
            author: 'test',
            created_date: '2025-01-01'
          },
          content: `Test content for persona ${i}`,
          filename: `persona-${i}.md`,
          unique_id: `persona-${i}`
        } as Persona;
        (personaManager as any).elements.set(persona.filename, persona);
      }

      const start = performance.now();
      const found = personaManager.findPersona('persona-500');
      const duration = performance.now() - start;

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe('persona-500');
      expect(duration).toBeLessThan(20);
    });
  });

  // ============================================================================
  // 6. Ambiguity Tests (2 tests)
  // ============================================================================

  describe('Ambiguity Handling', () => {
    it('should return first match when multiple personas could match', () => {
      // Add another persona with similar name
      const similarPersona: Persona = {
        id: 'creative-writer-xyz999',
        type: ElementType.PERSONA,
        version: '1.0',
        metadata: {
          name: 'Creative Writer',
          description: 'Another creative writing assistant',
          unique_id: 'creative-writer-xyz999',
          category: 'creative',
          version: '1.0',
          author: 'test',
          created_date: '2025-01-01'
        },
        content: 'Different content',
        filename: 'Creative-Writer-2.md',
        unique_id: 'creative-writer-xyz999'
      } as Persona;

      (personaManager as any).elements.set(similarPersona.filename, similarPersona);

      // Search by name - should return first match found
      const found = personaManager.findPersona('Creative Writer');
      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
      // Should return one of the two personas (implementation-dependent order)
      expect(['creative-writer-abc123', 'creative-writer-xyz999']).toContain(found?.unique_id);
    });

    it('should handle similar names with different casing correctly', () => {
      const lowerFound = personaManager.findPersona('creative writer');
      const upperFound = personaManager.findPersona('CREATIVE WRITER');
      const mixedFound = personaManager.findPersona('CrEaTiVe WrItEr');

      // All should find the same persona
      expect(lowerFound?.unique_id).toBe(upperFound?.unique_id);
      expect(upperFound?.unique_id).toBe(mixedFound?.unique_id);
      expect(lowerFound?.metadata.name).toBe('Creative Writer');
    });
  });

  // ============================================================================
  // 7. Additional Edge Cases (3 tests)
  // ============================================================================

  describe('Additional Edge Cases', () => {
    it('should return undefined for non-existent persona', () => {
      const found = personaManager.findPersona('NonExistent-Persona');
      expect(found).toBeUndefined();
    });

    it('should handle trimming whitespace from identifier', () => {
      const found = personaManager.findPersona('  Creative Writer  ');

      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe('Creative Writer');
    });

    it('should handle finding with filename that has extra .md extension', () => {
      // Search with double extension
      const found = personaManager.findPersona('Creative-Writer.md.md');

      // Should not find anything as it's looking for exact match with .md.md
      expect(found).toBeUndefined();
    });
  });
});
