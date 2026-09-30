import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createPersonaFindingFixture } from '../helpers/persona-finding-fixture.js';
import { ElementType } from '../../src/portfolio/types.js';
import type { Persona } from '../../src/types/persona.js';

describe('Persona lookup absolute benchmarks', () => {
  let fixture: ReturnType<typeof createPersonaFindingFixture>;
  let personaManager: ReturnType<typeof createPersonaFindingFixture>['personaManager'];
  let seedPersona: ReturnType<typeof createPersonaFindingFixture>['seedPersona'];
  beforeEach(() => {
    fixture = createPersonaFindingFixture();
    ({ personaManager, seedPersona } = fixture);
  });
  afterEach(() => jest.restoreAllMocks());
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
        seedPersona(persona);
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
        seedPersona(persona);
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
        seedPersona(persona);
      }

      const start = performance.now();
      const found = personaManager.findPersona('persona-500');
      const duration = performance.now() - start;

      expect(found).toBeDefined();
      expect(found?.unique_id).toBe('persona-500');
      expect(duration).toBeLessThan(20);
    });
  });

});
