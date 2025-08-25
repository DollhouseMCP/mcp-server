/**
 * Tests for PersonaElement class
 */

import { PersonaElement, PersonaElementMetadata } from '../../../../src/persona/PersonaElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementStatus } from '../../../../src/types/elements/index.js';

describe('PersonaElement', () => {
  describe('constructor', () => {
    it('should create a PersonaElement with default metadata', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Test Persona',
        description: 'A test persona'
      };

      const persona = new PersonaElement(metadata, 'Test content', 'sample.md');

      expect(persona.type).toBe(ElementType.PERSONA);
      expect(persona.metadata.name).toBe('Test Persona');
      expect(persona.metadata.description).toBe('A test persona');
      expect(persona.content).toBe('Test content');
      expect(persona.filename).toBe('sample.md');
      expect(persona.metadata.category).toBe('personal');
      expect(persona.metadata.age_rating).toBe('all');
      expect(persona.metadata.ai_generated).toBe(false);
      expect(persona.metadata.price).toBe('free');
    });

    it('should generate an ID based on name', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Creative Writer',
        description: 'A creative writing persona'
      };

      const persona = new PersonaElement(metadata);

      expect(persona.id).toMatch(/^personas_creative-writer_\d+$/);
    });
  });

  describe('legacy conversion', () => {
    it('should convert from legacy Persona interface', () => {
      const legacyPersona = {
        metadata: {
          name: 'Legacy Persona',
          description: 'A legacy persona',
          unique_id: 'legacy_20250720-120000_test',
          author: 'test-user',
          version: '2.1',
          triggers: ['legacy', 'test'],
          category: 'creative',
          age_rating: '13+' as const,
          content_flags: ['educational'],
          ai_generated: true,
          generation_method: 'Claude' as const,
          price: '$5.00',
          license: 'MIT'
        },
        content: 'Legacy persona content',
        filename: 'legacy.md',
        unique_id: 'legacy_20250720-120000_test'
      };

      const persona = PersonaElement.fromLegacy(legacyPersona);

      expect(persona.id).toBe('legacy_20250720-120000_test');
      expect(persona.metadata.name).toBe('Legacy Persona');
      expect(persona.metadata.description).toBe('A legacy persona');
      expect(persona.metadata.author).toBe('test-user');
      expect(persona.metadata.version).toBe('2.1');
      expect(persona.metadata.triggers).toEqual(['legacy', 'test']);
      expect(persona.metadata.category).toBe('creative');
      expect(persona.metadata.age_rating).toBe('13+');
      expect(persona.metadata.ai_generated).toBe(true);
      expect(persona.content).toBe('Legacy persona content');
      expect(persona.filename).toBe('legacy.md');
    });

    it('should convert to legacy Persona interface', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Modern Persona',
        description: 'A modern persona',
        author: 'modern-user',
        triggers: ['modern', 'new'],
        category: 'professional',
        age_rating: '18+',
        ai_generated: false
      };

      const persona = new PersonaElement(metadata, 'Modern content', 'modern.md');
      const legacy = persona.toLegacy();

      expect(legacy.metadata.name).toBe('Modern Persona');
      expect(legacy.metadata.description).toBe('A modern persona');
      expect(legacy.metadata.unique_id).toBe(persona.id);
      expect(legacy.metadata.author).toBe('modern-user');
      expect(legacy.metadata.triggers).toEqual(['modern', 'new']);
      expect(legacy.metadata.category).toBe('professional');
      expect(legacy.metadata.age_rating).toBe('18+');
      expect(legacy.metadata.ai_generated).toBe(false);
      expect(legacy.content).toBe('Modern content');
      expect(legacy.filename).toBe('modern.md');
      expect(legacy.unique_id).toBe(persona.id);
    });
  });

  describe('validation', () => {
    it('should validate a complete persona', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Valid Persona',
        description: 'A valid test persona'
      };

      const persona = new PersonaElement(metadata, 'Valid persona content');
      const result = persona.validate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect empty content', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Empty Persona',
        description: 'A persona with no content'
      };

      const persona = new PersonaElement(metadata, '');
      const result = persona.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors![0].field).toBe('content');
      expect(result.errors![0].message).toBe('Persona content cannot be empty');
      expect(result.errors![0].code).toBe('EMPTY_CONTENT');
    });

    it('should warn about long content', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Long Persona',
        description: 'A persona with very long content'
      };

      const longContent = 'x'.repeat(15000);
      const persona = new PersonaElement(metadata, longContent);
      const result = persona.validate();

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].field).toBe('content');
      expect(result.warnings![0].message).toBe('Persona content is very long, consider breaking it down');
      expect(result.warnings![0].severity).toBe('medium');
    });

    it('should warn about many triggers', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Trigger-Heavy Persona',
        description: 'A persona with many triggers',
        triggers: Array.from({ length: 15 }, (_, i) => `trigger${i}`)
      };

      const persona = new PersonaElement(metadata, 'Content with many triggers');
      const result = persona.validate();

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].field).toBe('triggers');
      expect(result.warnings![0].message).toBe('Many triggers may cause activation conflicts');
      expect(result.warnings![0].severity).toBe('medium');
    });

    it('should warn about missing adult flag for 18+ content', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Adult Persona',
        description: 'An adult-rated persona',
        age_rating: '18+',
        content_flags: ['mature'] // Missing 'adult' flag
      };

      const persona = new PersonaElement(metadata, 'Adult content');
      const result = persona.validate();

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0].field).toBe('content_flags');
      expect(result.warnings![0].message).toBe('18+ content should include "adult" in content_flags');
      expect(result.warnings![0].severity).toBe('low');
    });
  });

  describe('serialization', () => {
    it('should serialize to markdown format', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Serializable Persona',
        description: 'A persona for serialization testing',
        author: 'test-author',
        triggers: ['test', 'serialize'],
        category: 'testing',
        version: '1.5.0'
      };

      const persona = new PersonaElement(metadata, 'Serializable content');
      const serialized = persona.serialize();

      expect(serialized).toContain('---');
      // js-yaml doesn't quote strings unless necessary
      expect(serialized).toContain('name: Serializable Persona');
      expect(serialized).toContain('description: A persona for serialization testing');
      expect(serialized).toContain('author: test-author');
      // Check triggers are formatted as YAML list
      expect(serialized).toMatch(/triggers:\s*\n\s*- test\s*\n\s*- serialize/);
      expect(serialized).toContain('category: testing');
      expect(serialized).toContain('version: 1.5.0');
      expect(serialized).toContain('Serializable content');
    });

    it('should deserialize from markdown format', () => {
      const markdownContent = `---
name: "Deserializable Persona"
description: "A persona for deserialization testing"
unique_id: "deserialize_20250720-120000_test"
author: "test-author"
triggers:
  - test
  - deserialize
category: "testing"
version: "2.0.0"
age_rating: "13+"
ai_generated: true
generation_method: "Claude"
---

This is the deserializable content.`;

      const persona = new PersonaElement({});
      persona.deserialize(markdownContent);

      expect(persona.metadata.name).toBe('Deserializable Persona');
      expect(persona.metadata.description).toBe('A persona for deserialization testing');
      expect(persona.id).toBe('deserialize_20250720-120000_test');
      expect(persona.metadata.author).toBe('test-author');
      expect(persona.metadata.triggers).toEqual(['test', 'deserialize']);
      expect(persona.metadata.category).toBe('testing');
      expect(persona.metadata.version).toBe('2.0.0');
      expect(persona.metadata.age_rating).toBe('13+');
      expect(persona.metadata.ai_generated).toBe(true);
      expect(persona.metadata.generation_method).toBe('Claude');
      expect(persona.content).toBe('This is the deserializable content.');
    });

    it('should handle round-trip serialization', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Round-Trip Persona',
        description: 'A persona for round-trip testing',
        author: 'round-trip-author',
        triggers: ['round', 'trip'],
        category: 'testing',
        age_rating: '18+',
        content_flags: ['adult', 'experimental'],
        ai_generated: false,
        generation_method: 'human',
        price: 'free',
        license: 'CC-BY-SA-4.0'
      };

      const original = new PersonaElement(metadata, 'Round-trip content', 'roundtrip.md');
      const serialized = original.serialize();
      
      const restored = new PersonaElement({});
      restored.deserialize(serialized);

      expect(restored.metadata.name).toBe(original.metadata.name);
      expect(restored.metadata.description).toBe(original.metadata.description);
      expect(restored.metadata.author).toBe(original.metadata.author);
      expect(restored.metadata.triggers).toEqual(original.metadata.triggers);
      expect(restored.metadata.category).toBe(original.metadata.category);
      expect(restored.metadata.age_rating).toBe(original.metadata.age_rating);
      expect(restored.metadata.content_flags).toEqual(original.metadata.content_flags);
      expect(restored.metadata.ai_generated).toBe(original.metadata.ai_generated);
      expect(restored.metadata.generation_method).toBe(original.metadata.generation_method);
      expect(restored.content).toBe(original.content);
    });
  });

  describe('lifecycle', () => {
    it('should handle activation', async () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Activatable Persona',
        description: 'A persona that can be activated'
      };

      const persona = new PersonaElement(metadata, 'Activatable content');
      
      await persona.activate();
      expect(persona.getStatus()).toBe(ElementStatus.ACTIVE);
    });

    it('should handle deactivation', async () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Deactivatable Persona',
        description: 'A persona that can be deactivated'
      };

      const persona = new PersonaElement(metadata, 'Deactivatable content');
      
      await persona.activate();
      expect(persona.getStatus()).toBe(ElementStatus.ACTIVE);
      
      await persona.deactivate();
      expect(persona.getStatus()).toBe(ElementStatus.INACTIVE);
    });
  });

  describe('feedback processing', () => {
    it('should process feedback if method is available', () => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Feedback Persona',
        description: 'A persona that receives feedback'
      };

      const persona = new PersonaElement(metadata, 'Feedback content');
      
      // PersonaElement inherits feedback processing from BaseElement
      expect(typeof persona.receiveFeedback).toBe('function');
      
      // Test that it doesn't throw
      expect(() => {
        persona.receiveFeedback?.('This persona is excellent! 5 stars!');
      }).not.toThrow();
    });
  });
});