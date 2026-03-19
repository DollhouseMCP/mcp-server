/**
 * FieldFilter Unit Tests
 *
 * Tests for GraphQL-style field selection and name transformation.
 *
 * @see Issue #202 - Implement GraphQL field selection for response token optimization
 */

import {
  filterFields,
  isValidPreset,
  getPresetFields,
  FIELD_TRANSFORMS,
  FIELD_ALIASES,
  FIELD_PRESETS,
} from '../../../src/utils/FieldFilter.js';

describe('FieldFilter', () => {
  describe('Constants', () => {
    describe('FIELD_TRANSFORMS', () => {
      it('should have name → element_name transform', () => {
        expect(FIELD_TRANSFORMS.name).toBe('element_name');
      });
    });

    describe('FIELD_ALIASES', () => {
      it('should have element_name → [name, metadata.name] alias', () => {
        expect(FIELD_ALIASES.element_name).toEqual(['name', 'metadata.name']);
      });

      it('should have description → [description, metadata.description] alias', () => {
        expect(FIELD_ALIASES.description).toEqual(['description', 'metadata.description']);
      });
    });

    describe('FIELD_PRESETS', () => {
      it('should have minimal preset with element_name and description', () => {
        expect(FIELD_PRESETS.minimal).toEqual(['element_name', 'description']);
      });

      it('should have standard preset with additional fields', () => {
        expect(FIELD_PRESETS.standard).toEqual([
          'element_name',
          'description',
          'metadata.tags',
          'metadata.triggers',
        ]);
      });

      it('should have full preset as null (return all fields)', () => {
        expect(FIELD_PRESETS.full).toBeNull();
      });
    });
  });

  describe('filterFields()', () => {
    describe('Name transformation', () => {
      it('should transform name to element_name by default', () => {
        const input = { name: 'test', description: 'desc' };
        const { data } = filterFields(input);

        expect(data).toEqual({ element_name: 'test', description: 'desc' });
      });

      it('should transform nested objects', () => {
        const input = {
          name: 'outer',
          nested: {
            name: 'inner',
            value: 123,
          },
        };
        const { data } = filterFields(input);

        expect(data).toEqual({
          element_name: 'outer',
          nested: {
            element_name: 'inner',
            value: 123,
          },
        });
      });

      it('should transform arrays of objects', () => {
        const input = [
          { name: 'first', description: 'desc1' },
          { name: 'second', description: 'desc2' },
        ];
        const { data } = filterFields(input);

        expect(data).toEqual([
          { element_name: 'first', description: 'desc1' },
          { element_name: 'second', description: 'desc2' },
        ]);
      });

      it('should not transform when transformNames is false', () => {
        const input = { name: 'test', description: 'desc' };
        const { data, transformed } = filterFields(input, { transformNames: false });

        expect(data).toEqual({ name: 'test', description: 'desc' });
        expect(transformed).toBe(false);
      });
    });

    describe('Field selection with specific fields', () => {
      it('should filter to requested fields only', () => {
        const input = {
          name: 'test',
          description: 'desc',
          content: 'long content here',
          metadata: { tags: ['tag1'] },
        };
        const { data } = filterFields(input, {
          fields: ['element_name', 'description'],
        });

        expect(data).toEqual({
          element_name: 'test',
          description: 'desc',
        });
      });

      it('should handle alias resolution (element_name → name lookup)', () => {
        const input = { name: 'test', description: 'desc' };
        const { data } = filterFields(input, {
          fields: ['element_name'], // Request element_name, which maps to internal 'name'
        });

        expect(data).toEqual({ element_name: 'test' });
      });

      it('should handle nested field selection', () => {
        const input = {
          name: 'test',
          metadata: {
            tags: ['tag1', 'tag2'],
            author: 'someone',
            triggers: ['trigger1'],
          },
        };
        const { data } = filterFields(input, {
          fields: ['element_name', 'metadata.tags'],
        });

        expect(data).toEqual({
          element_name: 'test',
          metadata: {
            tags: ['tag1', 'tag2'],
          },
        });
      });

      it('should filter arrays with field selection', () => {
        const input = [
          { name: 'first', description: 'desc1', content: 'content1' },
          { name: 'second', description: 'desc2', content: 'content2' },
        ];
        const { data } = filterFields(input, {
          fields: ['element_name', 'description'],
        });

        expect(data).toEqual([
          { element_name: 'first', description: 'desc1' },
          { element_name: 'second', description: 'desc2' },
        ]);
      });

      it('should ignore fields that do not exist', () => {
        const input = { name: 'test', description: 'desc' };
        const { data } = filterFields(input, {
          fields: ['element_name', 'nonexistent'],
        });

        expect(data).toEqual({ element_name: 'test' });
      });
    });

    describe('Preset field sets', () => {
      it('should apply minimal preset', () => {
        const input = {
          name: 'test',
          description: 'desc',
          content: 'content',
          metadata: { tags: ['tag1'] },
        };
        const { data } = filterFields(input, { preset: 'minimal' });

        expect(data).toEqual({
          element_name: 'test',
          description: 'desc',
        });
      });

      it('should apply standard preset', () => {
        const input = {
          name: 'test',
          description: 'desc',
          content: 'content',
          metadata: {
            tags: ['tag1'],
            triggers: ['trigger1'],
            author: 'someone',
          },
        };
        const { data } = filterFields(input, { preset: 'standard' });

        expect(data).toEqual({
          element_name: 'test',
          description: 'desc',
          metadata: {
            tags: ['tag1'],
            triggers: ['trigger1'],
          },
        });
      });

      it('should return all fields with full preset (transform only)', () => {
        const input = {
          name: 'test',
          description: 'desc',
          content: 'content',
        };
        const { data } = filterFields(input, { preset: 'full' });

        expect(data).toEqual({
          element_name: 'test',
          description: 'desc',
          content: 'content',
        });
      });
    });

    describe('Edge cases', () => {
      it('should handle null input', () => {
        const { data, transformed } = filterFields(null);
        expect(data).toBeNull();
        expect(transformed).toBe(false);
      });

      it('should handle undefined input', () => {
        const { data, transformed } = filterFields(undefined);
        expect(data).toBeUndefined();
        expect(transformed).toBe(false);
      });

      it('should pass through primitives unchanged', () => {
        expect(filterFields(42).data).toBe(42);
        expect(filterFields('string').data).toBe('string');
        expect(filterFields(true).data).toBe(true);
      });

      it('should handle empty object', () => {
        const { data } = filterFields({});
        expect(data).toEqual({});
      });

      it('should handle empty array', () => {
        const { data } = filterFields([]);
        expect(data).toEqual([]);
      });

      it('should handle array with primitives', () => {
        const { data } = filterFields([1, 2, 'three']);
        expect(data).toEqual([1, 2, 'three']);
      });

      it('should handle empty fields array (no filtering)', () => {
        const input = { name: 'test', description: 'desc' };
        const { data } = filterFields(input, { fields: [] });

        // Empty fields array means no filtering, just transform
        expect(data).toEqual({ element_name: 'test', description: 'desc' });
      });

      it('should prefer fields over preset if both provided', () => {
        const input = {
          name: 'test',
          description: 'desc',
          content: 'content',
        };
        const { data } = filterFields(input, {
          preset: 'minimal', // Would include element_name, description
          fields: ['element_name'], // Should take precedence
        });

        // fields takes precedence over preset
        expect(data).toEqual({ element_name: 'test' });
      });
    });

    describe('Result metadata', () => {
      it('should indicate when transformation was applied', () => {
        const { transformed } = filterFields({ name: 'test' });
        expect(transformed).toBe(true);
      });

      it('should indicate when transformation was not applied', () => {
        const { transformed } = filterFields({ name: 'test' }, { transformNames: false });
        expect(transformed).toBe(false);
      });
    });
  });

  describe('isValidPreset()', () => {
    it('should return true for valid presets', () => {
      expect(isValidPreset('minimal')).toBe(true);
      expect(isValidPreset('standard')).toBe(true);
      expect(isValidPreset('full')).toBe(true);
    });

    it('should return false for invalid presets', () => {
      expect(isValidPreset('invalid')).toBe(false);
      expect(isValidPreset('')).toBe(false);
      expect(isValidPreset('MINIMAL')).toBe(false);
    });
  });

  describe('getPresetFields()', () => {
    it('should return fields for minimal preset', () => {
      expect(getPresetFields('minimal')).toEqual(['element_name', 'description']);
    });

    it('should return fields for standard preset', () => {
      expect(getPresetFields('standard')).toEqual([
        'element_name',
        'description',
        'metadata.tags',
        'metadata.triggers',
      ]);
    });

    it('should return null for full preset', () => {
      expect(getPresetFields('full')).toBeNull();
    });
  });

  describe('IElement-shaped objects', () => {
    const iElementObj = {
      id: 'test-1',
      type: 'personas',
      version: '1.0.0',
      metadata: {
        name: 'Test Persona',
        description: 'A test persona for unit tests',
        tags: ['test', 'mock'],
        author: 'test-author',
      },
      content: 'Some content here',
    };

    it('should resolve element_name from metadata.name on IElement objects', () => {
      const { data } = filterFields(iElementObj, { fields: ['element_name'] });
      expect(data).toEqual({ element_name: 'Test Persona' });
    });

    it('should resolve description from metadata.description on IElement objects', () => {
      const { data } = filterFields(iElementObj, { fields: ['description'] });
      expect(data).toEqual({ description: 'A test persona for unit tests' });
    });

    it('should resolve both element_name and description from IElement objects', () => {
      const { data } = filterFields(iElementObj, { fields: ['element_name', 'description'] });
      expect(data).toEqual({
        element_name: 'Test Persona',
        description: 'A test persona for unit tests',
      });
    });

    it('should apply minimal preset on IElement objects', () => {
      const { data } = filterFields(iElementObj, { preset: 'minimal' });
      expect(data).toEqual({
        element_name: 'Test Persona',
        description: 'A test persona for unit tests',
      });
    });

    it('should apply standard preset on IElement objects', () => {
      const { data } = filterFields(iElementObj, { preset: 'standard' });
      expect(data).toEqual({
        element_name: 'Test Persona',
        description: 'A test persona for unit tests',
        metadata: {
          tags: ['test', 'mock'],
        },
      });
    });

    it('should still resolve element_name from flat objects (backward compat)', () => {
      const flatObj = { name: 'Flat Name', description: 'Flat desc' };
      const { data } = filterFields(flatObj, { fields: ['element_name', 'description'] });
      expect(data).toEqual({
        element_name: 'Flat Name',
        description: 'Flat desc',
      });
    });

    it('should resolve fields from arrays of IElement objects', () => {
      const arr = [iElementObj, { ...iElementObj, metadata: { ...iElementObj.metadata, name: 'Second' } }];
      const { data } = filterFields(arr, { preset: 'minimal' });
      expect(data).toEqual([
        { element_name: 'Test Persona', description: 'A test persona for unit tests' },
        { element_name: 'Second', description: 'A test persona for unit tests' },
      ]);
    });
  });
});
