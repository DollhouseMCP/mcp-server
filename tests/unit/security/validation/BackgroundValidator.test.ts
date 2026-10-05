/**
 * Tests for BackgroundValidator
 *
 * Part of Issue #1314 Phase 1: Memory Security Architecture
 * DI REFACTOR: Adapted for instance-based architecture
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { BackgroundValidator } from '../../../../src/security/validation/BackgroundValidator.js';
import { PatternExtractor } from '../../../../src/security/validation/PatternExtractor.js';
import { PatternEncryptor } from '../../../../src/security/encryption/PatternEncryptor.js';
import { TRUST_LEVELS } from '../../../../src/elements/memories/constants.js';
import { logger } from '../../../../src/utils/logger.js';

describe('BackgroundValidator', () => {
  let validator: BackgroundValidator;
  let patternExtractor: PatternExtractor;
  let encryptor: PatternEncryptor;
  let mockMemoryManager: any;

  beforeEach(async () => {
    // Create mock memory manager
    mockMemoryManager = {
      isGuardedHeadUpdateEnabled: () => false,
      findMemoriesWithUntrustedEntries: () => [],
      updateMemory: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      save: () => Promise.resolve(),
    };

    // Create dependencies
    encryptor = new PatternEncryptor();
    await encryptor.initialize({
      enabled: true,
      secret: 'test-secret-for-background-validation',
    });

    patternExtractor = new PatternExtractor(encryptor);

    // Create validator with dependencies
    validator = new BackgroundValidator(
      patternExtractor,
      mockMemoryManager,
      {
        enabled: false, // Disable auto-start for tests
        intervalSeconds: 60,
        batchSize: 5,
      }
    );
  });

  afterEach(() => {
    validator.stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('guarded background validation refusal', () => {
    function untrustedSource() {
      const entry = { id: 'retained-entry', content: 'Ordinary clean prose', trustLevel: TRUST_LEVELS.UNTRUSTED };
      const memory = { id: 'cached-unbound-memory', getEntriesByTrustLevel: () => [entry] };
      mockMemoryManager.list = jest.fn(async () => [memory]);
      mockMemoryManager.save = jest.fn(async () => {});
      return entry;
    }

    it('refuses before mutating a cached unbound source or trying its save', async () => {
      const entry = untrustedSource();
      mockMemoryManager.isGuardedHeadUpdateEnabled = () => true;
      mockMemoryManager.save = jest.fn(async () => { throw new Error('No captured ownership'); });
      const before = structuredClone(entry);
      const info = jest.spyOn(logger, 'info');
      const debug = jest.spyOn(logger, 'debug');
      const error = jest.spyOn(logger, 'error');
      const extract = jest.spyOn(patternExtractor, 'extractPatterns');
      await validator.processUntrustedMemories();
      expect({ list: mockMemoryManager.list.mock.calls.length, save: mockMemoryManager.save.mock.calls.length, entry })
        .toEqual({ list: 0, save: 0, entry: before });
      expect(extract).not.toHaveBeenCalled();
      expect(info.mock.calls.map(call => call[0])).not.toContain('Updated trust levels in memory');
      expect(info.mock.calls.map(call => call[0])).not.toContain('Validation pass complete');
      expect(debug.mock.calls.map(call => call[0])).not.toContain('Memory saved successfully');
      expect(error).toHaveBeenCalledWith('Error during background validation', {
        error: expect.objectContaining({ message: 'Background validation is unavailable for guarded memory updates; no entries were processed.' }),
      });
      expect(validator.getStats().isProcessing).toBe(false);
    });

    it('contains a selection probe error and refuses before discovery', async () => {
      const entry = untrustedSource();
      const cause = new Error('Selection unavailable');
      mockMemoryManager.isGuardedHeadUpdateEnabled = jest.fn(() => { throw cause; });
      const error = jest.spyOn(logger, 'error');
      await validator.processUntrustedMemories();
      expect(mockMemoryManager.isGuardedHeadUpdateEnabled).toHaveBeenCalledTimes(1);
      expect(mockMemoryManager.list).not.toHaveBeenCalled();
      expect(mockMemoryManager.save).not.toHaveBeenCalled();
      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
      expect(error).toHaveBeenCalledWith('Error during background validation', { error: cause });
      expect(validator.getStats().isProcessing).toBe(false);
    });

    it('fails closed when a test double lacks the required selection API', async () => {
      const entry = untrustedSource();
      delete mockMemoryManager.isGuardedHeadUpdateEnabled;
      const error = jest.spyOn(logger, 'error');
      await validator.processUntrustedMemories();
      expect(mockMemoryManager.list).not.toHaveBeenCalled();
      expect(mockMemoryManager.save).not.toHaveBeenCalled();
      expect(entry.trustLevel).toBe(TRUST_LEVELS.UNTRUSTED);
      expect(error).toHaveBeenCalledWith('Error during background validation', { error: expect.any(TypeError) });
      expect(validator.getStats().isProcessing).toBe(false);
    });

    it('keeps the ordinary false-selection validation and save pipeline', async () => {
      const entry = untrustedSource();
      await validator.processUntrustedMemories();
      expect(mockMemoryManager.list).toHaveBeenCalledTimes(1);
      expect(entry.trustLevel).toBe(TRUST_LEVELS.VALIDATED);
      expect(mockMemoryManager.save).toHaveBeenCalledTimes(1);
    });

    it('preserves enabled timer and stop behavior while each guarded pass refuses', async () => {
      jest.useFakeTimers();
      untrustedSource();
      const probe = jest.fn(() => true);
      mockMemoryManager.isGuardedHeadUpdateEnabled = probe;
      const enabled = new BackgroundValidator(patternExtractor, mockMemoryManager, { intervalSeconds: 60 });
      try {
        enabled.start();
        expect(probe).toHaveBeenCalledTimes(1);
        enabled.start();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(mockMemoryManager.list).not.toHaveBeenCalled();
        expect(mockMemoryManager.save).not.toHaveBeenCalled();
        expect(enabled.getStats().isProcessing).toBe(false);
        enabled.stop();
        await jest.advanceTimersByTimeAsync(60_000);
        expect(probe).toHaveBeenCalledTimes(2);
      } finally { enabled.stop(); }
    });

    it('checks selection again before a later scheduled pass', async () => {
      jest.useFakeTimers();
      let guarded = false;
      mockMemoryManager.isGuardedHeadUpdateEnabled = () => guarded;
      mockMemoryManager.list = jest.fn(async () => []);
      const enabled = new BackgroundValidator(patternExtractor, mockMemoryManager, { intervalSeconds: 60 });
      try {
        enabled.start();
        await jest.advanceTimersByTimeAsync(0);
        expect(mockMemoryManager.list).toHaveBeenCalledTimes(1);
        guarded = true;
        await jest.advanceTimersByTimeAsync(60_000);
        expect(mockMemoryManager.list).toHaveBeenCalledTimes(1);
        expect(enabled.getStats().isProcessing).toBe(false);
      } finally { enabled.stop(); }
    });
  });

  describe('Service Lifecycle', () => {
    it('should initialize with correct config', () => {
      const stats = validator.getStats();

      expect(stats.enabled).toBe(false);
      expect(stats.intervalSeconds).toBe(60);
      expect(stats.batchSize).toBe(5);
      expect(stats.isProcessing).toBe(false);
    });

    it('should not start when disabled in config', () => {
      validator.start();
      const stats = validator.getStats();

      expect(stats.isProcessing).toBe(false);
    });

    it('should start and stop successfully when enabled', () => {
      const enabledValidator = new BackgroundValidator(
        patternExtractor,
        mockMemoryManager,
        {
          enabled: true,
          intervalSeconds: 300,
        }
      );

      enabledValidator.start();
      enabledValidator.stop();

      expect(true).toBe(true); // Should not throw
    });
  });

  describe('Configuration', () => {
    it('should use default configuration when not provided', () => {
      const defaultValidator = new BackgroundValidator(
        patternExtractor,
        mockMemoryManager
      );
      const stats = defaultValidator.getStats();

      expect(stats.enabled).toBe(true);
      expect(stats.intervalSeconds).toBe(300);
      expect(stats.batchSize).toBe(10);
    });

    it('should merge partial configuration with defaults', () => {
      const partialValidator = new BackgroundValidator(
        patternExtractor,
        mockMemoryManager,
        {
          batchSize: 20,
        }
      );
      const stats = partialValidator.getStats();

      expect(stats.batchSize).toBe(20);
      expect(stats.enabled).toBe(true); // Default
      expect(stats.intervalSeconds).toBe(300); // Default
    });
  });

  describe('Trust Level Determination', () => {
    it('should mark clean content as VALIDATED', async () => {
      // This test validates the trust level determination logic
      // by checking that the validator processes untrusted memories correctly

      // For Phase 1, this is a placeholder test
      // Phase 1 implementation doesn't actually process memories yet
      // (findMemoriesWithUntrustedEntries returns empty array)

      await validator.processUntrustedMemories();

      // Should complete without errors
      expect(true).toBe(true);
    });

    it.each([
      "require('child_process')",
      '!!python/object',
    ])('should flag YAML-only content pattern %s instead of promoting it', async (content) => {
      const entry = {
        id: 'yaml-pattern-entry',
        content,
        trustLevel: TRUST_LEVELS.UNTRUSTED,
      };
      const memory = {
        id: 'yaml-pattern-memory',
        getEntriesByTrustLevel: () => [entry],
      };
      mockMemoryManager.list = () => Promise.resolve([memory]);

      await validator.processUntrustedMemories();

      expect(entry.trustLevel).toBe(TRUST_LEVELS.FLAGGED);
      expect(entry.sanitizedContent).toBe('[CONTENT_BLOCKED]');
    });
  });

  describe('Batch Processing', () => {
    it('should handle empty memory list', async () => {
      // Process empty list should complete successfully
      await validator.processUntrustedMemories();

      const stats = validator.getStats();
      expect(stats.isProcessing).toBe(false);
    });

    it('should not start processing if already processing', async () => {
      // Start first process
      const firstProcess = validator.processUntrustedMemories();

      // Try to start second process (should be skipped)
      const secondProcess = validator.processUntrustedMemories();

      await Promise.all([firstProcess, secondProcess]);

      // Both should complete without errors
      expect(true).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should return current statistics', () => {
      const stats = validator.getStats();

      expect(stats).toHaveProperty('enabled');
      expect(stats).toHaveProperty('isProcessing');
      expect(stats).toHaveProperty('intervalSeconds');
      expect(stats).toHaveProperty('batchSize');
    });

    it('should reflect processing state', async () => {
      const stats = validator.getStats();
      expect(stats.isProcessing).toBe(false);

      // After processing completes, should return to false
      await validator.processUntrustedMemories();
      const statsAfter = validator.getStats();
      expect(statsAfter.isProcessing).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle processing errors gracefully', async () => {
      // Process should handle errors without crashing
      await expect(validator.processUntrustedMemories()).resolves.not.toThrow();
    });
  });
});

describe('BackgroundValidator Integration', () => {
  describe('Trust Level Transitions', () => {
    it('should transition UNTRUSTED to VALIDATED for clean content', () => {
      // Placeholder for Phase 1
      // Full integration test will be added when memory loading is implemented
      expect(TRUST_LEVELS.UNTRUSTED).toBe('untrusted');
      expect(TRUST_LEVELS.VALIDATED).toBe('validated');
    });

    it('should transition UNTRUSTED to FLAGGED for dangerous content', () => {
      // Placeholder for Phase 1
      expect(TRUST_LEVELS.UNTRUSTED).toBe('untrusted');
      expect(TRUST_LEVELS.FLAGGED).toBe('flagged');
    });

    it('should transition UNTRUSTED to QUARANTINED for malicious content', () => {
      // Placeholder for Phase 1
      expect(TRUST_LEVELS.UNTRUSTED).toBe('untrusted');
      expect(TRUST_LEVELS.QUARANTINED).toBe('quarantined');
    });
  });
});

// DI REFACTOR: Singleton test removed - BackgroundValidator is now managed by DI Container
// The singleton pattern was replaced with proper dependency injection in the refactor
// Integration tests should use the DI Container to get the instance instead
