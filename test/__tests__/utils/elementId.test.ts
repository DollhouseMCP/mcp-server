/**
 * Tests for element ID utility functions
 */

import {
  parseElementId,
  parseElementIdStrict,
  parseElementIdWithFallback,
  formatElementId,
  isValidElementId,
  parseElementIds,
  batchParseElementIds,
  ELEMENT_ID_SEPARATOR
} from '../../../src/utils/elementId.js';

describe('Element ID Utilities', () => {
  describe('parseElementId', () => {
    it('should parse valid element ID', () => {
      const result = parseElementId('personas:creative-writer');
      expect(result).toEqual({
        type: 'personas',
        name: 'creative-writer'
      });
    });

    it('should return null for invalid formats', () => {
      expect(parseElementId('')).toBeNull();
      expect(parseElementId('invalid')).toBeNull();
      expect(parseElementId('too:many:parts')).toBeNull();
      expect(parseElementId(':missing-type')).toBeNull();
      expect(parseElementId('missing-name:')).toBeNull();
      expect(parseElementId(null as any)).toBeNull();
      expect(parseElementId(undefined as any)).toBeNull();
      expect(parseElementId(123 as any)).toBeNull();
    });

    it('should handle IDs with special characters', () => {
      const result = parseElementId('skills:code-review_v2');
      expect(result).toEqual({
        type: 'skills',
        name: 'code-review_v2'
      });
    });
  });

  describe('parseElementIdStrict', () => {
    it('should parse valid element ID', () => {
      const result = parseElementIdStrict('templates:meeting-notes');
      expect(result).toEqual({
        type: 'templates',
        name: 'meeting-notes'
      });
    });

    it('should throw error for invalid formats', () => {
      expect(() => parseElementIdStrict('')).toThrow('Invalid element ID format');
      expect(() => parseElementIdStrict('invalid')).toThrow('Invalid element ID format');
      expect(() => parseElementIdStrict('too:many:parts')).toThrow('Invalid element ID format');
    });
  });

  describe('parseElementIdWithFallback', () => {
    it('should parse valid element ID', () => {
      const result = parseElementIdWithFallback('agents:research-assistant');
      expect(result).toEqual({
        type: 'agents',
        name: 'research-assistant'
      });
    });

    it('should use fallbacks for invalid IDs', () => {
      const result = parseElementIdWithFallback('invalid-id');
      expect(result).toEqual({
        type: 'unknown',
        name: 'invalid-id'
      });
    });

    it('should use custom fallbacks', () => {
      const result = parseElementIdWithFallback('bad-format', 'custom-type', 'custom-name');
      expect(result).toEqual({
        type: 'custom-type',
        name: 'custom-name'
      });
    });
  });

  describe('formatElementId', () => {
    it('should format element ID correctly', () => {
      expect(formatElementId('personas', 'creative-writer')).toBe('personas:creative-writer');
      expect(formatElementId('memories', 'session-2025-09-24')).toBe('memories:session-2025-09-24');
    });

    it('should throw error for invalid inputs', () => {
      expect(() => formatElementId('', 'name')).toThrow('Both type and name are required');
      expect(() => formatElementId('type', '')).toThrow('Both type and name are required');
      expect(() => formatElementId(null as any, 'name')).toThrow('Both type and name are required');
    });

    it('should throw error if type or name contains separator', () => {
      expect(() => formatElementId('type:with:colon', 'name')).toThrow('cannot contain separator');
      expect(() => formatElementId('type', 'name:with:colon')).toThrow('cannot contain separator');
    });
  });

  describe('isValidElementId', () => {
    it('should validate element IDs correctly', () => {
      expect(isValidElementId('personas:creative-writer')).toBe(true);
      expect(isValidElementId('skills:code-review')).toBe(true);
      expect(isValidElementId('')).toBe(false);
      expect(isValidElementId('invalid')).toBe(false);
      expect(isValidElementId('too:many:parts')).toBe(false);
    });
  });

  describe('parseElementIds', () => {
    it('should parse multiple element IDs', () => {
      const ids = [
        'personas:writer',
        'skills:debugger',
        'invalid-id',
        'templates:report',
        ''
      ];

      const result = parseElementIds(ids);
      expect(result).toEqual([
        { type: 'personas', name: 'writer' },
        { type: 'skills', name: 'debugger' },
        { type: 'templates', name: 'report' }
      ]);
    });

    it('should handle empty array', () => {
      expect(parseElementIds([])).toEqual([]);
    });
  });

  describe('batchParseElementIds', () => {
    it('should batch parse with detailed error reporting', () => {
      const ids = [
        'personas:writer',
        '',
        'invalid',
        'skills:debugger',
        ':missing-type',
        'missing-name:',
        'too:many:parts',
        'templates:report'
      ];

      const result = batchParseElementIds(ids);

      expect(result.valid).toEqual([
        { type: 'personas', name: 'writer', originalId: 'personas:writer' },
        { type: 'skills', name: 'debugger', originalId: 'skills:debugger' },
        { type: 'templates', name: 'report', originalId: 'templates:report' }
      ]);

      expect(result.invalid).toEqual([
        { id: '', reason: 'Empty ID' },
        { id: 'invalid', reason: 'Missing separator ":"' },
        { id: ':missing-type', reason: 'Missing type' },
        { id: 'missing-name:', reason: 'Missing name' },
        { id: 'too:many:parts', reason: 'Multiple separators found' }
      ]);
    });
  });

  describe('ELEMENT_ID_SEPARATOR', () => {
    it('should export the separator constant', () => {
      expect(ELEMENT_ID_SEPARATOR).toBe(':');
    });
  });
});