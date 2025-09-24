/**
 * Configuration for Enhanced Index system
 *
 * Centralizes all tunable parameters for the index, NLP scoring,
 * and relationship discovery systems.
 *
 * FIXES IMPLEMENTED (Issue #1100):
 * - Added all magic numbers from Enhanced Index to configuration
 * - Centralized thresholds, limits, and timeouts
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger.js';

export interface IndexConfiguration {
  // Index Management
  index: {
    ttlMinutes: number;                    // Cache TTL for index (default: 5)
    rebuildOnStartup: boolean;             // Force rebuild on startup (default: false)
    persistToDisk: boolean;                // Save index to disk (default: true)
    lockTimeoutMs: number;                 // File lock timeout (default: 5000)
    maxConcurrentBuilds: number;           // Max concurrent builds (default: 1)
  };

  // Performance Limits
  performance: {
    maxElementsForFullMatrix: number;      // Max elements for full similarity matrix (default: 100)
    maxSimilarityComparisons: number;      // Max total comparisons (default: 10000)
    maxRelationshipComparisons: number;    // Max comparisons for relationship discovery (default: 100)
    similarityBatchSize: number;           // Batch size for async processing (default: 50)
    similarityThreshold: number;           // Min score to store relationship (default: 0.5)
    defaultSimilarityThreshold: number;    // Default similarity threshold for queries (default: 0.3)
    defaultSimilarLimit: number;           // Default limit for similar elements (default: 5)
    defaultVerbSearchLimit: number;        // Default limit for verb search (default: 10)
    parallelProcessing: boolean;           // Use parallel processing (default: true)
    circuitBreakerTimeoutMs: number;       // Circuit breaker timeout (default: 5000)
  };

  // Sampling Configuration
  sampling: {
    baseSampleSize: number;                // Base sample size for relationships (default: 10)
    sampleRatio: number;                   // Sample ratio for large datasets (default: 0.1)
    clusterSampleLimit: number;            // Max sample size within clusters (default: 20)
  };

  // NLP Scoring
  nlp: {
    cacheExpiryMinutes: number;           // NLP cache expiry (default: 5)
    minTokenLength: number;               // Min token length (default: 2)
    entropyBands: {
      low: number;                        // Low entropy threshold (default: 3.0)
      moderate: number;                   // Moderate entropy (default: 4.5)
      high: number;                       // High entropy (default: 6.0)
    };
    jaccardThresholds: {
      low: number;                        // Low similarity (default: 0.2)
      moderate: number;                   // Moderate similarity (default: 0.4)
      high: number;                       // High similarity (default: 0.6)
    };
  };

  // Verb Triggers
  verbs: {
    confidenceThreshold: number;          // Min confidence for verb match (default: 0.5)
    maxRecursionDepth: number;            // Max synonym recursion depth (default: 3)
    maxElementsPerVerb: number;           // Max elements per verb (default: 10)
    includeSynonyms: boolean;             // Include synonym expansion (default: true)
  };

  // Memory Management
  memory: {
    maxCacheSize: number;                 // Max cache entries (default: 1000)
    enableGarbageCollection: boolean;     // Enable periodic GC (default: true)
    gcIntervalMinutes: number;            // GC interval (default: 30)
    cleanupIntervalMinutes: number;       // Memory cleanup interval (default: 5)
    staleIndexMultiplier: number;         // Multiplier for stale index cleanup (default: 2)
  };
}

export class IndexConfigManager {
  private static instance: IndexConfigManager | null = null;
  private config: IndexConfiguration;
  private configPath: string;
  private defaultConfig: IndexConfiguration = {
    index: {
      ttlMinutes: 5,
      rebuildOnStartup: false,
      persistToDisk: true,
      lockTimeoutMs: 5000,
      maxConcurrentBuilds: 1
    },
    performance: {
      maxElementsForFullMatrix: 100,
      maxSimilarityComparisons: 10000,
      maxRelationshipComparisons: 100,
      similarityBatchSize: 50,
      similarityThreshold: 0.5,
      defaultSimilarityThreshold: 0.3,
      defaultSimilarLimit: 5,
      defaultVerbSearchLimit: 10,
      parallelProcessing: true,
      circuitBreakerTimeoutMs: 5000
    },
    sampling: {
      baseSampleSize: 10,
      sampleRatio: 0.1,
      clusterSampleLimit: 20
    },
    nlp: {
      cacheExpiryMinutes: 5,
      minTokenLength: 2,
      entropyBands: {
        low: 3.0,
        moderate: 4.5,
        high: 6.0
      },
      jaccardThresholds: {
        low: 0.2,
        moderate: 0.4,
        high: 0.6
      }
    },
    verbs: {
      confidenceThreshold: 0.5,
      maxRecursionDepth: 3,
      maxElementsPerVerb: 10,
      includeSynonyms: true
    },
    memory: {
      maxCacheSize: 1000,
      enableGarbageCollection: true,
      gcIntervalMinutes: 30,
      cleanupIntervalMinutes: 5,
      staleIndexMultiplier: 2
    }
  };

  private constructor() {
    const portfolioPath = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
    this.configPath = path.join(portfolioPath, '.config', 'index-config.json');
    this.config = { ...this.defaultConfig };
    // FIX: Race condition - loadConfig is async but called sync in constructor
    // Now using synchronous loading in constructor
    this.loadConfigSync();
  }

  public static getInstance(): IndexConfigManager {
    if (!this.instance) {
      this.instance = new IndexConfigManager();
    }
    return this.instance;
  }

  /**
   * Load configuration from disk synchronously (for constructor)
   */
  private loadConfigSync(): void {
    try {
      // Check if file exists
      if (!fsSync.existsSync(this.configPath)) {
        logger.info('No config file found, using defaults', { path: this.configPath });
        return;
      }

      const configData = fsSync.readFileSync(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(configData);

      // Deep merge with defaults to handle missing fields
      // FIX: Loaded config should override defaults
      this.config = this.deepMerge(this.defaultConfig, loadedConfig);

      logger.info('Index configuration loaded', { path: this.configPath });
    } catch (error) {
      logger.warn('Failed to load index config, using defaults', {
        error: error instanceof Error ? error.message : String(error),
        path: this.configPath
      });
    }
  }


  /**
   * Save current configuration to disk
   */
  public async saveConfig(): Promise<void> {
    try {
      const configDir = path.dirname(this.configPath);
      await fs.mkdir(configDir, { recursive: true });

      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );

      logger.debug('Index configuration saved', { path: this.configPath });
    } catch (error) {
      logger.error('Failed to save index config', { error });
    }
  }

  /**
   * Get the current configuration
   */
  public getConfig(): IndexConfiguration {
    return { ...this.config };
  }

  /**
   * Update configuration with validation
   */
  public async updateConfig(updates: Partial<IndexConfiguration>): Promise<void> {
    // Validate the updates before applying
    this.validateConfig(updates);

    this.config = this.deepMerge(this.config, updates);
    await this.saveConfig();

    logger.info('Index configuration updated', { updates });
  }

  /**
   * Validate configuration values
   * Throws an error if any value is invalid
   */
  private validateConfig(config: Partial<IndexConfiguration>): void {
    // Validate performance thresholds (0-1 range)
    if (config.performance) {
      const perf = config.performance;

      // Similarity thresholds must be between 0 and 1
      if (perf.similarityThreshold !== undefined) {
        if (perf.similarityThreshold < 0 || perf.similarityThreshold > 1) {
          throw new Error(`similarityThreshold must be between 0 and 1, got ${perf.similarityThreshold}`);
        }
      }

      if (perf.defaultSimilarityThreshold !== undefined) {
        if (perf.defaultSimilarityThreshold < 0 || perf.defaultSimilarityThreshold > 1) {
          throw new Error(`defaultSimilarityThreshold must be between 0 and 1, got ${perf.defaultSimilarityThreshold}`);
        }
      }

      // Positive integer validations
      if (perf.maxElementsForFullMatrix !== undefined && perf.maxElementsForFullMatrix <= 0) {
        throw new Error(`maxElementsForFullMatrix must be positive, got ${perf.maxElementsForFullMatrix}`);
      }

      if (perf.maxSimilarityComparisons !== undefined && perf.maxSimilarityComparisons <= 0) {
        throw new Error(`maxSimilarityComparisons must be positive, got ${perf.maxSimilarityComparisons}`);
      }

      if (perf.maxRelationshipComparisons !== undefined && perf.maxRelationshipComparisons <= 0) {
        throw new Error(`maxRelationshipComparisons must be positive, got ${perf.maxRelationshipComparisons}`);
      }

      if (perf.similarityBatchSize !== undefined && perf.similarityBatchSize <= 0) {
        throw new Error(`similarityBatchSize must be positive, got ${perf.similarityBatchSize}`);
      }

      if (perf.defaultSimilarLimit !== undefined && perf.defaultSimilarLimit <= 0) {
        throw new Error(`defaultSimilarLimit must be positive, got ${perf.defaultSimilarLimit}`);
      }

      if (perf.defaultVerbSearchLimit !== undefined && perf.defaultVerbSearchLimit <= 0) {
        throw new Error(`defaultVerbSearchLimit must be positive, got ${perf.defaultVerbSearchLimit}`);
      }

      if (perf.circuitBreakerTimeoutMs !== undefined && perf.circuitBreakerTimeoutMs <= 0) {
        throw new Error(`circuitBreakerTimeoutMs must be positive, got ${perf.circuitBreakerTimeoutMs}`);
      }
    }

    // Validate sampling configuration
    if (config.sampling) {
      const sampling = config.sampling;

      // Sample ratio must be between 0 and 1
      if (sampling.sampleRatio !== undefined) {
        if (sampling.sampleRatio <= 0 || sampling.sampleRatio > 1) {
          throw new Error(`sampleRatio must be between 0 and 1, got ${sampling.sampleRatio}`);
        }
      }

      if (sampling.baseSampleSize !== undefined && sampling.baseSampleSize <= 0) {
        throw new Error(`baseSampleSize must be positive, got ${sampling.baseSampleSize}`);
      }

      if (sampling.clusterSampleLimit !== undefined && sampling.clusterSampleLimit <= 0) {
        throw new Error(`clusterSampleLimit must be positive, got ${sampling.clusterSampleLimit}`);
      }
    }

    // Validate NLP configuration
    if (config.nlp) {
      const nlp = config.nlp;

      // Jaccard thresholds must be between 0 and 1
      if (nlp.jaccardThresholds) {
        const jaccard = nlp.jaccardThresholds;
        if (jaccard.low !== undefined && (jaccard.low < 0 || jaccard.low > 1)) {
          throw new Error(`jaccardThresholds.low must be between 0 and 1, got ${jaccard.low}`);
        }
        if (jaccard.moderate !== undefined && (jaccard.moderate < 0 || jaccard.moderate > 1)) {
          throw new Error(`jaccardThresholds.moderate must be between 0 and 1, got ${jaccard.moderate}`);
        }
        if (jaccard.high !== undefined && (jaccard.high < 0 || jaccard.high > 1)) {
          throw new Error(`jaccardThresholds.high must be between 0 and 1, got ${jaccard.high}`);
        }
      }

      // Entropy bands must be positive
      if (nlp.entropyBands) {
        const entropy = nlp.entropyBands;
        if (entropy.low !== undefined && entropy.low < 0) {
          throw new Error(`entropyBands.low must be non-negative, got ${entropy.low}`);
        }
        if (entropy.moderate !== undefined && entropy.moderate < 0) {
          throw new Error(`entropyBands.moderate must be non-negative, got ${entropy.moderate}`);
        }
        if (entropy.high !== undefined && entropy.high < 0) {
          throw new Error(`entropyBands.high must be non-negative, got ${entropy.high}`);
        }
      }

      if (nlp.cacheExpiryMinutes !== undefined && nlp.cacheExpiryMinutes <= 0) {
        throw new Error(`cacheExpiryMinutes must be positive, got ${nlp.cacheExpiryMinutes}`);
      }

      if (nlp.minTokenLength !== undefined && nlp.minTokenLength < 1) {
        throw new Error(`minTokenLength must be at least 1, got ${nlp.minTokenLength}`);
      }
    }

    // Validate verb configuration
    if (config.verbs) {
      const verbs = config.verbs;

      if (verbs.confidenceThreshold !== undefined) {
        if (verbs.confidenceThreshold < 0 || verbs.confidenceThreshold > 1) {
          throw new Error(`confidenceThreshold must be between 0 and 1, got ${verbs.confidenceThreshold}`);
        }
      }

      if (verbs.maxRecursionDepth !== undefined && verbs.maxRecursionDepth <= 0) {
        throw new Error(`maxRecursionDepth must be positive, got ${verbs.maxRecursionDepth}`);
      }

      if (verbs.maxElementsPerVerb !== undefined && verbs.maxElementsPerVerb <= 0) {
        throw new Error(`maxElementsPerVerb must be positive, got ${verbs.maxElementsPerVerb}`);
      }
    }

    // Validate memory configuration
    if (config.memory) {
      const memory = config.memory;

      if (memory.maxCacheSize !== undefined && memory.maxCacheSize <= 0) {
        throw new Error(`maxCacheSize must be positive, got ${memory.maxCacheSize}`);
      }

      if (memory.gcIntervalMinutes !== undefined && memory.gcIntervalMinutes <= 0) {
        throw new Error(`gcIntervalMinutes must be positive, got ${memory.gcIntervalMinutes}`);
      }

      if (memory.cleanupIntervalMinutes !== undefined && memory.cleanupIntervalMinutes <= 0) {
        throw new Error(`cleanupIntervalMinutes must be positive, got ${memory.cleanupIntervalMinutes}`);
      }

      if (memory.staleIndexMultiplier !== undefined && memory.staleIndexMultiplier <= 0) {
        throw new Error(`staleIndexMultiplier must be positive, got ${memory.staleIndexMultiplier}`);
      }
    }

    // Validate index configuration
    if (config.index) {
      const index = config.index;

      if (index.ttlMinutes !== undefined && index.ttlMinutes <= 0) {
        throw new Error(`ttlMinutes must be positive, got ${index.ttlMinutes}`);
      }

      if (index.lockTimeoutMs !== undefined && index.lockTimeoutMs <= 0) {
        throw new Error(`lockTimeoutMs must be positive, got ${index.lockTimeoutMs}`);
      }

      if (index.maxConcurrentBuilds !== undefined && index.maxConcurrentBuilds <= 0) {
        throw new Error(`maxConcurrentBuilds must be positive, got ${index.maxConcurrentBuilds}`);
      }
    }
  }

  /**
   * Reset to default configuration
   */
  public async resetToDefaults(): Promise<void> {
    this.config = { ...this.defaultConfig };
    await this.saveConfig();

    logger.info('Index configuration reset to defaults');
  }

  /**
   * Deep merge objects
   */
  private deepMerge(target: any, source: any): any {
    const output = { ...target };

    if (this.isObject(target) && this.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (this.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = this.deepMerge(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }

    return output;
  }

  private isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * Get specific configuration value by path
   */
  public get(path: string): any {
    const parts = path.split('.');
    let result = this.config as any;

    for (const part of parts) {
      if (result && typeof result === 'object' && part in result) {
        result = result[part];
      } else {
        return undefined;
      }
    }

    return result;
  }

  /**
   * Set specific configuration value by path
   */
  public async set(path: string, value: any): Promise<void> {
    const parts = path.split('.');
    const lastPart = parts.pop()!;
    let target = this.config as any;

    for (const part of parts) {
      if (!(part in target) || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part];
    }

    target[lastPart] = value;
    await this.saveConfig();
  }
}