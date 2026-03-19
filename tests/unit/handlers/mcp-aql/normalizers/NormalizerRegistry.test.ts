/**
 * NormalizerRegistry Tests
 *
 * @see Issue #243 - Unified search with normalizer architecture
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { NormalizerRegistry } from '../../../../../src/handlers/mcp-aql/normalizers/NormalizerRegistry.js';
import type { Normalizer, NormalizerContext } from '../../../../../src/handlers/mcp-aql/normalizers/types.js';

describe('NormalizerRegistry', () => {
  // Create a mock normalizer for testing
  const createMockNormalizer = (name: string): Normalizer => ({
    name,
    normalize: jest.fn().mockReturnValue({ success: true, params: {} }),
  });

  const mockContext: NormalizerContext = {
    operation: 'test',
    endpoint: 'READ',
    handler: 'testHandler',
    method: 'testMethod',
  };

  beforeEach(() => {
    // Clear registry before each test
    NormalizerRegistry.clear();
  });

  describe('register()', () => {
    it('should register a normalizer', () => {
      const normalizer = createMockNormalizer('test');

      NormalizerRegistry.register(normalizer);

      expect(NormalizerRegistry.has('test')).toBe(true);
      expect(NormalizerRegistry.size).toBe(1);
    });

    it('should throw if normalizer with same name is already registered', () => {
      const normalizer1 = createMockNormalizer('test');
      const normalizer2 = createMockNormalizer('test');

      NormalizerRegistry.register(normalizer1);

      expect(() => NormalizerRegistry.register(normalizer2)).toThrow(
        "Normalizer 'test' is already registered"
      );
    });

    it('should allow registering multiple normalizers with different names', () => {
      const normalizer1 = createMockNormalizer('test1');
      const normalizer2 = createMockNormalizer('test2');

      NormalizerRegistry.register(normalizer1);
      NormalizerRegistry.register(normalizer2);

      expect(NormalizerRegistry.size).toBe(2);
      expect(NormalizerRegistry.has('test1')).toBe(true);
      expect(NormalizerRegistry.has('test2')).toBe(true);
    });
  });

  describe('unregister()', () => {
    it('should unregister a normalizer by name', () => {
      const normalizer = createMockNormalizer('test');
      NormalizerRegistry.register(normalizer);

      const result = NormalizerRegistry.unregister('test');

      expect(result).toBe(true);
      expect(NormalizerRegistry.has('test')).toBe(false);
    });

    it('should return false when unregistering non-existent normalizer', () => {
      const result = NormalizerRegistry.unregister('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('get()', () => {
    it('should return registered normalizer', () => {
      const normalizer = createMockNormalizer('test');
      NormalizerRegistry.register(normalizer);

      const retrieved = NormalizerRegistry.get('test');

      expect(retrieved).toBe(normalizer);
    });

    it('should return undefined for non-existent normalizer', () => {
      const retrieved = NormalizerRegistry.get('nonexistent');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('has()', () => {
    it('should return true for registered normalizer', () => {
      const normalizer = createMockNormalizer('test');
      NormalizerRegistry.register(normalizer);

      expect(NormalizerRegistry.has('test')).toBe(true);
    });

    it('should return false for non-existent normalizer', () => {
      expect(NormalizerRegistry.has('nonexistent')).toBe(false);
    });
  });

  describe('list()', () => {
    it('should return empty array when no normalizers registered', () => {
      expect(NormalizerRegistry.list()).toEqual([]);
    });

    it('should return all registered normalizer names', () => {
      NormalizerRegistry.register(createMockNormalizer('alpha'));
      NormalizerRegistry.register(createMockNormalizer('beta'));
      NormalizerRegistry.register(createMockNormalizer('gamma'));

      const names = NormalizerRegistry.list();

      expect(names).toHaveLength(3);
      expect(names).toContain('alpha');
      expect(names).toContain('beta');
      expect(names).toContain('gamma');
    });
  });

  describe('clear()', () => {
    it('should remove all registered normalizers', () => {
      NormalizerRegistry.register(createMockNormalizer('test1'));
      NormalizerRegistry.register(createMockNormalizer('test2'));
      expect(NormalizerRegistry.size).toBe(2);

      NormalizerRegistry.clear();

      expect(NormalizerRegistry.size).toBe(0);
      expect(NormalizerRegistry.has('test1')).toBe(false);
      expect(NormalizerRegistry.has('test2')).toBe(false);
    });
  });

  describe('size', () => {
    it('should return 0 when empty', () => {
      expect(NormalizerRegistry.size).toBe(0);
    });

    it('should return correct count after registrations', () => {
      NormalizerRegistry.register(createMockNormalizer('test1'));
      expect(NormalizerRegistry.size).toBe(1);

      NormalizerRegistry.register(createMockNormalizer('test2'));
      expect(NormalizerRegistry.size).toBe(2);

      NormalizerRegistry.unregister('test1');
      expect(NormalizerRegistry.size).toBe(1);
    });
  });

  describe('integration with normalize()', () => {
    it('should call normalize method when retrieved', () => {
      const normalizer = createMockNormalizer('test');
      NormalizerRegistry.register(normalizer);

      const retrieved = NormalizerRegistry.get('test')!;
      const result = retrieved.normalize({ foo: 'bar' }, mockContext);

      expect(normalizer.normalize).toHaveBeenCalledWith({ foo: 'bar' }, mockContext);
      expect(result.success).toBe(true);
    });
  });
});
