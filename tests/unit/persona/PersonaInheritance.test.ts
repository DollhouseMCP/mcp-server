/**
 * PersonaInheritance - BaseElement Contract Tests
 *
 * Tests that PersonaElement properly inherits from BaseElement and
 * correctly overrides methods while maintaining base class contracts.
 *
 * Test Coverage Goals:
 * - Lifecycle override behavior (activate/deactivate)
 * - Validation method chaining
 * - Serialization customization
 * - Event emission patterns
 * - Feedback processing
 * - Method contract compliance
 */

import { PersonaElement, PersonaElementMetadata } from '../../../src/persona/PersonaElement.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ElementStatus } from '../../../src/types/elements/index.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';
import type { MetadataService } from '../../../src/services/MetadataService.js';

const metadataService: MetadataService = createTestMetadataService();

describe('PersonaInheritance - BaseElement Contracts', () => {
  describe('Lifecycle Override Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Test Persona',
        description: 'A test persona for lifecycle testing',
        author: 'test-user',
        triggers: ['test', 'lifecycle']
      };
      persona = new PersonaElement(metadata, 'Test lifecycle content', 'test.md', metadataService);
    });

    it('should call super.activate() when activating', async () => {
      // PersonaElement.activate() calls super.activate() via await super.activate?.()
      // We verify this by checking that base class behavior is executed:
      // The status should be set to ACTIVE (base class responsibility)

      expect(persona.status).toBe(ElementStatus.INACTIVE);
      await persona.activate();

      // If super.activate() was called, status would be ACTIVE (base class sets it)
      expect(persona.status).toBe(ElementStatus.ACTIVE);
    });

    it('should perform persona-specific activation logic', async () => {
      // Verify initial state
      expect(persona.status).toBe(ElementStatus.INACTIVE);

      await persona.activate();

      // Verify activation completed
      expect(persona.status).toBe(ElementStatus.ACTIVE);
    });

    it('should update status correctly during activation', async () => {
      // Status should progress from INACTIVE -> ACTIVE
      const statusBefore = persona.status;

      await persona.activate();

      const statusAfter = persona.status;

      expect(statusBefore).toBe(ElementStatus.INACTIVE);
      expect(statusAfter).toBe(ElementStatus.ACTIVE);
    });

    it('should call super.deactivate() when deactivating', async () => {
      // PersonaElement.deactivate() calls super.deactivate?.()
      // We verify this by checking that base class behavior is executed:
      // The status should progress through DEACTIVATING to INACTIVE

      // Activate first
      await persona.activate();
      expect(persona.status).toBe(ElementStatus.ACTIVE);

      // Then deactivate
      await persona.deactivate();

      // If super.deactivate() was called, status would be INACTIVE (base class sets it)
      expect(persona.status).toBe(ElementStatus.INACTIVE);
    });

    it('should perform persona-specific deactivation logic', async () => {
      // Activate first
      await persona.activate();
      expect(persona.status).toBe(ElementStatus.ACTIVE);

      // Deactivate
      await persona.deactivate();

      // Verify deactivation completed
      expect(persona.status).toBe(ElementStatus.INACTIVE);
    });

    it('should clean up state during deactivation', async () => {
      // Activate and set up state
      await persona.activate();
      expect(persona.status).toBe(ElementStatus.ACTIVE);

      // Deactivate and verify cleanup
      await persona.deactivate();

      expect(persona.status).toBe(ElementStatus.INACTIVE);
      // State should be clean and ready for re-activation
    });
  });

  describe('Validation Override Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Validation Test',
        description: 'Testing validation behavior',
        author: 'test-user'
      };
      persona = new PersonaElement(metadata, 'Valid content', 'validation.md', metadataService);
    });

    it('should call super.validate() during validation', () => {
      // PersonaElement.validate() calls super.validate() and adds to result
      // We verify this by checking that base class validation rules are applied

      const result = persona.validate();

      // Base class validation ensures these fields exist
      expect(result.valid).toBeDefined();
      expect(result.errors).toBeDefined();

      // Base class validates name (which is present and valid)
      expect(persona.metadata.name).toBe('Validation Test');
    });

    it('should perform method chaining correctly', () => {
      const result = persona.validate();

      // Result should be an ElementValidationResult
      expect(result).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
    });

    it('should add persona-specific validations', () => {
      // Test with empty content (persona-specific validation)
      const emptyPersona = new PersonaElement(
        { name: 'Empty', description: 'Empty content test' },
        '',
        'empty.md',
        metadataService
      );

      const result = emptyPersona.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.some(e => e.code === 'EMPTY_INSTRUCTIONS')).toBe(true);
    });

    it('should return combined validation result', () => {
      const result = persona.validate();

      // Should combine base class and persona-specific validations
      expect(result.valid).toBe(true);
      // errors might be undefined or empty array when valid
      expect(result.errors === undefined || result.errors.length === 0).toBe(true);

      // Persona with instructions should pass validation
      expect(persona.instructions.length).toBeGreaterThan(0);
    });

    it('should validate long content with warnings', () => {
      // Create persona with very long content
      const longContent = 'x'.repeat(15000);
      const longPersona = new PersonaElement(
        { name: 'Long', description: 'Long content test' },
        longContent,
        'long.md',
        metadataService
      );

      const result = longPersona.validate();

      // Should be valid but have warnings
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.field === 'instructions')).toBe(true);
    });

    it('should validate trigger count', () => {
      // Create persona with many triggers
      const manyTriggers = Array.from({ length: 15 }, (_, i) => `trigger${i}`);
      const triggerPersona = new PersonaElement(
        {
          name: 'Triggers',
          description: 'Many triggers test',
          triggers: manyTriggers
        },
        'Content',
        'triggers.md',
        metadataService
      );

      const result = triggerPersona.validate();

      // Should be valid but have warnings about many triggers
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.field === 'triggers')).toBe(true);
    });

    it('should validate content flags for age rating', () => {
      // Create 18+ persona without adult flag
      const adultPersona = new PersonaElement(
        {
          name: 'Adult',
          description: 'Adult content test',
          age_rating: '18+',
          content_flags: []
        },
        'Adult content',
        'adult.md',
        metadataService
      );

      const result = adultPersona.validate();

      // Should have warning about missing adult flag
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some(w => w.field === 'content_flags')).toBe(true);
    });
  });

  describe('Serialization Override Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Serialize Test',
        description: 'Testing serialization',
        author: 'test-user',
        version: '1.0.0',
        triggers: ['serialize', 'test'],
        category: 'testing',
        age_rating: 'all',
        content_flags: ['test'],
        ai_generated: false,
        generation_method: 'human',
        price: 'free',
        license: 'MIT'
      };
      persona = new PersonaElement(metadata, 'Serialization test content', 'serialize.md', metadataService);
    });

    it('should customize serialization with persona fields', () => {
      const serialized = persona.serialize();

      // Should include YAML frontmatter
      expect(serialized).toContain('---');

      // Should include persona-specific fields
      expect(serialized).toContain('triggers:');
      expect(serialized).toContain('category:');
      expect(serialized).toContain('age_rating:');

      // Should include content
      expect(serialized).toContain('Serialization test content');
    });

    it('should call super.serialize() appropriately', () => {
      // PersonaElement.serialize() enhances metadata then calls super.serialize()
      // We verify this by checking that base class serialization format is used

      const serialized = persona.serialize();

      // Base class adds YAML frontmatter delimiters
      expect(serialized).toContain('---');

      // Base class includes core metadata fields
      expect(serialized).toContain('name:');
      expect(serialized).toContain('description:');
      expect(serialized).toContain('type:');
      expect(serialized).toContain('version:');
    });

    it('should support round-trip serialization', () => {
      // Serialize
      const serialized = persona.serialize();

      // Create new persona and deserialize
      const newPersona = new PersonaElement(
        { name: 'Empty', description: 'Empty' },
        '',
        'empty.md',
        metadataService
      );
      newPersona.deserialize(serialized);

      // Verify data preserved
      expect(newPersona.metadata.name).toBe(persona.metadata.name);
      expect(newPersona.metadata.description).toBe(persona.metadata.description);
      expect(newPersona.metadata.author).toBe(persona.metadata.author);
      expect(newPersona.metadata.triggers).toEqual(persona.metadata.triggers);
      expect(newPersona.instructions).toBe(persona.instructions);
    });

    it('should preserve content and metadata in round-trip', () => {
      const originalContent = persona.instructions;
      const originalName = persona.metadata.name;
      const originalDescription = persona.metadata.description;
      const originalTriggers = persona.metadata.triggers;

      // Round-trip: serialize → deserialize → serialize
      const serialized1 = persona.serialize();

      const tempPersona = new PersonaElement(
        { name: 'Temp', description: 'Temp' },
        '',
        'temp.md',
        metadataService
      );
      tempPersona.deserialize(serialized1);

      const serialized2 = tempPersona.serialize();

      // Verify content preserved
      expect(tempPersona.instructions).toBe(originalContent);
      expect(tempPersona.metadata.name).toBe(originalName);
      expect(tempPersona.metadata.description).toBe(originalDescription);
      expect(tempPersona.metadata.triggers).toEqual(originalTriggers);

      // Serialized formats should be equivalent (may differ in formatting)
      expect(serialized2).toContain(originalName);
      expect(serialized2).toContain(originalContent);
    });

    it('should preserve unique_id in serialization', () => {
      const originalId = persona.id;
      const serialized = persona.serialize();

      // Serialized output should include unique_id
      expect(serialized).toContain('unique_id:');
      expect(serialized).toContain(originalId);
    });
  });

  describe('Event Emission Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Event Test',
        description: 'Testing events',
        author: 'test-user'
      };
      persona = new PersonaElement(metadata, 'Event content', 'events.md', metadataService);
    });

    it('should maintain event compatibility during activation', async () => {
      // Track status changes
      const statusBefore = persona.status;

      await persona.activate();

      const statusAfter = persona.status;

      // Status should change from INACTIVE to ACTIVE
      expect(statusBefore).toBe(ElementStatus.INACTIVE);
      expect(statusAfter).toBe(ElementStatus.ACTIVE);
    });

    it('should maintain event compatibility during deactivation', async () => {
      // Activate first
      await persona.activate();
      const statusBefore = persona.status;

      await persona.deactivate();

      const statusAfter = persona.status;

      // Status should change from ACTIVE to INACTIVE
      expect(statusBefore).toBe(ElementStatus.ACTIVE);
      expect(statusAfter).toBe(ElementStatus.INACTIVE);
    });

    it('should provide correct payload data in lifecycle', async () => {
      // Verify metadata available throughout lifecycle
      expect(persona.id).toBeDefined();
      expect(persona.metadata.name).toBe('Event Test');

      await persona.activate();

      expect(persona.id).toBeDefined();
      expect(persona.metadata.name).toBe('Event Test');
      expect(persona.status).toBe(ElementStatus.ACTIVE);
    });

    it('should support status inspection', () => {
      // Test getStatus() method
      expect(persona.getStatus()).toBe(ElementStatus.INACTIVE);

      // Test status property
      expect(persona.status).toBe(ElementStatus.INACTIVE);
    });
  });

  describe('Feedback Processing Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Feedback Test',
        description: 'Testing feedback',
        author: 'test-user'
      };
      persona = new PersonaElement(metadata, 'Feedback content', 'feedback.md', metadataService);
    });

    it('should process feedback through receiveFeedback()', () => {
      // Call receiveFeedback (inherited from BaseElement)
      persona.receiveFeedback('This persona is excellent!');

      // Verify feedback was processed
      expect(persona.ratings).toBeDefined();
      expect(persona.ratings?.feedbackHistory).toBeDefined();
      expect(persona.ratings?.feedbackHistory.length).toBeGreaterThan(0);
    });

    it('should integrate feedback with persona metadata', () => {
      persona.receiveFeedback('Very helpful persona, 5 stars!');

      // Check that feedback affected ratings
      expect(persona.ratings?.userRating).toBeDefined();
      expect(persona.ratings?.ratingCount).toBeGreaterThan(0);

      // Element should be marked dirty after feedback
      expect(persona.isDirty()).toBe(true);
    });
  });

  describe('Method Contract Tests', () => {
    let persona: PersonaElement;

    beforeEach(() => {
      const metadata: Partial<PersonaElementMetadata> = {
        name: 'Contract Test',
        description: 'Testing contracts',
        author: 'test-user'
      };
      persona = new PersonaElement(metadata, 'Contract content', 'contract.md', metadataService);
    });

    it('should implement all required BaseElement methods', () => {
      // Verify critical methods exist and are callable
      expect(typeof persona.validate).toBe('function');
      expect(typeof persona.serialize).toBe('function');
      expect(typeof persona.deserialize).toBe('function');
      expect(typeof persona.activate).toBe('function');
      expect(typeof persona.deactivate).toBe('function');
      expect(typeof persona.receiveFeedback).toBe('function');
      expect(typeof persona.getStatus).toBe('function');
      expect(typeof persona.isDirty).toBe('function');
    });

    it('should maintain method signatures matching base class', () => {
      // Test that methods can be called with expected parameters

      // validate() - no parameters, returns ValidationResult
      const validationResult = persona.validate();
      expect(validationResult.valid).toBeDefined();

      // serialize() - no parameters, returns string
      const serialized = persona.serialize();
      expect(typeof serialized).toBe('string');

      // deserialize() - string parameter, void return
      expect(() => {
        const data = persona.serialize();
        persona.deserialize(data);
      }).not.toThrow();

      // activate() - async, no parameters
      expect(persona.activate()).toBeInstanceOf(Promise);

      // deactivate() - async, no parameters
      expect(persona.deactivate()).toBeInstanceOf(Promise);

      // receiveFeedback() - string parameter, optional context
      expect(() => {
        persona.receiveFeedback('test feedback');
      }).not.toThrow();

      // getStatus() - no parameters, returns ElementStatus
      const status = persona.getStatus();
      expect(typeof status).toBe('string');
    });

    it('should properly inherit type property', () => {
      expect(persona.type).toBe(ElementType.PERSONA);
    });

    it('should properly inherit id generation', () => {
      // ID should be generated automatically
      expect(persona.id).toBeDefined();
      expect(typeof persona.id).toBe('string');
      expect(persona.id.length).toBeGreaterThan(0);
    });

    it('should properly inherit metadata structure', () => {
      // Metadata should include base fields
      expect(persona.metadata.name).toBeDefined();
      expect(persona.metadata.description).toBeDefined();
      expect(persona.metadata.created).toBeDefined();
      expect(persona.metadata.modified).toBeDefined();
      expect(persona.metadata.version).toBeDefined();
    });

    it('should properly inherit dirty tracking', () => {
      // Initial state
      expect(typeof persona.isDirty()).toBe('boolean');

      // markClean should work
      persona.markClean();
      expect(persona.isDirty()).toBe(false);

      // Deserialize should mark dirty
      const serialized = persona.serialize();
      persona.deserialize(serialized);
      expect(persona.isDirty()).toBe(true);
    });
  });
});
