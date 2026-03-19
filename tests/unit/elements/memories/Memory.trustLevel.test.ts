/**
 * Unit tests for Memory Trust Level functionality
 *
 * Tests the trust level system added in v1.9.18-v1.9.24 merge:
 * - Trust level assignment on entry creation
 * - getEntriesByTrustLevel() filtering
 * - Trust level constants and types
 *
 * Part of Issue #1314 Phase 1: Memory Security Architecture
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

// Create a shared MetadataService instance for all tests
const metadataService = createTestMetadataService();
import { TRUST_LEVELS } from '../../../../src/elements/memories/constants.js';
import type { TrustLevel } from '../../../../src/elements/memories/constants.js';

describe('Memory Trust Levels', () => {
  let memory: Memory;

  beforeEach(() => {
    memory = new Memory({
      name: 'Trust Level Test Memory',
      description: 'Testing trust level functionality'
    }, metadataService);
  });

  describe('Trust Level Constants', () => {
    it('should define all trust level constants', () => {
      expect(TRUST_LEVELS.UNTRUSTED).toBe('untrusted');
      expect(TRUST_LEVELS.VALIDATED).toBe('validated');
      expect(TRUST_LEVELS.TRUSTED).toBe('trusted');
      expect(TRUST_LEVELS.FLAGGED).toBe('flagged');
      expect(TRUST_LEVELS.QUARANTINED).toBe('quarantined');
    });

    it('should have exactly 5 trust levels', () => {
      const levels = Object.keys(TRUST_LEVELS);
      expect(levels).toHaveLength(5);
    });
  });

  describe('Entry Trust Level Assignment', () => {
    it('should assign UNTRUSTED trust level to new entries by default', async () => {
      const entry = await memory.addEntry('Test content');

      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
    });

    it('should assign UNTRUSTED to entries with potential security risks', async () => {
      const riskyContent = 'eval(malicious.code())';
      const entry = await memory.addEntry(riskyContent);

      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
    });

    it('should assign UNTRUSTED to entries with Unicode attacks', async () => {
      const unicodeAttack = '\u202E\u202D\u202Ctest'; // Direction override
      const entry = await memory.addEntry(unicodeAttack);

      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
    });

    it('should assign UNTRUSTED to large entries', async () => {
      const hugeContent = 'x'.repeat(100 * 1024); // 100KB
      const entry = await memory.addEntry(hugeContent);

      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
    });

    it('should assign UNTRUSTED to all entries regardless of content safety', async () => {
      // All new entries start as untrusted until validated
      const safeContent = 'This is perfectly safe content';
      const entry = await memory.addEntry(safeContent);

      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
    });
  });

  describe('getEntriesByTrustLevel', () => {
    beforeEach(async () => {
      // Add entries with different trust levels (all will be UNTRUSTED by default)
      await memory.addEntry('Entry 1');
      await memory.addEntry('Entry 2');
      await memory.addEntry('Entry 3');
    });

    it('should filter entries by UNTRUSTED trust level', () => {
      const untrustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      expect(untrustedEntries).toHaveLength(3);
      untrustedEntries.forEach(entry => {
        expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
      });
    });

    it('should return empty array for trust levels with no entries', () => {
      const validatedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.VALIDATED);
      const trustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.TRUSTED);
      const flaggedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.FLAGGED);
      const quarantinedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.QUARANTINED);

      expect(validatedEntries).toHaveLength(0);
      expect(trustedEntries).toHaveLength(0);
      expect(flaggedEntries).toHaveLength(0);
      expect(quarantinedEntries).toHaveLength(0);
    });

    it('should only return entries matching the specified trust level', () => {
      const entries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      // All entries should be UNTRUSTED
      expect(entries.every(e => e.trustLevel === TRUST_LEVELS.UNTRUSTED)).toBe(true);

      // None should be other trust levels
      expect(entries.some(e => e.trustLevel === TRUST_LEVELS.VALIDATED)).toBe(false);
      expect(entries.some(e => e.trustLevel === TRUST_LEVELS.TRUSTED)).toBe(false);
      expect(entries.some(e => e.trustLevel === TRUST_LEVELS.FLAGGED)).toBe(false);
      expect(entries.some(e => e.trustLevel === TRUST_LEVELS.QUARANTINED)).toBe(false);
    });

    it('should handle empty memory', () => {
      const emptyMemory = new Memory({
        name: 'Empty Memory',
        description: 'No entries'
      }, metadataService);

      const entries = emptyMemory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      expect(entries).toHaveLength(0);
    });
  });

  describe('Trust Level Workflow', () => {
    it('should support the intended trust level lifecycle', async () => {
      // Phase 1: All entries start as UNTRUSTED
      const entry = await memory.addEntry('New content');
      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);

      // Phase 2: BackgroundValidator would transition to VALIDATED/FLAGGED/QUARANTINED
      // (This is tested in BackgroundValidator.test.ts)

      // Phase 3: User can manually mark as TRUSTED
      // (Future feature - currently all entries are UNTRUSTED by default)

      // Verify we can query by trust level
      const untrustedEntries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      expect(untrustedEntries).toContain(entry);
    });

    it('should maintain trust level through memory operations', async () => {
      const entry = await memory.addEntry('Test content');
      const initialTrustLevel = entry.trustLevel;

      // Trust level should persist
      expect(initialTrustLevel).toBe(TRUST_LEVELS.UNTRUSTED);

      // Verify through getEntriesByTrustLevel
      const entries = memory.getEntriesByTrustLevel(initialTrustLevel as TrustLevel);
      expect(entries).toContainEqual(expect.objectContaining({
        id: entry.id,
        trustLevel: initialTrustLevel
      }));
    });
  });

  describe('Multiple Trust Levels', () => {
    it('should handle memory with entries at different trust levels (future)', async () => {
      // Currently all entries are UNTRUSTED, but the architecture supports multiple levels
      await memory.addEntry('Entry 1');
      await memory.addEntry('Entry 2');
      await memory.addEntry('Entry 3');

      const untrusted = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      // All should be UNTRUSTED for now
      expect(untrusted).toHaveLength(3);

      // When trust level transitions are implemented, we would test:
      // - Some entries UNTRUSTED
      // - Some entries VALIDATED
      // - Some entries FLAGGED
      // - Some entries QUARANTINED
      // - Some entries TRUSTED
    });
  });

  describe('Edge Cases', () => {
    it('should handle getting entries by trust level on memory with no entries', () => {
      const emptyMemory = new Memory({
        name: 'Empty',
        description: 'No entries'
      }, metadataService);

      Object.values(TRUST_LEVELS).forEach(level => {
        const entries = emptyMemory.getEntriesByTrustLevel(level as TrustLevel);
        expect(entries).toHaveLength(0);
        expect(Array.isArray(entries)).toBe(true);
      });
    });

    it('should not mutate the original entries array', async () => {
      await memory.addEntry('Entry 1');
      await memory.addEntry('Entry 2');

      const entries1 = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      const entries2 = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      // Should return separate arrays
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });

    it('should handle sequential trust level queries', async () => {
      await memory.addEntry('Entry 1');
      await memory.addEntry('Entry 2');

      // Multiple queries should return consistent results
      const query1 = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      const query2 = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);
      const query3 = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

      expect(query1).toEqual(query2);
      expect(query2).toEqual(query3);
    });
  });
});
