import { describe, it, expect, beforeEach } from '@jest/globals';
import { Memory } from '../../../../../src/elements/memories/Memory.js';

describe('Memory Timestamp Handling', () => {
  let memory: Memory;

  beforeEach(() => {
    memory = new Memory({
      name: 'test-memory',
      description: 'Test memory for timestamp validation'
    });
  });

  describe('getStats with various timestamp formats', () => {
    it('should handle Date objects correctly', async () => {
      const validDate = new Date('2025-09-22T10:00:00Z');
      await memory.addEntry('Test entry', ['test']);

      // Manually set the timestamp to ensure it's a Date object
      const entries = (memory as any).entries;
      const entry = entries.values().next().value;
      entry.timestamp = validDate;

      const stats = memory.getStats();
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
    });

    it('should convert valid ISO string timestamps to Date objects', async () => {
      await memory.addEntry('Test entry', ['test']);

      // Simulate editing by setting timestamp as string
      const entries = (memory as any).entries;
      const entry = entries.values().next().value;
      entry.timestamp = '2025-09-22T10:00:00Z';

      const stats = memory.getStats();
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
      expect(stats.oldestEntry?.toISOString()).toBe('2025-09-22T10:00:00.000Z');
    });

    it('should handle invalid date strings gracefully', async () => {
      await memory.addEntry('Test entry 1', ['test']);
      await memory.addEntry('Test entry 2', ['test']);

      const entries = (memory as any).entries;
      const entriesArray = Array.from(entries.values());

      // Set one entry with invalid timestamp
      entriesArray[0].timestamp = 'invalid-date-string';
      // Keep the second entry with valid timestamp
      entriesArray[1].timestamp = new Date('2025-09-22T10:00:00Z');

      // Should not throw, but should skip invalid timestamp
      const stats = memory.getStats();
      expect(stats.oldestEntry).toBeInstanceOf(Date);
      expect(stats.newestEntry).toBeInstanceOf(Date);
      expect(stats.oldestEntry?.toISOString()).toBe('2025-09-22T10:00:00.000Z');
    });

    it('should handle null/undefined timestamps gracefully', async () => {
      await memory.addEntry('Test entry', ['test']);

      const entries = (memory as any).entries;
      const entry = entries.values().next().value;
      entry.timestamp = null;

      const stats = memory.getStats();
      // null converts to epoch time (1970-01-01), which our validator should reject
      // since it's before the reasonable range
      expect(stats.oldestEntry).toBeUndefined();
      expect(stats.newestEntry).toBeUndefined();
    });

    it('should reject timestamps outside reasonable range', async () => {
      await memory.addEntry('Test entry 1', ['test']);
      await memory.addEntry('Test entry 2', ['test']);

      const entries = (memory as any).entries;
      const entriesArray = Array.from(entries.values());

      // Set timestamps outside reasonable range
      entriesArray[0].timestamp = '1969-12-31T23:59:59Z'; // Before epoch
      entriesArray[1].timestamp = '2200-01-01T00:00:00Z'; // Far future

      const stats = memory.getStats();
      // Both should be skipped due to validation
      expect(stats.totalEntries).toBe(2);
    });

    it('should handle multiple entries with mixed timestamp validity', async () => {
      await memory.addEntry('Entry 1', ['test']);
      await memory.addEntry('Entry 2', ['test']);
      await memory.addEntry('Entry 3', ['test']);

      const entries = (memory as any).entries;
      const entriesArray = Array.from(entries.values());

      // Mix of valid and invalid timestamps
      entriesArray[0].timestamp = new Date('2025-09-22T10:00:00Z');
      entriesArray[1].timestamp = 'not-a-date';
      entriesArray[2].timestamp = '2025-09-23T10:00:00Z';

      const stats = memory.getStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.oldestEntry?.toISOString()).toBe('2025-09-22T10:00:00.000Z');
      expect(stats.newestEntry?.toISOString()).toBe('2025-09-23T10:00:00.000Z');
    });
  });

  describe('ensureDateObject helper', () => {
    it('should validate Date objects', () => {
      const validDate = new Date('2025-09-22T10:00:00Z');
      const helper = (memory as any).ensureDateObject;

      expect(() => helper.call(memory, validDate)).not.toThrow();
      expect(helper.call(memory, validDate)).toEqual(validDate);
    });

    it('should convert valid strings to Date objects', () => {
      const helper = (memory as any).ensureDateObject;
      const result = helper.call(memory, '2025-09-22T10:00:00Z');

      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe('2025-09-22T10:00:00.000Z');
    });

    it('should reject invalid date strings', () => {
      const helper = (memory as any).ensureDateObject;

      expect(() => helper.call(memory, 'invalid')).toThrow('Invalid date value');
      expect(() => helper.call(memory, '')).toThrow('Invalid date value');
      expect(() => helper.call(memory, 'not-a-date')).toThrow('Invalid date value');
    });

    it('should reject dates outside reasonable range', () => {
      const helper = (memory as any).ensureDateObject;

      // Before epoch
      expect(() => helper.call(memory, '1969-12-31T23:59:59Z')).toThrow('out of reasonable range');

      // Far future (more than 100 years)
      expect(() => helper.call(memory, '2200-01-01T00:00:00Z')).toThrow('out of reasonable range');
    });

    it('should handle Invalid Date objects', () => {
      const helper = (memory as any).ensureDateObject;
      const invalidDate = new Date('invalid');

      expect(() => helper.call(memory, invalidDate)).toThrow('Invalid Date object');
    });
  });
});