/**
 * Concurrent access tests for Memory element
 * Tests thread safety, race conditions, and atomic operations
 */

import { Memory } from '../../../../../src/elements/memories/Memory.js';
import { MemoryManager } from '../../../../../src/elements/memories/MemoryManager.js';
import { FileLockManager } from '../../../../../src/security/fileLockManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Memory Concurrent Access', () => {
  let memory: Memory;
  let manager: MemoryManager;
  let testDir: string;
  
  beforeAll(async () => {
    // Create test directory
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-concurrent-test-'));
    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;
    
    // Initialize manager
    manager = new MemoryManager();
    const memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });
  
  afterAll(async () => {
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
  });
  
  beforeEach(() => {
    memory = new Memory({
      name: 'Concurrent Test Memory',
      maxEntries: 100
    });
  });
  
  describe('Concurrent Entry Addition', () => {
    it('should handle concurrent addEntry calls safely', async () => {
      const numEntries = 20;
      const promises: Promise<any>[] = [];
      
      // Add entries concurrently
      for (let i = 0; i < numEntries; i++) {
        promises.push(
          memory.addEntry(`Entry ${i}`, [`tag${i}`])
        );
      }
      
      // Wait for all to complete
      const results = await Promise.all(promises);
      
      // Verify all entries were added
      expect(results).toHaveLength(numEntries);
      expect(results.every(r => r !== undefined)).toBe(true);
      
      // Check total count
      const allEntries = await memory.search({});
      expect(allEntries).toHaveLength(numEntries);
      
      // Verify each entry exists
      for (let i = 0; i < numEntries; i++) {
        const found = allEntries.find(e => e.content === `Entry ${i}`);
        expect(found).toBeDefined();
      }
    });
    
    it('should maintain max entries limit under concurrent load', async () => {
      const smallMemory = new Memory({ maxEntries: 10 });
      const numEntries = 30; // 3x the limit
      const promises: Promise<any>[] = [];
      
      // Try to add more entries than allowed
      for (let i = 0; i < numEntries; i++) {
        promises.push(
          smallMemory.addEntry(`Entry ${i}`)
            .catch(() => null) // Some may fail due to limit
        );
      }
      
      await Promise.all(promises);
      
      // Should never exceed max entries
      const entries = await smallMemory.search({});
      expect(entries.length).toBeLessThanOrEqual(10);
      expect(entries.length).toBeGreaterThan(0);
    });
  });
  
  describe('Concurrent Search Operations', () => {
    beforeEach(async () => {
      // Pre-populate with test data
      for (let i = 0; i < 50; i++) {
        await memory.addEntry(
          `Content ${i} with searchable text`,
          [`tag${i % 5}`, 'common']
        );
      }
    });
    
    it('should handle concurrent searches safely', async () => {
      const searchPromises: Promise<any>[] = [];
      
      // Different search criteria
      searchPromises.push(memory.search({ query: 'searchable' }));
      searchPromises.push(memory.search({ tags: ['common'] }));
      searchPromises.push(memory.search({ limit: 10 }));
      searchPromises.push(memory.search({ tags: ['tag1'] }));
      searchPromises.push(memory.search({})); // All entries
      
      const results = await Promise.all(searchPromises);
      
      // Verify all searches completed
      expect(results).toHaveLength(5);
      expect(results[0].length).toBeGreaterThan(0); // Query search
      expect(results[1].length).toBe(50); // Common tag
      expect(results[2].length).toBe(10); // Limited
      expect(results[3].length).toBe(10); // tag1 (50/5)
      expect(results[4].length).toBe(50); // All
    });
    
    it('should not corrupt data during concurrent read/write', async () => {
      const operations: Promise<any>[] = [];
      
      // Mix reads and writes
      for (let i = 0; i < 10; i++) {
        // Write
        operations.push(
          memory.addEntry(`New entry ${i}`, ['concurrent'])
        );
        
        // Read
        operations.push(
          memory.search({ tags: ['concurrent'] })
        );
      }
      
      await Promise.all(operations);
      
      // Verify data integrity
      const finalSearch = await memory.search({ tags: ['concurrent'] });
      expect(finalSearch.length).toBe(10);
      
      // Check for duplicates
      const contents = finalSearch.map(e => e.content);
      const uniqueContents = new Set(contents);
      expect(uniqueContents.size).toBe(contents.length);
    });
  });
  
  describe('Concurrent File Operations', () => {
    it('should handle concurrent save operations with FileLockManager', async () => {
      const fileName = 'concurrent-test.yaml';
      const savePromises: Promise<void>[] = [];
      
      // Create multiple memories to save concurrently
      for (let i = 0; i < 5; i++) {
        const mem = new Memory({ name: `Memory ${i}` });
        await mem.addEntry(`Content for memory ${i}`);
        
        savePromises.push(
          manager.save(mem, fileName)
            .catch(() => {}) // Some may fail due to lock
        );
      }
      
      await Promise.all(savePromises);
      
      // Load and verify the final state
      const loaded = await manager.load(fileName);
      expect(loaded).toBeDefined();
      expect(loaded.metadata.name).toBeDefined();
      
      // Should have entries from one of the saves
      const entries = await loaded.search({});
      expect(entries.length).toBeGreaterThan(0);
    });
    
    it('should handle concurrent load operations', async () => {
      // First save a memory
      const mem = new Memory({ name: 'Load Test' });
      await mem.addEntry('Test content');
      await manager.save(mem, 'load-test.yaml');
      
      // Now load concurrently
      const loadPromises: Promise<Memory>[] = [];
      for (let i = 0; i < 10; i++) {
        loadPromises.push(manager.load('load-test.yaml'));
      }
      
      const results = await Promise.all(loadPromises);
      
      // All should succeed and return the same data
      expect(results).toHaveLength(10);
      expect(results.every(r => r.metadata.name === 'Load Test')).toBe(true);
      
      // Should be cached (same instance)
      expect(results[0]).toBe(results[1]);
    });
  });
  
  describe('Retention Policy Under Concurrent Load', () => {
    it('should enforce retention correctly with concurrent operations', async () => {
      const retentionMemory = new Memory({
        name: 'Retention Test',
        maxEntries: 5,
        retentionDays: 1
      });
      
      const promises: Promise<any>[] = [];
      
      // Add entries and trigger retention concurrently
      for (let i = 0; i < 10; i++) {
        promises.push(retentionMemory.addEntry(`Entry ${i}`));
        if (i % 3 === 0) {
          promises.push(retentionMemory.enforceRetentionPolicy());
        }
      }
      
      await Promise.all(promises);
      
      // Should never exceed max entries
      const entries = await retentionMemory.search({});
      expect(entries.length).toBeLessThanOrEqual(5);
    });
  });
  
  describe('Concurrent Deletion', () => {
    it('should handle concurrent delete operations safely', async () => {
      // Add entries
      const entryIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const entry = await memory.addEntry(`Delete test ${i}`);
        entryIds.push(entry.id);
      }
      
      // Delete concurrently
      const deletePromises = entryIds.map(id => 
        memory.deleteEntry(id)
      );
      
      const results = await Promise.all(deletePromises);
      
      // All should succeed
      expect(results.every(r => r === true)).toBe(true);
      
      // Memory should be empty
      const remaining = await memory.search({});
      expect(remaining).toHaveLength(0);
    });
    
    it('should handle racing delete operations on same entry', async () => {
      const entry = await memory.addEntry('Race condition test');
      
      // Try to delete the same entry multiple times concurrently
      const deletePromises = new Array(5).fill(null).map(() => 
        memory.deleteEntry(entry.id)
      );
      
      const results = await Promise.all(deletePromises);
      
      // Only one should succeed
      const successCount = results.filter(r => r === true).length;
      expect(successCount).toBe(1);
      
      // Others should return false (not found)
      const failCount = results.filter(r => r === false).length;
      expect(failCount).toBe(4);
    });
  });
  
  describe('Memory Pressure and Performance', () => {
    it('should handle high concurrent load without memory leaks', async () => {
      const loadMemory = new Memory({ maxEntries: 1000 });
      const concurrentOps = 100;
      const iterations = 5;
      
      for (let iter = 0; iter < iterations; iter++) {
        const promises: Promise<any>[] = [];
        
        // High load of mixed operations
        for (let i = 0; i < concurrentOps; i++) {
          const op = i % 4;
          switch (op) {
            case 0:
              promises.push(loadMemory.addEntry(`Load test ${iter}-${i}`));
              break;
            case 1:
              promises.push(loadMemory.search({ limit: 10 }));
              break;
            case 2:
              promises.push(loadMemory.enforceRetentionPolicy());
              break;
            case 3:
              promises.push(loadMemory.getStats());
              break;
          }
        }
        
        await Promise.all(promises);
      }
      
      // Final state check
      const stats = loadMemory.getStats();
      expect(stats.totalEntries).toBeLessThanOrEqual(1000);
      expect(stats.totalSize).toBeLessThan(1024 * 1024); // Under 1MB limit
    });
  });
});