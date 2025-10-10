/**
 * Memory API Integration Tests
 * Issue #1320: Test new Memory APIs for BackgroundValidator integration
 *
 * Tests:
 * 1. getEntriesByTrustLevel() - Public API for accessing entries by trust level
 * 2. getAllEntries() - Public API for accessing all entries
 * 3. save() - Instance method for persisting changes
 * 4. Memory.findByTrustLevel() - Static query API
 * 5. Memory.find() - General query API
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Memory } from '../../../../../src/elements/memories/Memory.js';
import { MemoryManager } from '../../../../../src/elements/memories/MemoryManager.js';
import { TRUST_LEVELS } from '../../../../../src/elements/memories/constants.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Memory API Integration (Issue #1320)', () => {
  let manager: MemoryManager;

  beforeEach(async () => {
    manager = new MemoryManager();
  });

  afterEach(async () => {
    // Clean up any test memories created
    try {
      const memories = await manager.list();
      for (const memory of memories) {
        const filePath = memory.getFilePath();
        if (filePath && filePath.includes('test-')) {
          await manager.delete(filePath);
        }
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('getEntriesByTrustLevel()', () => {
    it('should return entries with matching trust level', async () => {
      const memory = new Memory({ name: 'Test Memory' });

      // Add entries with different trust levels
      const entry1 = await memory.addEntry('Untrusted content', ['test'], {}, 'test-source');
      const entry2 = await memory.addEntry('More untrusted', ['test'], {}, 'test-source');

      // Manually set one to VALIDATED for testing
      const allEntries = memory.getAllEntries();
      allEntries[1].trustLevel = TRUST_LEVELS.VALIDATED;

      // Get untrusted entries
      const untrustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      expect(untrustedEntries).toHaveLength(1);
      expect(untrustedEntries[0].id).toBe(entry1.id);
    });

    it('should return empty array when no entries match', async () => {
      const memory = new Memory({ name: 'Test Memory' });
      await memory.addEntry('Test content', ['test']);

      const flaggedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.FLAGGED);

      expect(flaggedEntries).toHaveLength(0);
    });

    it('should return all entries if all have same trust level', async () => {
      const memory = new Memory({ name: 'Test Memory' });

      await memory.addEntry('Content 1', ['test']);
      await memory.addEntry('Content 2', ['test']);
      await memory.addEntry('Content 3', ['test']);

      // All entries start as UNTRUSTED
      const untrustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      expect(untrustedEntries).toHaveLength(3);
    });
  });

  describe('getAllEntries()', () => {
    it('should return all entries in memory', async () => {
      const memory = new Memory({ name: 'Test Memory' });

      await memory.addEntry('Entry 1', ['test']);
      await memory.addEntry('Entry 2', ['test']);
      await memory.addEntry('Entry 3', ['test']);

      const allEntries = memory.getAllEntries();

      expect(allEntries).toHaveLength(3);
      expect(allEntries.every(e => e.content && e.id && e.timestamp)).toBe(true);
    });

    it('should return empty array for empty memory', () => {
      const memory = new Memory({ name: 'Test Memory' });
      const allEntries = memory.getAllEntries();

      expect(allEntries).toHaveLength(0);
    });
  });

  describe('getEntriesIterator()', () => {
    it('should iterate over all entries', async () => {
      const memory = new Memory({ name: 'Test Memory' });

      await memory.addEntry('Entry 1', ['test']);
      await memory.addEntry('Entry 2', ['test']);
      await memory.addEntry('Entry 3', ['test']);

      const entries: any[] = [];
      for (const entry of memory.getEntriesIterator()) {
        entries.push(entry);
      }

      expect(entries).toHaveLength(3);
    });

    it('should work with spread operator', async () => {
      const memory = new Memory({ name: 'Test Memory' });

      await memory.addEntry('Entry 1', ['test']);
      await memory.addEntry('Entry 2', ['test']);

      const entries = [...memory.getEntriesIterator()];

      expect(entries).toHaveLength(2);
    });
  });

  describe('setFilePath() and getFilePath()', () => {
    it('should store and retrieve file path', () => {
      const memory = new Memory({ name: 'Test Memory' });
      const testPath = '/test/path/memory.yaml';

      memory.setFilePath(testPath);

      expect(memory.getFilePath()).toBe(testPath);
    });

    it('should return undefined if no path set', () => {
      const memory = new Memory({ name: 'Test Memory' });

      expect(memory.getFilePath()).toBeUndefined();
    });
  });

  describe('save()', () => {
    it('should persist memory to disk when path is set', async () => {
      const memory = new Memory({ name: 'Test Save Memory API' });
      await memory.addEntry('Test content', ['test']);

      // Save using manager first to get a valid path
      await manager.save(memory);

      // Verify it has a path set
      expect(memory.getFilePath()).toBeDefined();

      // Modify and save again
      await memory.addEntry('Second entry', ['test']);
      await memory.save();

      // Load and verify
      const filePath = memory.getFilePath()!;
      const loaded = await manager.load(filePath);
      const entries = loaded.getAllEntries();

      expect(entries).toHaveLength(2);
    });

    it('should save updated trust levels', async () => {
      const memory = new Memory({ name: 'Test Save Trust Memory API' });
      await memory.addEntry('Test content', ['test']);

      // Save first
      await manager.save(memory);

      // Update trust level
      const allEntries = memory.getAllEntries();
      allEntries[0].trustLevel = TRUST_LEVELS.VALIDATED;

      // Save changes
      await memory.save();

      // Load and verify
      const filePath = memory.getFilePath()!;
      const loaded = await manager.load(filePath);
      const loadedEntries = loaded.getAllEntries();

      expect(loadedEntries[0].trustLevel).toBe(TRUST_LEVELS.VALIDATED);
    });
  });

  describe('Memory.findByTrustLevel()', () => {
    beforeEach(async () => {
      // Note: This test is limited because we can't easily mock MemoryManager
      // In a real integration test environment, we would set up actual memory files
    });

    it('should have the static method defined', () => {
      expect(typeof Memory.findByTrustLevel).toBe('function');
    });

    it('should accept trust level and options', async () => {
      // This is a minimal test - full integration would require file system setup
      const result = await Memory.findByTrustLevel(TRUST_LEVELS.UNTRUSTED, { limit: 10 });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Memory.find()', () => {
    it('should have the static method defined', () => {
      expect(typeof Memory.find).toBe('function');
    });

    it('should accept filter criteria', async () => {
      // Minimal test - full integration would require file system setup
      const result = await Memory.find({
        trustLevel: TRUST_LEVELS.UNTRUSTED,
        tags: ['test'],
        maxAge: 30
      });
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle empty filter', async () => {
      const result = await Memory.find({});
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('End-to-end workflow', () => {
    it('should support full validation workflow', async () => {
      // 1. Create memory with untrusted entries
      const memory = new Memory({ name: 'Workflow Test API' });
      await memory.addEntry('Content 1', ['test'], {}, 'user');
      await memory.addEntry('Content 2', ['test'], {}, 'web-scrape');
      await memory.addEntry('Content 3', ['test'], {}, 'api');

      // Save initially
      await manager.save(memory);

      // 2. Find untrusted entries (simulating BackgroundValidator)
      const untrustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      expect(untrustedEntries).toHaveLength(3);

      // 3. Update trust levels (simulating validation)
      const allEntries = memory.getAllEntries();
      allEntries[0].trustLevel = TRUST_LEVELS.VALIDATED;
      allEntries[1].trustLevel = TRUST_LEVELS.FLAGGED;
      allEntries[2].trustLevel = TRUST_LEVELS.VALIDATED;

      // 4. Save changes
      await memory.save();

      // 5. Load and verify persistence
      const filePath = memory.getFilePath()!;
      const loaded = await manager.load(filePath);
      const loadedEntries = loaded.getAllEntries();

      expect(loadedEntries[0].trustLevel).toBe(TRUST_LEVELS.VALIDATED);
      expect(loadedEntries[1].trustLevel).toBe(TRUST_LEVELS.FLAGGED);
      expect(loadedEntries[2].trustLevel).toBe(TRUST_LEVELS.VALIDATED);

      // 6. Verify query API
      const stillUntrusted = loaded.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      const validated = loaded.getEntriesByTrustLevel(TRUST_LEVELS.VALIDATED);
      const flagged = loaded.getEntriesByTrustLevel(TRUST_LEVELS.FLAGGED);

      expect(stillUntrusted).toHaveLength(0);
      expect(validated).toHaveLength(2);
      expect(flagged).toHaveLength(1);
    });
  });

  describe('Integration with MemoryManager', () => {
    it('should have file path set after loading', async () => {
      // Create and save a memory
      const memory = new Memory({ name: 'Load Test API Memory' });
      await memory.addEntry('Test content', ['test']);

      await manager.save(memory);
      const filePath = memory.getFilePath()!;

      // Load it back
      const loaded = await manager.load(filePath);

      // Verify file path is set
      expect(loaded.getFilePath()).toBeDefined();
      expect(loaded.getFilePath()).toContain('.yaml');
    });

    it('should allow save without explicit path after load', async () => {
      // Create and save
      const memory = new Memory({ name: 'Auto Save Test API Memory' });
      await memory.addEntry('Original content', ['test']);

      await manager.save(memory);
      const filePath = memory.getFilePath()!;

      // Load
      const loaded = await manager.load(filePath);

      // Modify
      await loaded.addEntry('New content', ['test']);

      // Save without path (should use stored path)
      await loaded.save();

      // Load again and verify
      const reloaded = await manager.load(filePath);
      const entries = reloaded.getAllEntries();

      expect(entries).toHaveLength(2);
      expect(entries.some(e => e.content.includes('New content'))).toBe(true);
    });
  });
});
