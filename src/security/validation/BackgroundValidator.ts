/**
 * Background Validation Service for Memory Security
 *
 * Part of Issue #1314 Phase 1: Memory Security Architecture
 *
 * PURPOSE:
 * Asynchronously validates UNTRUSTED memory entries and updates their trust levels
 * without blocking memory creation. Runs outside the LLM request path to avoid
 * token costs and latency.
 *
 * ARCHITECTURE:
 * - Layer 2 in the Memory Security Architecture (see docs/development/MEMORY_SECURITY_ARCHITECTURE.md)
 * - Runs server-side, not in LLM context
 * - No token cost for validation
 * - Updates trust levels in-place
 *
 * TRUST LEVEL TRANSITIONS:
 * UNTRUSTED → VALIDATED (clean content, no patterns)
 * UNTRUSTED → FLAGGED (dangerous patterns detected, needs encryption)
 * UNTRUSTED → QUARANTINED (explicitly malicious, critical threat)
 *
 * @module BackgroundValidator
 */

import { logger } from '../../utils/logger.js';
import { ContentValidator, type ContentValidationResult } from '../contentValidator.js';
import { TRUST_LEVELS } from '../../elements/memories/constants.js';
import { PatternExtractor } from './PatternExtractor.js';
import type { Memory } from '../../elements/memories/Memory.js';

/**
 * Configuration for background validation behavior
 */
export interface BackgroundValidatorConfig {
  /** Enable background validation (default: true) */
  enabled: boolean;

  /** Interval in seconds between validation runs (default: 300 = 5 minutes) */
  intervalSeconds: number;

  /** Maximum number of memories to process per batch (default: 10) */
  batchSize: number;

  /** Maximum time in ms for a single validation operation (default: 5000) */
  validationTimeoutMs: number;
}

/**
 * Default configuration for background validation
 */
const DEFAULT_CONFIG: BackgroundValidatorConfig = {
  enabled: true,
  intervalSeconds: 300,  // 5 minutes
  batchSize: 10,
  validationTimeoutMs: 5000,
};

/**
 * Pattern information for encrypted storage
 */
export interface SanitizedPattern {
  /** Unique reference ID for this pattern */
  ref: string;

  /** Human-readable description of the pattern */
  description: string;

  /** Severity level of the pattern */
  severity: 'critical' | 'high' | 'medium' | 'low';

  /** Location in original content (offset and length) */
  location: string;

  /** Encrypted pattern (AES-256-GCM) - Phase 2 */
  encryptedPattern?: string;

  /** Encryption algorithm used - Phase 2 */
  algorithm?: string;

  /** Initialization vector for decryption - Phase 2 */
  iv?: string;

  /** Safety instruction for pattern usage */
  safetyInstruction: string;
}

/**
 * Background validation service for memory entries
 *
 * This service runs outside the LLM request path to validate UNTRUSTED
 * memory entries and update their trust levels based on security analysis.
 */
export class BackgroundValidator {
  private readonly config: BackgroundValidatorConfig;
  private intervalHandle?: NodeJS.Timeout;
  private isProcessing: boolean = false;

  constructor(config?: Partial<BackgroundValidatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('BackgroundValidator initialized', {
      enabled: this.config.enabled,
      intervalSeconds: this.config.intervalSeconds,
      batchSize: this.config.batchSize,
    });
  }

  /**
   * Start the background validation service
   * Begins periodic validation of UNTRUSTED memories
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Background validation disabled in config');
      return;
    }

    if (this.intervalHandle) {
      logger.warn('Background validation already running');
      return;
    }

    logger.info('Starting background validation service', {
      intervalSeconds: this.config.intervalSeconds,
    });

    // Run immediately on start
    void this.processUntrustedMemories();

    // Then run periodically
    this.intervalHandle = setInterval(() => {
      void this.processUntrustedMemories();
    }, this.config.intervalSeconds * 1000);
  }

  /**
   * Stop the background validation service
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      logger.info('Background validation service stopped');
    }
  }

  /**
   * Process all UNTRUSTED memory entries
   * This is the main background validation loop
   */
  async processUntrustedMemories(): Promise<void> {
    if (this.isProcessing) {
      logger.debug('Validation already in progress, skipping this run');
      return;
    }

    this.isProcessing = true;

    try {
      logger.debug('Starting validation pass');

      // PHASE 1 INCOMPLETE: Memory discovery integration pending
      // Issue #1314 Phase 1 - This will be connected to Memory loading system
      // in a follow-up PR once Memory.find() API is available
      const untrustedMemories = await this.findMemoriesWithUntrustedEntries();

      if (untrustedMemories.length === 0) {
        logger.debug('No untrusted memories found');
        return;
      }

      logger.info('Found untrusted memories to validate', {
        count: untrustedMemories.length,
        batchSize: this.config.batchSize,
      });

      // Process in batches
      const batches = this.createBatches(untrustedMemories, this.config.batchSize);

      for (const batch of batches) {
        await this.processBatch(batch);
      }

      logger.info('Validation pass complete');
    } catch (error) {
      logger.error('Error during background validation', { error });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Find all memories that have UNTRUSTED entries
   *
   * FIX #1320: Now uses Memory.findByTrustLevel() API
   * Loads memories from filesystem and filters by trust level
   */
  private async findMemoriesWithUntrustedEntries(): Promise<Memory[]> {
    // FIX #1320: Use new Memory query API to find untrusted entries
    const { Memory } = await import('../../elements/memories/Memory.js');

    // Fetch multiple batches worth of memories to ensure we have work to do
    const limit = this.config.batchSize * 10;

    const untrustedMemories = await Memory.findByTrustLevel(
      TRUST_LEVELS.UNTRUSTED,
      { limit }
    );

    logger.debug('Found memories with untrusted entries', {
      count: untrustedMemories.length,
      limit
    });

    return untrustedMemories;
  }

  /**
   * Process a batch of memories for validation
   */
  private async processBatch(memories: Memory[]): Promise<void> {
    logger.debug('Processing batch', { size: memories.length });

    for (const memory of memories) {
      try {
        await this.validateMemory(memory);
      } catch (error) {
        logger.error('Error validating memory', {
          memoryId: memory.id,
          error,
        });
      }
    }
  }

  /**
   * Validate all UNTRUSTED entries in a memory
   * FIX #1320: Now uses public Memory API and saves changes
   * FIX (Claude Bot Review): Removed type casting for memory.id
   */
  private async validateMemory(memory: Memory): Promise<void> {
    logger.debug('Validating memory', { memoryId: memory.id });

    let updatedCount = 0;

    // FIX #1320: Use public API instead of casting to any
    const entries = memory.getEntriesByTrustLevel(TRUST_LEVELS.UNTRUSTED);

    for (const entry of entries) {
      try {
        const updated = await this.validateEntry(entry);
        if (updated) {
          updatedCount++;
        }
      } catch (error) {
        logger.error('Error validating entry', {
          entryId: entry.id,
          error,
        });
      }
    }

    if (updatedCount > 0) {
      logger.info('Updated trust levels in memory', {
        memoryId: memory.id,
        updatedCount,
      });

      // FIX #1320: Save memory using new instance method
      try {
        await memory.save();
        logger.debug('Memory saved successfully', {
          memoryId: memory.id
        });
      } catch (error) {
        logger.error('Failed to save memory after validation', {
          memoryId: memory.id,
          error
        });
        // Don't throw - continue with other memories
      }
    }
  }

  /**
   * Validate a single memory entry and update its trust level
   *
   * @param entry - The memory entry to validate
   * @returns true if the entry was updated, false otherwise
   */
  private async validateEntry(entry: any): Promise<boolean> {
    logger.debug('Validating entry', { entryId: entry.id });

    // Validate content using ContentValidator
    const validationResult = ContentValidator.validateAndSanitize(entry.content, {
      skipSizeCheck: true,
    });

    // Determine new trust level based on validation results
    const newTrustLevel = this.determineTrustLevel(validationResult);

    if (newTrustLevel === entry.trustLevel) {
      logger.debug('Trust level unchanged', {
        entryId: entry.id,
        trustLevel: entry.trustLevel,
      });
      return false;
    }

    // Update trust level
    entry.trustLevel = newTrustLevel;

    logger.info('Updated entry trust level', {
      entryId: entry.id,
      oldTrustLevel: TRUST_LEVELS.UNTRUSTED,
      newTrustLevel,
      detectedPatterns: validationResult.detectedPatterns?.length || 0,
    });

    // If FLAGGED, extract patterns and create sanitized content
    if (newTrustLevel === TRUST_LEVELS.FLAGGED) {
      logger.debug('Entry flagged, extracting patterns', {
        entryId: entry.id,
        patterns: validationResult.detectedPatterns,
      });

      // Phase 1: Extract patterns and create sanitized content
      const extractionResult = PatternExtractor.extractPatterns(
        entry.content,
        validationResult
      );

      // Store sanitized patterns and content in entry metadata
      // Phase 2 will add encryption to these patterns
      entry.sanitizedPatterns = extractionResult.patterns;
      entry.sanitizedContent = extractionResult.sanitizedContent;

      logger.info('Patterns extracted from entry', {
        entryId: entry.id,
        patternCount: extractionResult.patternCount,
      });
    }

    return true;
  }

  /**
   * Determine the appropriate trust level based on validation results
   */
  private determineTrustLevel(validationResult: ContentValidationResult): string {
    // If validation passed with no patterns, mark as VALIDATED
    if (validationResult.isValid && (!validationResult.detectedPatterns || validationResult.detectedPatterns.length === 0)) {
      return TRUST_LEVELS.VALIDATED;
    }

    // If critical/high severity threats detected, mark as FLAGGED
    if (validationResult.severity === 'critical' || validationResult.severity === 'high') {
      // PHASE 1 INCOMPLETE: QUARANTINED trust level logic deferred (Issue #1314)
      // Will add distinction between FLAGGED (dangerous) vs QUARANTINED (malicious)
      // For now, all high/critical severity goes to FLAGGED
      return TRUST_LEVELS.FLAGGED;
    }

    // Medium/low severity or minor issues - keep as UNTRUSTED for now
    // (Could be VALIDATED in a more lenient policy)
    return TRUST_LEVELS.UNTRUSTED;
  }

  /**
   * Split an array into batches of specified size
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Get current validation statistics
   */
  getStats() {
    return {
      enabled: this.config.enabled,
      isProcessing: this.isProcessing,
      intervalSeconds: this.config.intervalSeconds,
      batchSize: this.config.batchSize,
    };
  }
}

/**
 * Singleton instance for global use
 * Can be configured via environment variables or config file
 */
export const backgroundValidator = new BackgroundValidator();
