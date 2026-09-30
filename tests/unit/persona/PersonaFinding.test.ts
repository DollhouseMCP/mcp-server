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
  // 5. Deterministic bounded scale tests
  // ============================================================================

  describe('Bounded scale lookup', () => {
    beforeEach(() => {
      // Clear existing test personas
      (personaManager as any).elements.clear();
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

      const matching = jest.spyOn(personaManager as any, 'matchesIdentifier');
      const cachedCount = (personaManager as any).getCachedElementsForCurrentNamespace().length;
      const found = personaManager.findPersona(`persona-${count / 2}`);

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe(`persona-${count / 2}`);
      expect(matching.mock.calls.length).toBeLessThanOrEqual(cachedCount);
      matching.mockClear();
      expect(personaManager.findPersona('absent-persona')).toBeUndefined();
      expect(matching.mock.calls.length).toBeLessThanOrEqual(cachedCount);
      expect(fixture.mockFileOperationsService.readFile).not.toHaveBeenCalled();
      expect(fixture.mockFileOperationsService.readElementFile).not.toHaveBeenCalled();
      expect(fixture.mockFileOperationsService.listDirectory).not.toHaveBeenCalled();
    });
  });

  it('detects a deliberately regressed repeated scan without timing measurements', () => {
    const candidates = (personaManager as any).getCachedElementsForCurrentNamespace() as Persona[];
    const cachedCount = candidates.length;
    const matching = jest.spyOn(personaManager as any, 'matchesIdentifier');
    const assertOneMissScan = (): void => {
      matching.mockClear();
      expect(personaManager.findPersona('absent-persona')).toBeUndefined();
      expect(matching.mock.calls.length).toBeLessThanOrEqual(cachedCount);
    };
    assertOneMissScan();
    const lookup = jest.spyOn(personaManager, 'findPersona');
    // A correct index/early miss is allowed to perform zero predicate calls.
    lookup.mockReturnValueOnce(undefined);
    assertOneMissScan();
    lookup.mockImplementation(identifier => {
      for (let pass = 0; pass < 2; pass++) {
        candidates.find(candidate => (personaManager as any).matchesIdentifier(candidate, identifier));
      }
      return undefined;
    });
    expect(assertOneMissScan).toThrow();
    expect(matching.mock.calls).toHaveLength(2 * cachedCount);
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
