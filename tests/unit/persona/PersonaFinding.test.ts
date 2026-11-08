/**
 * PersonaFinding - Multi-Strategy Search Tests
 *
 * Tests PersonaManager's multi-strategy finding capabilities:
 * 1. Exact match strategies (filename, name, unique_id)
 * 2. Case-insensitive matching
 * 3. Strategy priority and fallback order
 * 4. Edge cases (special chars, Unicode, emoji)
 * 5. Deterministic single-scan work bounds at 10/100/1000 personas
 *
 * Phase 3.3: Day 2/3 of test coverage expansion
 * Target: 150-200 lines with performance testing
 * Priority: HIGH (Multi-strategy finding has 40% coverage)
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { Persona } from '../../../src/types/persona.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { createPersonaFindingFixture } from '../../helpers/persona-finding-fixture.js';

describe('PersonaFinding - Multi-Strategy Search', () => {
  let personaManager: PersonaManager;
  let fixture: ReturnType<typeof createPersonaFindingFixture>;
  const seedPersona = (persona: Persona): void => fixture.seedPersona(persona);
  beforeEach(() => {
    jest.clearAllMocks();
    fixture = createPersonaFindingFixture();
    personaManager = fixture.personaManager;
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

    it('does not find a persona by its unique_id: a generated id is not a name', () => {
      expect(personaManager.findPersona('creative-writer-abc123')).toBeUndefined();
    });

    it('still finds a persona whose unique_id is also its filename stem, through the shared rule', () => {
      seedPersona({ id: 'stem-persona', type: ElementType.PERSONA, version: '1.0', unique_id: 'stem-persona', filename: 'stem-persona.md',
        content: 'Test content', metadata: { name: 'Stem Persona', description: 'Stem fixture', unique_id: 'stem-persona',
          category: 'personal', version: '1.0', author: 'test', created_date: '2025-01-01' } } as Persona);
      expect(personaManager.findPersona('stem-persona')?.filename).toBe('stem-persona.md');
      expect(personaManager.findPersona('stem-persona.md')?.filename).toBe('stem-persona.md');
    });
  });

  // ============================================================================
  // 2. Case-Insensitive Tests (3 tests)
  // ============================================================================

  describe('Case-Insensitive Matching', () => {
    it.each(['creative writer', 'CREATIVE WRITER', 'CrEaTiVe WrItEr'])('finds persona by case-insensitive name %s', identifier => {
      const found = personaManager.findPersona(identifier);
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

      seedPersona(ambiguousPersona);

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

    it('does not fall back to a unique_id match when filename and name do not match', () => {
      expect(personaManager.findPersona('test-special-chars-def456')).toBeUndefined();
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

    it.each(['Test & Test', 'Tëst Përsoñä', 'Test 😀 Persona'])('finds persona with non-ASCII or special name %s', name => {
      const found = personaManager.findPersona(name);
      expect(found).toBeDefined();
      expect(found?.metadata.name).toBe(name);
    });
  });

  // ============================================================================
  // 5. Deterministic bounded scale tests
  // ============================================================================

  describe('Bounded scale lookup', () => {
    beforeEach(() => {
      // Clear existing test personas
      personaManager.clearCache();
    });

    it.each([10, 100, 1000])('finds the exact persona among %i cached personas within one scan', count => {
      // Preserve the same workload at each scale.
      for (let i = 0; i < count; i++) {
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
        seedPersona(persona);
      }

      // An exact storage reference is one cache lookup; any other text is one pass of the shared selector.
      const passes = jest.spyOn(personaManager as any, 'getCachedElementsForCurrentNamespace');
      const found = personaManager.findPersona(`persona-${count / 2}.md`);

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe(`persona-${count / 2}`);
      expect(passes).not.toHaveBeenCalled();
      passes.mockClear();
      expect(personaManager.findPersona('absent-persona')).toBeUndefined();
      expect(passes).toHaveBeenCalledTimes(1);
      expect(fixture.mockFileOperationsService.readFile).not.toHaveBeenCalled();
      expect(fixture.mockFileOperationsService.readElementFile).not.toHaveBeenCalled();
      expect(fixture.mockFileOperationsService.listDirectory).not.toHaveBeenCalled();
    });
  });

  it('detects a deliberately regressed repeated scan without timing measurements', () => {
    const passes = jest.spyOn(personaManager as any, 'getCachedElementsForCurrentNamespace');
    const assertOneMissScan = (): void => {
      passes.mockClear();
      expect(personaManager.findPersona('absent-persona')).toBeUndefined();
      expect(passes).toHaveBeenCalledTimes(1);
    };
    assertOneMissScan();
    // A lookup that scanned the cache twice is caught by the same one-pass assertion.
    const lookup = jest.spyOn(personaManager, 'findPersona');
    lookup.mockImplementation(() => {
      for (let pass = 0; pass < 2; pass++) (personaManager as any).getCachedElementsForCurrentNamespace();
      return undefined;
    });
    expect(assertOneMissScan).toThrow();
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

      seedPersona(similarPersona);

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
