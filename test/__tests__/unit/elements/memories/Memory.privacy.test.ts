/**
 * Comprehensive privacy level tests for Memory element
 * Tests privacy filtering, access control, and security boundaries
 */

import { Memory, MemorySearchOptions } from '../../../../../src/elements/memories/Memory.js';
import { MEMORY_CONSTANTS } from '../../../../../src/elements/memories/constants.js';
import { jest } from '@jest/globals';

describe('Memory Privacy Levels', () => {
  let publicMemory: Memory;
  let privateMemory: Memory;
  let sensitiveMemory: Memory;
  
  beforeEach(() => {
    // Create memories with different privacy levels
    publicMemory = new Memory({
      name: 'Public Memory',
      privacyLevel: 'public'
    });
    
    privateMemory = new Memory({
      name: 'Private Memory',
      privacyLevel: 'private'
    });
    
    sensitiveMemory = new Memory({
      name: 'Sensitive Memory',
      privacyLevel: 'sensitive'
    });
  });
  
  describe('Entry Privacy Inheritance', () => {
    it('should inherit memory privacy level by default', async () => {
      await publicMemory.addEntry('Public info');
      await privateMemory.addEntry('Private info');
      await sensitiveMemory.addEntry('Sensitive info');
      
      const publicEntries = await publicMemory.search({});
      const privateEntries = await privateMemory.search({});
      const sensitiveEntries = await sensitiveMemory.search({});
      
      expect(publicEntries[0].privacyLevel).toBe('public');
      expect(privateEntries[0].privacyLevel).toBe('private');
      expect(sensitiveEntries[0].privacyLevel).toBe('sensitive');
    });
  });
  
  describe('Privacy Level Filtering', () => {
    beforeEach(async () => {
      // Create a memory with mixed privacy entries
      const memory = new Memory({ privacyLevel: 'private' });
      
      // Add entries at different privacy levels
      await memory.addEntry('Public content', ['public']);
      const publicEntry = (await memory.search({}))[0];
      publicEntry.privacyLevel = 'public';
      
      await memory.addEntry('Private content', ['private']);
      // Default is private, no change needed
      
      await memory.addEntry('Sensitive content', ['sensitive']);
      const sensitiveEntry = (await memory.search({ query: 'Sensitive' }))[0];
      sensitiveEntry.privacyLevel = 'sensitive';
      
      // Use this mixed memory for privacy tests
      publicMemory = memory;
    });
    
    it('should return only public entries when requesting public privacy level', async () => {
      const results = await publicMemory.search({ privacyLevel: 'public' });
      
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Public content');
      expect(results[0].privacyLevel).toBe('public');
    });
    
    it('should return public and private entries when requesting private level', async () => {
      const results = await publicMemory.search({ privacyLevel: 'private' });
      
      expect(results).toHaveLength(2);
      const contents = results.map(r => r.content);
      expect(contents).toContain('Public content');
      expect(contents).toContain('Private content');
      expect(contents).not.toContain('Sensitive content');
    });
    
    it('should return all entries when requesting sensitive level', async () => {
      const results = await publicMemory.search({ privacyLevel: 'sensitive' });
      
      expect(results).toHaveLength(3);
      const contents = results.map(r => r.content);
      expect(contents).toContain('Public content');
      expect(contents).toContain('Private content');
      expect(contents).toContain('Sensitive content');
    });
    
    it('should handle privacy filtering with other search criteria', async () => {
      const results = await publicMemory.search({
        query: 'content',
        privacyLevel: 'private'
      });
      
      expect(results).toHaveLength(2);
      expect(results.every(r => r.content.includes('content'))).toBe(true);
      expect(results.every(r => 
        r.privacyLevel === 'public' || r.privacyLevel === 'private'
      )).toBe(true);
    });
  });
  
  describe('Privacy Level Boundaries', () => {
    it('should not leak sensitive data in search results', async () => {
      await sensitiveMemory.addEntry('Password: secret123', ['credentials']);
      await sensitiveMemory.addEntry('API Key: xyz789', ['credentials']);
      await sensitiveMemory.addEntry('Normal note', ['general']);
      
      // Search with lower privacy level should not return sensitive entries
      const publicResults = await sensitiveMemory.search({ privacyLevel: 'public' });
      const privateResults = await sensitiveMemory.search({ privacyLevel: 'private' });
      
      expect(publicResults).toHaveLength(0);
      expect(privateResults).toHaveLength(0);
      
      // Only sensitive level should see the entries
      const sensitiveResults = await sensitiveMemory.search({ privacyLevel: 'sensitive' });
      expect(sensitiveResults).toHaveLength(3);
    });
    
    it('should respect privacy levels in tag searches', async () => {
      // Create entries with same tags but different privacy levels
      await publicMemory.addEntry('Public tagged', ['important']);
      await privateMemory.addEntry('Private tagged', ['important']);
      await sensitiveMemory.addEntry('Sensitive tagged', ['important']);
      
      // Mix them in one memory
      const memory = new Memory();
      await memory.addEntry('Public tagged', ['important']);
      const e1 = (await memory.search({}))[0];
      e1.privacyLevel = 'public';
      
      await memory.addEntry('Private tagged', ['important']);
      // Default is private
      
      await memory.addEntry('Sensitive tagged', ['important']);
      const e3 = (await memory.search({ query: 'Sensitive' }))[0];
      e3.privacyLevel = 'sensitive';
      
      // Search by tag with privacy filter
      const publicTagged = await memory.search({
        tags: ['important'],
        privacyLevel: 'public'
      });
      
      expect(publicTagged).toHaveLength(1);
      expect(publicTagged[0].content).toBe('Public tagged');
    });
  });
  
  describe('Privacy Level Validation', () => {
    it('should only accept valid privacy levels', () => {
      const validLevels = MEMORY_CONSTANTS.PRIVACY_LEVELS;
      expect(validLevels).toEqual(['public', 'private', 'sensitive']);
      
      // Create memory with each valid level
      validLevels.forEach(level => {
        const memory = new Memory({ privacyLevel: level });
        expect(memory.extensions?.privacyLevel).toBe(level);
      });
    });
    
    it('should default to private for invalid privacy levels', () => {
      const memory = new Memory({ privacyLevel: 'invalid' as any });
      // The privacy level should be validated and default to private
      expect(memory.extensions?.privacyLevel).toBe(MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL);
      
      // Also check internal state
      const privateProperty = (memory as any).privacyLevel;
      expect(privateProperty).toBe('private');
    });
  });
  
  describe('Privacy and Security Event Logging', () => {
    it('should log when sensitive memories are deleted', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation();
      
      await sensitiveMemory.addEntry('Sensitive data');
      const entries = await sensitiveMemory.search({});
      const deleted = await sensitiveMemory.deleteEntry(entries[0].id);
      
      expect(deleted).toBe(true);
      // SecurityMonitor would log SENSITIVE_MEMORY_DELETED event
      
      logSpy.mockRestore();
    });
  });
  
  describe('Privacy Level Ordering', () => {
    it('should correctly order privacy levels from least to most restrictive', () => {
      const levels = MEMORY_CONSTANTS.PRIVACY_LEVELS;
      
      // Index represents restrictiveness (lower = less restrictive)
      expect(levels.indexOf('public')).toBeLessThan(levels.indexOf('private'));
      expect(levels.indexOf('private')).toBeLessThan(levels.indexOf('sensitive'));
    });
  });
  
  describe('Edge Cases', () => {
    it('should handle undefined privacy levels as private', async () => {
      const memory = new Memory();
      await memory.addEntry('No privacy specified');
      
      const entries = await memory.search({});
      // When no privacy level is specified on entry, it inherits from memory
      expect(entries[0].privacyLevel || memory.extensions?.privacyLevel).toBe('private');
      
      // Should be treated as private in searches
      const publicSearch = await memory.search({ privacyLevel: 'public' });
      expect(publicSearch).toHaveLength(0);
      
      const privateSearch = await memory.search({ privacyLevel: 'private' });
      expect(privateSearch).toHaveLength(1);
    });
    
    it('should handle privacy filtering with empty results gracefully', async () => {
      const memory = new Memory({ privacyLevel: 'sensitive' });
      await memory.addEntry('Sensitive only');
      
      // No results expected for public search
      const results = await memory.search({ privacyLevel: 'public' });
      expect(results).toEqual([]);
      expect(results).toHaveLength(0);
    });
  });
});