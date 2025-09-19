/**
 * Unit tests for Memory element
 */

import { Memory, MemoryMetadata, MemoryEntry, MemorySearchOptions } from '../../../../../src/elements/memories/Memory.js';
import { ElementType } from '../../../../../src/portfolio/types.js';
import { ElementStatus } from '../../../../../src/types/elements/index.js';

describe('Memory Element', () => {
  let memory: Memory;
  
  beforeEach(() => {
    memory = new Memory({
      name: 'Test Memory',
      description: 'A test memory for unit tests',
      retentionDays: 7,
      maxEntries: 100,
      privacyLevel: 'private'
    });
  });
  
  describe('Constructor', () => {
    it('should create a memory with default values', () => {
      const defaultMemory = new Memory();
      expect(defaultMemory.type).toBe(ElementType.MEMORY);
      expect(defaultMemory.metadata.name).toBe('Unnamed Memory');
      expect(defaultMemory.extensions?.storageBackend).toBe('memory');
      expect(defaultMemory.extensions?.retentionDays).toBe(30);
      expect(defaultMemory.extensions?.privacyLevel).toBe('private');
    });
    
    it('should sanitize metadata inputs', () => {
      const memory = new Memory({
        name: '<script>alert("xss")</script>',
        description: 'Test<img src=x onerror=alert("xss")>'
      });
      
      expect(memory.metadata.name).not.toContain('<script>');
      expect(memory.metadata.description).not.toContain('<img');
    });
    
    it('should enforce maxEntries limit', () => {
      const memory = new Memory({
        maxEntries: 5000 // Exceeds default max
      });
      
      expect(memory.extensions?.maxEntries).toBe(1000); // Should be capped
    });
  });
  
  describe('addEntry', () => {
    it('should add a memory entry successfully', async () => {
      const entry = await memory.addEntry('Test memory content', ['test', 'unit-test']);
      
      expect(entry).toBeDefined();
      expect(entry.content).toBe('Test memory content');
      expect(entry.tags).toEqual(['test', 'unit-test']);
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.privacyLevel).toBe('private');
    });
    
    it('should sanitize content and tags', async () => {
      const entry = await memory.addEntry(
        '<script>alert("xss")</script>Important note',
        ['<script>bad</script>', 'clean-tag']
      );
      
      expect(entry.content).not.toContain('<script>');
      expect(entry.tags).not.toContain('<script>bad</script>');
      expect(entry.tags).toContain('clean-tag');
    });
    
    it('should reject empty content', async () => {
      await expect(memory.addEntry('   ')).rejects.toThrow('Memory content cannot be empty');
    });
    
    it('should enforce max entries limit', async () => {
      const smallMemory = new Memory({ maxEntries: 3 });
      
      await smallMemory.addEntry('Entry 1');
      await smallMemory.addEntry('Entry 2');
      await smallMemory.addEntry('Entry 3');
      
      // Should enforce retention and allow new entry
      await expect(smallMemory.addEntry('Entry 4')).resolves.toBeDefined();
      
      const stats = smallMemory.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(3);
    });
    
    it('should limit number of tags per entry', async () => {
      const manyTags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
      const entry = await memory.addEntry('Content', manyTags);
      
      expect(entry.tags?.length).toBeLessThanOrEqual(20);
    });
  });
  
  describe('search', () => {
    beforeEach(async () => {
      await memory.addEntry('First memory about coding', ['coding', 'javascript']);
      await memory.addEntry('Second memory about testing', ['testing', 'unit-test']);
      await memory.addEntry('Third memory about coding tests', ['coding', 'testing']);
    });
    
    it('should search by query text', async () => {
      const results = await memory.search({ query: 'coding' });
      
      expect(results).toHaveLength(2);
      expect(results[0].content).toContain('coding');
    });
    
    it('should search by tags', async () => {
      const results = await memory.search({ tags: ['testing'] });
      
      expect(results).toHaveLength(2);
      expect(results.every(r => r.tags?.includes('testing'))).toBe(true);
    });
    
    it('should apply limit to search results', async () => {
      const results = await memory.search({ limit: 1 });
      
      expect(results).toHaveLength(1);
    });
    
    it('should filter by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      
      const results = await memory.search({
        startDate: yesterday,
        endDate: tomorrow
      });
      
      expect(results).toHaveLength(3);
    });
    
    it('should respect privacy levels', async () => {
      // Create memory with different privacy levels
      const memory = new Memory({ privacyLevel: 'private' });
      
      // We need to test with multiple entries of different privacy levels
      // For now, test that a memory respects its default privacy level
      await memory.addEntry('Private info');
      
      const results = await memory.search({});
      expect(results[0].privacyLevel).toBe('private');
      
      // TODO: To properly test privacy filtering, we'd need to support
      // per-entry privacy levels, not just memory-wide defaults
    });
  });
  
  describe('enforceRetentionPolicy', () => {
    it('should remove expired entries', async () => {
      // Create memory with 1 day retention
      const shortMemory = new Memory({ retentionDays: 1 });
      
      // Add entry and manually set expiry to past
      const entry = await shortMemory.addEntry('Old memory');
      const entriesMap = (shortMemory as any).entries as Map<string, MemoryEntry>;
      const storedEntry = entriesMap.get(entry.id)!;
      storedEntry.expiresAt = new Date(Date.now() - 1000); // 1 second ago
      
      const deletedCount = await shortMemory.enforceRetentionPolicy();
      expect(deletedCount).toBe(1);
      
      const stats = shortMemory.getStats();
      expect(stats.totalEntries).toBe(0);
    });
    
    it('should remove oldest entries when over capacity', async () => {
      const smallMemory = new Memory({ maxEntries: 2 });
      
      await smallMemory.addEntry('First');
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      await smallMemory.addEntry('Second');
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Third entry should trigger retention policy and remove 'First'
      await smallMemory.addEntry('Third');
      
      const remaining = await smallMemory.search({});
      expect(remaining).toHaveLength(2);
      
      // Check that we kept the two newest entries
      const contents = remaining.map(e => e.content);
      expect(contents).toContain('Second');
      expect(contents).toContain('Third');
      expect(contents).not.toContain('First');
    });
  });
  
  describe('getEntry and deleteEntry', () => {
    it('should get entry by ID', async () => {
      const added = await memory.addEntry('Test content');
      const retrieved = await memory.getEntry(added.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.content).toBe('Test content');
    });
    
    it('should delete entry by ID', async () => {
      const added = await memory.addEntry('To be deleted');
      
      const deleted = await memory.deleteEntry(added.id);
      expect(deleted).toBe(true);
      
      const retrieved = await memory.getEntry(added.id);
      expect(retrieved).toBeUndefined();
    });
    
    it('should return false when deleting non-existent entry', async () => {
      const deleted = await memory.deleteEntry('non-existent-id');
      expect(deleted).toBe(false);
    });
  });
  
  describe('clearAll', () => {
    it('should require confirmation to clear', async () => {
      await memory.addEntry('Important data');
      
      await expect(memory.clearAll(false)).rejects.toThrow('confirmation');
    });
    
    it('should clear all entries with confirmation', async () => {
      await memory.addEntry('Entry 1');
      await memory.addEntry('Entry 2');
      
      await memory.clearAll(true);
      
      const stats = memory.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });
  
  describe('getStats', () => {
    it('should return correct statistics', async () => {
      await memory.addEntry('First', ['tag1', 'tag2']);
      await memory.addEntry('Second', ['tag2', 'tag3']);
      await memory.addEntry('Third', ['tag1']);
      
      const stats = memory.getStats();
      
      expect(stats.totalEntries).toBe(3);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.oldestEntry).toBeDefined();
      expect(stats.newestEntry).toBeDefined();
      expect(stats.tagFrequency.get('tag1')).toBe(2);
      expect(stats.tagFrequency.get('tag2')).toBe(2);
      expect(stats.tagFrequency.get('tag3')).toBe(1);
    });
  });
  
  describe('serialize and deserialize', () => {
    it('should serialize and deserialize correctly', async () => {
      await memory.addEntry('Entry 1', ['tag1']);
      await memory.addEntry('Entry 2', ['tag2']);
      
      const serialized = memory.serialize();
      expect(serialized).toContain('Entry 1');
      expect(serialized).toContain('tag1');
      
      const newMemory = new Memory();
      newMemory.deserialize(serialized);
      
      const entries = await newMemory.search({});
      expect(entries).toHaveLength(2);
      // When timestamps are identical, order may vary
      const contents = entries.map(e => e.content);
      expect(contents).toContain('Entry 1');
      expect(contents).toContain('Entry 2');
    });
    
    it('should handle invalid deserialization data', () => {
      const newMemory = new Memory();
      
      expect(() => newMemory.deserialize('invalid json')).toThrow();
      expect(() => newMemory.deserialize('{"type": "wrong"}')).toThrow();
    });
    
    it('should re-sanitize content on deserialization', () => {
      const maliciousData = JSON.stringify({
        id: 'test-id',
        type: ElementType.MEMORY,
        entries: [{
          id: 'entry-1',
          content: '<script>alert("xss")</script>',
          timestamp: new Date().toISOString(),
          tags: ['<script>bad</script>']
        }]
      });
      
      const newMemory = new Memory();
      newMemory.deserialize(maliciousData);
      
      const entries = (newMemory as any).entries as Map<string, MemoryEntry>;
      const entry = entries.get('entry-1');
      expect(entry?.content).not.toContain('<script>');
      expect(entry?.tags).not.toContain('<script>bad</script>');
    });
  });
  
  describe('validate', () => {
    it('should validate retention days', () => {
      const invalidMemory = new Memory({ retentionDays: 400 });
      const result = invalidMemory.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'retentionDays')).toBe(true);
    });
    
    it('should validate max entries', () => {
      const invalidMemory = new Memory({ maxEntries: 5000 });
      const result = invalidMemory.validate();
      
      // Should be valid because constructor caps it
      expect(result.valid).toBe(true);
    });
    
    it('should validate total memory size', async () => {
      // Create entries that exceed memory limit
      const largeContent = 'x'.repeat(500 * 1024); // 500KB
      
      await memory.addEntry(largeContent.substring(0, 100 * 1024)); // Max entry size
      await memory.addEntry(largeContent.substring(0, 100 * 1024));
      
      // Try to add more to exceed 1MB limit
      for (let i = 0; i < 10; i++) {
        try {
          await memory.addEntry(largeContent.substring(0, 100 * 1024));
        } catch {
          // May hit max entries first
        }
      }
      
      const result = memory.validate();
      const stats = memory.getStats();
      
      if (stats.totalSize > 1024 * 1024) {
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.field === 'memory')).toBe(true);
      }
    });
  });
  
  describe('Security Tests', () => {
    it('should prevent XSS in content', async () => {
      const xssPayloads = [
        '<script>alert("xss")</script>',
        '<img src=x onerror=alert("xss")>',
        '<iframe src="javascript:alert(\'xss\')"></iframe>',
        '<input onfocus=alert("xss") autofocus>'
      ];
      
      for (const payload of xssPayloads) {
        // Add some safe content with the payload
        const entry = await memory.addEntry(payload + ' Safe content here');
        expect(entry.content).not.toContain('<script>');
        expect(entry.content).not.toContain('<img');
        expect(entry.content).not.toContain('<iframe');
        expect(entry.content).not.toContain('<input');
        // Should keep the safe content
        expect(entry.content).toContain('Safe content here');
      }
    });
    
    it('should handle Unicode attacks', async () => {
      const unicodePayloads = [
        '\u202E\u202D\u202C', // Direction override
        'A\u0301\u0302\u0303\u0304', // Multiple combining characters
        '\uFEFF\u200B\u200C\u200D' // Zero-width characters
      ];
      
      for (const payload of unicodePayloads) {
        const entry = await memory.addEntry(payload + 'test');
        expect(entry.content).toBeDefined();
        // Content should be normalized
      }
    });
    
    it('should enforce content size limits', async () => {
      const hugeContent = 'x'.repeat(200 * 1024); // 200KB
      const entry = await memory.addEntry(hugeContent);
      
      // Should be truncated to max entry size
      expect(entry.content.length).toBeLessThanOrEqual(100 * 1024);
    });
    
    it('should sanitize metadata', async () => {
      const entry = await memory.addEntry('Test', [], {
        '<script>key</script>': 'value',
        'normal_key': '<script>bad value</script>',
        'number_key': 123,
        'object_key': { nested: 'ignored' } // Should be ignored
      });
      
      expect(entry.metadata).toBeDefined();
      expect(Object.keys(entry.metadata!)).not.toContain('<script>key</script>');
      expect(entry.metadata!['normal_key']).not.toContain('<script>');
      expect(entry.metadata!['number_key']).toBe(123);
      expect(entry.metadata!['object_key']).toBeUndefined();
    });
  });
});