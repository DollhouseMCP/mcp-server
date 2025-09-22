/**
 * Configuration for Enhanced Index system
 *
 * Centralizes all tunable parameters for the index, NLP scoring,
 * and relationship discovery systems.
 */

import * as fs from 'fs/promises';
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
    similarityBatchSize: number;           // Batch size for async processing (default: 50)
    similarityThreshold: number;           // Min score to store relationship (default: 0.5)
    parallelProcessing: boolean;           // Use parallel processing (default: true)
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
      similarityBatchSize: 50,
      similarityThreshold: 0.5,
      parallelProcessing: true
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
      gcIntervalMinutes: 30
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
      const fs = require('fs');
      const configData = fs.readFileSync(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(configData);

      // Deep merge with defaults to handle missing fields
      this.config = this.deepMerge(this.defaultConfig, loadedConfig);

      logger.info('Index configuration loaded', { path: this.configPath });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // Config doesn't exist, will be created on first save
        logger.info('No config file found, using defaults', { path: this.configPath });
      } else {
        logger.warn('Failed to load index config, using defaults', { error });
      }
    }
  }

  /**
   * Load configuration from disk if it exists (async version)
   */
  private async loadConfig(): Promise<void> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8');
      const loadedConfig = JSON.parse(configData);

      // Deep merge with defaults to handle missing fields
      this.config = this.deepMerge(this.defaultConfig, loadedConfig);

      logger.info('Index configuration loaded', { path: this.configPath });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // Config doesn't exist, use defaults and create it
        await this.saveConfig();
        logger.info('Created default index configuration', { path: this.configPath });
      } else {
        logger.warn('Failed to load index config, using defaults', { error });
      }
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
   * Update configuration
   */
  public async updateConfig(updates: Partial<IndexConfiguration>): Promise<void> {
    this.config = this.deepMerge(this.config, updates);
    await this.saveConfig();

    logger.info('Index configuration updated', { updates });
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