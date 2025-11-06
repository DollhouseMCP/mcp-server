/**
 * Unit tests for sourcePriority module
 * Tests the element source priority configuration functionality
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  ElementSource,
  SourcePriorityConfig,
  DEFAULT_SOURCE_PRIORITY,
  getSourcePriorityConfig,
  validateSourcePriority,
  getSourceDisplayName,
  parseSourcePriorityOrder,
  saveSourcePriorityConfig
} from '../../../../src/config/sourcePriority.js';

describe('sourcePriority', () => {
  describe('ElementSource enum', () => {
    it('should have LOCAL value', () => {
      expect(ElementSource.LOCAL).toBe('local');
    });

    it('should have GITHUB value', () => {
      expect(ElementSource.GITHUB).toBe('github');
    });

    it('should have COLLECTION value', () => {
      expect(ElementSource.COLLECTION).toBe('collection');
    });

    it('should have exactly three sources', () => {
      const sources = Object.values(ElementSource);
      expect(sources).toHaveLength(3);
    });

    it('should have unique values', () => {
      const sources = Object.values(ElementSource);
      const uniqueSources = new Set(sources);
      expect(uniqueSources.size).toBe(sources.length);
    });
  });

  describe('DEFAULT_SOURCE_PRIORITY', () => {
    it('should have correct priority order (local → github → collection)', () => {
      expect(DEFAULT_SOURCE_PRIORITY.priority).toEqual([
        ElementSource.LOCAL,
        ElementSource.GITHUB,
        ElementSource.COLLECTION
      ]);
    });

    it('should have stopOnFirst set to true', () => {
      expect(DEFAULT_SOURCE_PRIORITY.stopOnFirst).toBe(true);
    });

    it('should have checkAllForUpdates set to false', () => {
      expect(DEFAULT_SOURCE_PRIORITY.checkAllForUpdates).toBe(false);
    });

    it('should have fallbackOnError set to true', () => {
      expect(DEFAULT_SOURCE_PRIORITY.fallbackOnError).toBe(true);
    });

    it('should be a valid configuration', () => {
      const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should include all three sources', () => {
      expect(DEFAULT_SOURCE_PRIORITY.priority).toHaveLength(3);
      expect(DEFAULT_SOURCE_PRIORITY.priority).toContain(ElementSource.LOCAL);
      expect(DEFAULT_SOURCE_PRIORITY.priority).toContain(ElementSource.GITHUB);
      expect(DEFAULT_SOURCE_PRIORITY.priority).toContain(ElementSource.COLLECTION);
    });

    it('should have no duplicate sources', () => {
      const uniqueSources = new Set(DEFAULT_SOURCE_PRIORITY.priority);
      expect(uniqueSources.size).toBe(DEFAULT_SOURCE_PRIORITY.priority.length);
    });
  });

  describe('getSourcePriorityConfig', () => {
    it('should return default configuration when no config exists', () => {
      const config = getSourcePriorityConfig();
      expect(config).toEqual(DEFAULT_SOURCE_PRIORITY);
    });

    it('should return a valid configuration', () => {
      const config = getSourcePriorityConfig();
      const result = validateSourcePriority(config);
      expect(result.isValid).toBe(true);
    });

    it('should be consistent across multiple calls', () => {
      const config1 = getSourcePriorityConfig();
      const config2 = getSourcePriorityConfig();
      const config3 = getSourcePriorityConfig();

      expect(config1).toEqual(config2);
      expect(config2).toEqual(config3);
    });

    it('should return an object with all required properties', () => {
      const config = getSourcePriorityConfig();
      expect(config).toHaveProperty('priority');
      expect(config).toHaveProperty('stopOnFirst');
      expect(config).toHaveProperty('checkAllForUpdates');
      expect(config).toHaveProperty('fallbackOnError');
    });

    it('should return priority as an array', () => {
      const config = getSourcePriorityConfig();
      expect(Array.isArray(config.priority)).toBe(true);
    });

    it('should return boolean values for flags', () => {
      const config = getSourcePriorityConfig();
      expect(typeof config.stopOnFirst).toBe('boolean');
      expect(typeof config.checkAllForUpdates).toBe('boolean');
      expect(typeof config.fallbackOnError).toBe('boolean');
    });
  });

  describe('validateSourcePriority', () => {
    describe('valid configurations', () => {
      it('should validate default configuration as valid', () => {
        const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with all sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL, ElementSource.GITHUB, ElementSource.COLLECTION],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with partial sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL, ElementSource.GITHUB],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with single source', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with different priority order', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.COLLECTION, ElementSource.LOCAL, ElementSource.GITHUB],
          stopOnFirst: false,
          checkAllForUpdates: true,
          fallbackOnError: false
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with all flags false', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL],
          stopOnFirst: false,
          checkAllForUpdates: false,
          fallbackOnError: false
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should validate configuration with all flags true', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL],
          stopOnFirst: true,
          checkAllForUpdates: true,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('invalid configurations - empty priority', () => {
      it('should reject configuration with empty priority list', () => {
        const config: SourcePriorityConfig = {
          priority: [],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Priority list cannot be empty');
      });

      it('should reject configuration with null priority', () => {
        const config = {
          priority: null as unknown as ElementSource[],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Priority list cannot be empty');
      });

      it('should reject configuration with undefined priority', () => {
        const config = {
          priority: undefined as unknown as ElementSource[],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Priority list cannot be empty');
      });
    });

    describe('invalid configurations - duplicate sources', () => {
      it('should reject configuration with duplicate LOCAL sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL, ElementSource.LOCAL],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Duplicate sources in priority list');
      });

      it('should reject configuration with duplicate GITHUB sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.GITHUB, ElementSource.GITHUB],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Duplicate sources in priority list');
      });

      it('should reject configuration with duplicate COLLECTION sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.COLLECTION, ElementSource.COLLECTION],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Duplicate sources in priority list');
      });

      it('should reject configuration with multiple duplicate sources', () => {
        const config: SourcePriorityConfig = {
          priority: [
            ElementSource.LOCAL,
            ElementSource.GITHUB,
            ElementSource.LOCAL,
            ElementSource.GITHUB
          ],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Duplicate sources in priority list');
      });

      it('should reject configuration with all same sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL, ElementSource.LOCAL, ElementSource.LOCAL],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Duplicate sources in priority list');
      });
    });

    describe('invalid configurations - unknown sources', () => {
      it('should reject configuration with unknown source string', () => {
        const config: SourcePriorityConfig = {
          priority: ['unknown' as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Unknown source: unknown');
      });

      it('should reject configuration with invalid source value', () => {
        const config: SourcePriorityConfig = {
          priority: ['invalid-source' as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Unknown source: invalid-source');
      });

      it('should reject configuration with multiple unknown sources', () => {
        const config: SourcePriorityConfig = {
          priority: ['unknown1' as ElementSource, 'unknown2' as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Unknown source: unknown1');
        expect(result.errors).toContain('Unknown source: unknown2');
      });

      it('should reject configuration with mix of valid and invalid sources', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL, 'invalid' as ElementSource, ElementSource.GITHUB],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Unknown source: invalid');
      });

      it('should reject configuration with numeric value as source', () => {
        const config: SourcePriorityConfig = {
          priority: [123 as unknown as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });

      it('should reject configuration with null value as source', () => {
        const config: SourcePriorityConfig = {
          priority: [null as unknown as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });

    describe('multiple validation errors', () => {
      it('should report multiple errors when configuration has multiple issues', () => {
        const config: SourcePriorityConfig = {
          priority: ['unknown' as ElementSource, 'unknown' as ElementSource],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.isValid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(1);
        expect(result.errors).toContain('Duplicate sources in priority list');
        expect(result.errors).toContain('Unknown source: unknown');
      });

      it('should not report errors for valid configuration', () => {
        const config: SourcePriorityConfig = {
          priority: [ElementSource.LOCAL],
          stopOnFirst: true,
          checkAllForUpdates: false,
          fallbackOnError: true
        };
        const result = validateSourcePriority(config);
        expect(result.errors).toHaveLength(0);
      });
    });

    describe('validation result structure', () => {
      it('should return object with isValid property', () => {
        const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
        expect(result).toHaveProperty('isValid');
      });

      it('should return object with errors property', () => {
        const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
        expect(result).toHaveProperty('errors');
      });

      it('should return errors as an array', () => {
        const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
        expect(Array.isArray(result.errors)).toBe(true);
      });

      it('should return isValid as boolean', () => {
        const result = validateSourcePriority(DEFAULT_SOURCE_PRIORITY);
        expect(typeof result.isValid).toBe('boolean');
      });
    });
  });

  describe('getSourceDisplayName', () => {
    it('should return "Local Portfolio" for LOCAL source', () => {
      expect(getSourceDisplayName(ElementSource.LOCAL)).toBe('Local Portfolio');
    });

    it('should return "GitHub Portfolio" for GITHUB source', () => {
      expect(getSourceDisplayName(ElementSource.GITHUB)).toBe('GitHub Portfolio');
    });

    it('should return "Community Collection" for COLLECTION source', () => {
      expect(getSourceDisplayName(ElementSource.COLLECTION)).toBe('Community Collection');
    });

    it('should return user-friendly names for all sources', () => {
      const sources = Object.values(ElementSource);
      for (const source of sources) {
        const displayName = getSourceDisplayName(source);
        expect(displayName).toBeTruthy();
        expect(typeof displayName).toBe('string');
        expect(displayName.length).toBeGreaterThan(0);
      }
    });

    it('should return display names with proper capitalization', () => {
      const localName = getSourceDisplayName(ElementSource.LOCAL);
      const githubName = getSourceDisplayName(ElementSource.GITHUB);
      const collectionName = getSourceDisplayName(ElementSource.COLLECTION);

      // Check first letter is capitalized
      expect(localName[0]).toBe(localName[0].toUpperCase());
      expect(githubName[0]).toBe(githubName[0].toUpperCase());
      expect(collectionName[0]).toBe(collectionName[0].toUpperCase());
    });

    it('should return consistent names across multiple calls', () => {
      const name1 = getSourceDisplayName(ElementSource.LOCAL);
      const name2 = getSourceDisplayName(ElementSource.LOCAL);
      expect(name1).toBe(name2);
    });

    it('should return different names for different sources', () => {
      const localName = getSourceDisplayName(ElementSource.LOCAL);
      const githubName = getSourceDisplayName(ElementSource.GITHUB);
      const collectionName = getSourceDisplayName(ElementSource.COLLECTION);

      expect(localName).not.toBe(githubName);
      expect(githubName).not.toBe(collectionName);
      expect(collectionName).not.toBe(localName);
    });

    it('should return names suitable for user display', () => {
      const sources = Object.values(ElementSource);
      for (const source of sources) {
        const displayName = getSourceDisplayName(source);

        // Should not contain underscores or internal codes
        expect(displayName).not.toContain('_');
        expect(displayName).not.toContain('ENUM');

        // Should contain descriptive words
        expect(displayName.split(' ').length).toBeGreaterThan(0);
      }
    });

    it('should throw error for invalid source value', () => {
      const invalidSource = 'invalid-source' as ElementSource;
      expect(() => getSourceDisplayName(invalidSource)).toThrow('Invalid element source: invalid-source');
    });
  });

  describe('type safety', () => {
    it('should enforce SourcePriorityConfig structure', () => {
      // This test ensures TypeScript type checking works correctly
      const config: SourcePriorityConfig = {
        priority: [ElementSource.LOCAL],
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: true
      };

      expect(config.priority).toBeDefined();
      expect(config.stopOnFirst).toBeDefined();
      expect(config.checkAllForUpdates).toBeDefined();
      expect(config.fallbackOnError).toBeDefined();
    });

    it('should enforce ElementSource enum values', () => {
      const sources: ElementSource[] = [
        ElementSource.LOCAL,
        ElementSource.GITHUB,
        ElementSource.COLLECTION
      ];

      for (const source of sources) {
        expect(typeof source).toBe('string');
        expect(Object.values(ElementSource)).toContain(source);
      }
    });
  });

  describe('edge cases', () => {
    it('should handle configuration with reversed priority order', () => {
      const config: SourcePriorityConfig = {
        priority: [ElementSource.COLLECTION, ElementSource.GITHUB, ElementSource.LOCAL],
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: true
      };
      const result = validateSourcePriority(config);
      expect(result.isValid).toBe(true);
    });

    it('should handle configuration with only two sources', () => {
      const config: SourcePriorityConfig = {
        priority: [ElementSource.GITHUB, ElementSource.COLLECTION],
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: true
      };
      const result = validateSourcePriority(config);
      expect(result.isValid).toBe(true);
    });

    it('should handle configuration with mixed boolean values', () => {
      const config: SourcePriorityConfig = {
        priority: [ElementSource.LOCAL],
        stopOnFirst: false,
        checkAllForUpdates: true,
        fallbackOnError: false
      };
      const result = validateSourcePriority(config);
      expect(result.isValid).toBe(true);
    });

    it('should handle getSourcePriorityConfig being called many times', () => {
      const calls = 100;
      const results = [];
      for (let i = 0; i < calls; i++) {
        results.push(getSourcePriorityConfig());
      }

      // All results should be equal
      const first = results[0];
      for (const result of results) {
        expect(result).toEqual(first);
      }
    });
  });

  describe('parseSourcePriorityOrder', () => {
    it('should parse array of string source names', () => {
      const input = ['local', 'github', 'collection'];
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([
        ElementSource.LOCAL,
        ElementSource.GITHUB,
        ElementSource.COLLECTION
      ]);
    });

    it('should parse JSON string array', () => {
      const input = '["github", "local", "collection"]';
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([
        ElementSource.GITHUB,
        ElementSource.LOCAL,
        ElementSource.COLLECTION
      ]);
    });

    it('should parse array of ElementSource values', () => {
      const input = [ElementSource.LOCAL, ElementSource.GITHUB];
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([ElementSource.LOCAL, ElementSource.GITHUB]);
    });

    it('should handle mixed case source names', () => {
      const input = ['LOCAL', 'GitHub', 'COLLECTION'];
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([
        ElementSource.LOCAL,
        ElementSource.GITHUB,
        ElementSource.COLLECTION
      ]);
    });

    it('should throw error for invalid JSON string', () => {
      const input = 'not valid json';
      expect(() => parseSourcePriorityOrder(input)).toThrow('Invalid JSON');
    });

    it('should throw error for non-array input (non-JSON string)', () => {
      const input = 'local';
      // Single word strings will try JSON.parse which will fail
      expect(() => parseSourcePriorityOrder(input)).toThrow('Invalid JSON');
    });

    it('should throw error for unknown source', () => {
      const input = ['local', 'unknown', 'github'];
      expect(() => parseSourcePriorityOrder(input)).toThrow('Unknown source: unknown');
    });

    it('should throw error for invalid source value', () => {
      const input = ['local', 123, 'github'];
      expect(() => parseSourcePriorityOrder(input)).toThrow('Invalid source value');
    });

    it('should handle empty array', () => {
      const input: string[] = [];
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([]);
    });

    it('should handle partial source list', () => {
      const input = ['github', 'local'];
      const result = parseSourcePriorityOrder(input);
      expect(result).toEqual([ElementSource.GITHUB, ElementSource.LOCAL]);
    });
  });

  describe('saveSourcePriorityConfig', () => {
    // Note: These tests verify the validation and error handling.
    // Actual persistence is tested through integration tests.

    it('should throw error for invalid configuration', async () => {
      const invalidConfig: SourcePriorityConfig = {
        priority: [ElementSource.LOCAL, ElementSource.LOCAL], // Duplicate
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: true
      };

      await expect(saveSourcePriorityConfig(invalidConfig))
        .rejects
        .toThrow('Invalid source priority configuration');
    });

    it('should throw error for empty priority list', async () => {
      const invalidConfig: SourcePriorityConfig = {
        priority: [],
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: true
      };

      await expect(saveSourcePriorityConfig(invalidConfig))
        .rejects
        .toThrow('Priority list cannot be empty');
    });

    it('should accept valid configuration', async () => {
      const validConfig: SourcePriorityConfig = {
        priority: [ElementSource.GITHUB, ElementSource.LOCAL, ElementSource.COLLECTION],
        stopOnFirst: false,
        checkAllForUpdates: true,
        fallbackOnError: true
      };

      // Should not throw
      await expect(saveSourcePriorityConfig(validConfig)).resolves.not.toThrow();
    });

    it('should accept minimal valid configuration', async () => {
      const validConfig: SourcePriorityConfig = {
        priority: [ElementSource.LOCAL],
        stopOnFirst: true,
        checkAllForUpdates: false,
        fallbackOnError: false
      };

      // Should not throw
      await expect(saveSourcePriorityConfig(validConfig)).resolves.not.toThrow();
    });
  });
});
