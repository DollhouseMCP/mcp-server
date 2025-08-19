/**
 * Unit tests for CollectionBrowser MCP filtering logic
 * Tests the type-safe filtering of collection content types
 */

import { CollectionBrowser } from '../../../../src/collection/CollectionBrowser.js';
import { GitHubClient } from '../../../../src/collection/GitHubClient.js';
import { CollectionCache, CollectionItem } from '../../../../src/cache/CollectionCache.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

// Mock the dependencies
jest.mock('../../../../src/collection/GitHubClient.js');
jest.mock('../../../../src/cache/CollectionCache.js');

describe('CollectionBrowser MCP Filtering', () => {
  let collectionBrowser: CollectionBrowser;
  let mockGitHubClient: jest.Mocked<GitHubClient>;
  let mockCollectionCache: jest.Mocked<CollectionCache>;

  // Test data - includes both supported and unsupported types
  const mockGitHubDirectoryResponse = [
    { name: 'personas', type: 'dir', path: 'library/personas' },
    { name: 'skills', type: 'dir', path: 'library/skills' },
    { name: 'agents', type: 'dir', path: 'library/agents' },
    { name: 'templates', type: 'dir', path: 'library/templates' },
    { name: 'memories', type: 'dir', path: 'library/memories' }, // Should be filtered out
    { name: 'ensembles', type: 'dir', path: 'library/ensembles' }, // Should be filtered out
    { name: 'invalid-type', type: 'dir', path: 'library/invalid-type' }, // Should be filtered out
    { name: 'readme.md', type: 'file', path: 'library/readme.md' } // Should be ignored (not a directory)
  ];

  const mockCacheItems: CollectionItem[] = [
    { name: 'persona1.md', path: 'library/personas/persona1.md', sha: 'sha1' },
    { name: 'persona2.md', path: 'library/personas/persona2.md', sha: 'sha2' },
    { name: 'skill1.md', path: 'library/skills/skill1.md', sha: 'sha3' },
    { name: 'agent1.md', path: 'library/agents/agent1.md', sha: 'sha4' },
    { name: 'template1.md', path: 'library/templates/template1.md', sha: 'sha5' },
    { name: 'memory1.md', path: 'library/memories/memory1.md', sha: 'sha6' }, // Should be filtered out
    { name: 'ensemble1.md', path: 'library/ensembles/ensemble1.md', sha: 'sha7' }, // Should be filtered out
    { name: 'invalid1.md', path: 'library/invalid-type/invalid1.md', sha: 'sha8' } // Should be filtered out
  ];

  beforeEach(() => {
    // Create mocked instances
    mockGitHubClient = {
      fetchFromGitHub: jest.fn(),
      isAuthenticated: jest.fn().mockReturnValue(true)
    } as any;

    mockCollectionCache = {
      loadCache: jest.fn(),
      saveCache: jest.fn()
    } as any;

    collectionBrowser = new CollectionBrowser(mockGitHubClient, mockCollectionCache);
  });

  describe('browseCollection - GitHub API filtering', () => {
    it('should only return MCP-supported types when browsing library section', async () => {
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(mockGitHubDirectoryResponse);

      const result = await collectionBrowser.browseCollection('library');

      expect(result.categories).toHaveLength(4); // Only personas, skills, agents, templates
      
      const categoryNames = result.categories.map((cat: any) => cat.name);
      expect(categoryNames).toContain('personas');
      expect(categoryNames).toContain('skills');
      expect(categoryNames).toContain('agents');
      expect(categoryNames).toContain('templates');
      
      // Should NOT contain filtered types
      expect(categoryNames).not.toContain('memories');
      expect(categoryNames).not.toContain('ensembles');
      expect(categoryNames).not.toContain('invalid-type');
    });

    it('should handle empty directory response', async () => {
      mockGitHubClient.fetchFromGitHub.mockResolvedValue([]);

      const result = await collectionBrowser.browseCollection('library');

      expect(result.categories).toHaveLength(0);
      expect(result.items).toHaveLength(0);
    });

    it('should handle response with no valid content types', async () => {
      const invalidResponse = [
        { name: 'memories', type: 'dir', path: 'library/memories' },
        { name: 'ensembles', type: 'dir', path: 'library/ensembles' },
        { name: 'invalid-type', type: 'dir', path: 'library/invalid-type' },
        { name: 'readme.md', type: 'file', path: 'library/readme.md' }
      ];
      
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(invalidResponse);

      const result = await collectionBrowser.browseCollection('library');

      expect(result.categories).toHaveLength(0);
    });

    it('should not filter when browsing specific content types', async () => {
      const personaFiles = [
        { name: 'persona1.md', type: 'file', path: 'library/personas/persona1.md' },
        { name: 'persona2.md', type: 'file', path: 'library/personas/persona2.md' }
      ];
      
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(personaFiles);

      const result = await collectionBrowser.browseCollection('library', 'personas');

      expect(result.items).toHaveLength(2);
      expect(result.categories).toHaveLength(0);
    });

    it('should handle mixed file and directory responses correctly', async () => {
      const mixedResponse = [
        { name: 'personas', type: 'dir', path: 'library/personas' },
        { name: 'memories', type: 'dir', path: 'library/memories' },
        { name: 'readme.md', type: 'file', path: 'library/readme.md' },
        { name: 'skills', type: 'dir', path: 'library/skills' }
      ];
      
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(mixedResponse);

      const result = await collectionBrowser.browseCollection('library');

      expect(result.categories).toHaveLength(2); // Only personas and skills
      const categoryNames = result.categories.map((cat: any) => cat.name);
      expect(categoryNames).toContain('personas');
      expect(categoryNames).toContain('skills');
      expect(categoryNames).not.toContain('memories');
    });
  });

  describe('browseCollection - Cache fallback filtering', () => {
    it('should filter unsupported types when falling back to cache', async () => {
      // Make GitHub API fail to trigger cache fallback
      mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('GitHub API unavailable'));
      
      // Mock cache to return data with mixed types
      mockCollectionCache.loadCache.mockResolvedValue({
        items: mockCacheItems,
        timestamp: Date.now()
      });

      const result = await collectionBrowser.browseCollection('library');

      expect(result.categories).toHaveLength(4); // Only supported types
      
      const categoryNames = result.categories.map((cat: any) => cat.name);
      expect(categoryNames).toContain('personas');
      expect(categoryNames).toContain('skills');
      expect(categoryNames).toContain('agents');
      expect(categoryNames).toContain('templates');
      
      // Should NOT contain filtered types
      expect(categoryNames).not.toContain('memories');
      expect(categoryNames).not.toContain('ensembles');
      expect(categoryNames).not.toContain('invalid-type');
    });

    it('should handle empty cache gracefully', async () => {
      mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('GitHub API unavailable'));
      mockCollectionCache.loadCache.mockResolvedValue(null);

      const result = await collectionBrowser.browseCollection('library');

      // Should fall back to seed data or return empty result
      expect(result.categories).toBeDefined();
      expect(Array.isArray(result.categories)).toBe(true);
    });

    it('should filter cache items when browsing specific type', async () => {
      mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('GitHub API unavailable'));
      mockCollectionCache.loadCache.mockResolvedValue({
        items: mockCacheItems,
        timestamp: Date.now()
      });

      const result = await collectionBrowser.browseCollection('library', 'personas');

      expect(result.items).toHaveLength(2); // Only persona items
      const itemNames = result.items.map((item: any) => item.name);
      expect(itemNames).toContain('persona1.md');
      expect(itemNames).toContain('persona2.md');
      
      // Should not contain items from other types
      expect(itemNames).not.toContain('memory1.md');
      expect(itemNames).not.toContain('ensemble1.md');
    });
  });

  describe('getContentTypesFromItems - type safety', () => {
    it('should only return supported content types from cache items', async () => {
      // Access private method via any cast for testing
      const browser = collectionBrowser as any;
      
      const contentTypes = browser.getContentTypesFromItems(mockCacheItems);

      expect(contentTypes).toHaveLength(4);
      
      const typeNames = contentTypes.map((type: any) => type.name);
      expect(typeNames).toContain('personas');
      expect(typeNames).toContain('skills');
      expect(typeNames).toContain('agents');
      expect(typeNames).toContain('templates');
      
      // Should NOT contain filtered types
      expect(typeNames).not.toContain('memories');
      expect(typeNames).not.toContain('ensembles');
      expect(typeNames).not.toContain('invalid-type');
      
      // All returned items should have correct structure
      contentTypes.forEach((type: any) => {
        expect(type).toHaveProperty('name');
        expect(type).toHaveProperty('type', 'dir');
      });
    });

    it('should handle items with invalid paths gracefully', async () => {
      const browser = collectionBrowser as any;
      
      const invalidItems: CollectionItem[] = [
        { name: 'invalid.md', path: 'invalid', sha: 'sha1' }, // No library prefix
        { name: 'invalid2.md', path: 'library', sha: 'sha2' }, // No type specified
        { name: 'persona1.md', path: 'library/personas/persona1.md', sha: 'sha3' } // Valid
      ];
      
      const contentTypes = browser.getContentTypesFromItems(invalidItems);

      expect(contentTypes).toHaveLength(1);
      expect(contentTypes[0].name).toBe('personas');
    });

    it('should deduplicate content types from multiple items', async () => {
      const browser = collectionBrowser as any;
      
      const duplicateItems: CollectionItem[] = [
        { name: 'persona1.md', path: 'library/personas/persona1.md', sha: 'sha1' },
        { name: 'persona2.md', path: 'library/personas/persona2.md', sha: 'sha2' },
        { name: 'persona3.md', path: 'library/personas/persona3.md', sha: 'sha3' },
        { name: 'skill1.md', path: 'library/skills/skill1.md', sha: 'sha4' }
      ];
      
      const contentTypes = browser.getContentTypesFromItems(duplicateItems);

      expect(contentTypes).toHaveLength(2); // personas and skills, no duplicates
      const typeNames = contentTypes.map((type: any) => type.name);
      expect(typeNames).toContain('personas');
      expect(typeNames).toContain('skills');
    });
  });

  describe('Type safety validation', () => {
    it('should not throw errors with malformed directory names', async () => {
      const malformedResponse = [
        { name: '', type: 'dir', path: 'library/' }, // Empty name
        { name: null, type: 'dir', path: 'library/null' }, // Null name
        { name: undefined, type: 'dir', path: 'library/undefined' }, // Undefined name
        { name: 'personas', type: 'dir', path: 'library/personas' }, // Valid
        { name: 123, type: 'dir', path: 'library/123' } // Number as name
      ];
      
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(malformedResponse);

      await expect(collectionBrowser.browseCollection('library')).resolves.not.toThrow();
      
      const result = await collectionBrowser.browseCollection('library');
      expect(result.categories).toHaveLength(1); // Only the valid 'personas' entry
    });

    it('should handle all actual ElementType values correctly', async () => {
      // Test with all actual ElementType values
      const allTypesResponse = Object.values(ElementType).map(type => ({
        name: type,
        type: 'dir',
        path: `library/${type}`
      }));
      
      mockGitHubClient.fetchFromGitHub.mockResolvedValue(allTypesResponse);

      const result = await collectionBrowser.browseCollection('library');

      // Should only return MCP-supported types (not memories, ensembles)
      expect(result.categories).toHaveLength(4);
      const categoryNames = result.categories.map((cat: any) => cat.name);
      expect(categoryNames).toContain(ElementType.PERSONA);
      expect(categoryNames).toContain(ElementType.SKILL);
      expect(categoryNames).toContain(ElementType.AGENT);
      expect(categoryNames).toContain(ElementType.TEMPLATE);
      expect(categoryNames).not.toContain(ElementType.MEMORY);
      expect(categoryNames).not.toContain(ElementType.ENSEMBLE);
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle GitHub API errors gracefully', async () => {
      mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('Rate limit exceeded'));
      mockCollectionCache.loadCache.mockResolvedValue({
        items: mockCacheItems,
        timestamp: Date.now()
      });

      const result = await collectionBrowser.browseCollection('library');

      expect(result).toBeDefined();
      expect(result.categories).toBeDefined();
    });

    it('should handle cache failures gracefully', async () => {
      mockGitHubClient.fetchFromGitHub.mockRejectedValue(new Error('GitHub API unavailable'));
      mockCollectionCache.loadCache.mockRejectedValue(new Error('Cache read failed'));

      const result = await collectionBrowser.browseCollection('library');

      expect(result).toBeDefined();
      expect(result.categories).toBeDefined();
    });

    it('should handle non-array responses from GitHub API by falling back to cache', async () => {
      mockGitHubClient.fetchFromGitHub.mockResolvedValue({ error: 'Not found' } as any);
      mockCollectionCache.loadCache.mockResolvedValue({
        items: mockCacheItems.slice(0, 4), // Only supported types
        timestamp: Date.now()
      });

      const result = await collectionBrowser.browseCollection('library');

      expect(result).toBeDefined();
      expect(result.categories).toBeDefined();
      // Should fall back to cache, not throw error
    });
  });

  describe('Consistency between API and cache filtering', () => {
    it('should return same filtered types for API and cache responses', async () => {
      // First, get API response
      mockGitHubClient.fetchFromGitHub.mockResolvedValueOnce(mockGitHubDirectoryResponse);
      const apiResult = await collectionBrowser.browseCollection('library');

      // Then, simulate cache fallback
      mockGitHubClient.fetchFromGitHub.mockRejectedValueOnce(new Error('API failed'));
      mockCollectionCache.loadCache.mockResolvedValue({
        items: mockCacheItems,
        timestamp: Date.now()
      });
      const cacheResult = await collectionBrowser.browseCollection('library');

      // Both should return the same filtered types
      expect(apiResult.categories).toHaveLength(cacheResult.categories.length);
      
      const apiTypes = new Set(apiResult.categories.map((cat: any) => cat.name));
      const cacheTypes = new Set(cacheResult.categories.map((cat: any) => cat.name));
      
      expect(apiTypes).toEqual(cacheTypes);
    });
  });
});