/**
 * Enhanced Index Manager - Persistent YAML index with extensible schema
 *
 * Features:
 * - Extensible schema supporting arbitrary element types and metadata
 * - Persistent YAML storage for human readability
 * - Incremental updates without full regeneration
 * - Backward compatible with schema evolution
 * - Server-side semantic intelligence
 *
 * This manager creates and maintains a capability index that enables:
 * - Verb-based action triggers
 * - Cross-element relationships
 * - Semantic scoring with Jaccard/entropy
 * - Context-aware element discovery
 *
 * FIXES IMPLEMENTED (Issue #1099):
 * - Uses centralized element ID parsing utilities
 * - Consistent ID format handling throughout
 */

import * as path from 'path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { logger } from '../utils/logger.js';
import { PortfolioIndexManager } from './PortfolioIndexManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { NLPScoringManager } from './NLPScoringManager.js';
import { VerbTriggerManager } from './VerbTriggerManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { IndexConfigManager } from './config/IndexConfig.js';
import { FileLock } from '../utils/FileLock.js';
import { parseElementId } from '../utils/elementId.js';
import { RelationshipManager } from './RelationshipManager.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import {
  MEMORY_LIMITS,
  getValidatedBatchSize,
  getValidatedFlushInterval
} from '../config/performance-constants.js';
import { ElementDefinitionBuilder } from './enhanced-index/ElementDefinitionBuilder.js';
import {
  ActionTriggerExtractor,
  TriggerExtractionConfig,
  TriggerExtractionPatterns
} from './enhanced-index/ActionTriggerExtractor.js';
import { TriggerMetricsTracker } from './enhanced-index/TriggerMetricsTracker.js';
import { SemanticRelationshipService } from './enhanced-index/SemanticRelationshipService.js';
import { EnhancedIndexHelpers } from './enhanced-index/EnhancedIndexHelpers.js';
import {
  EnhancedIndex,
  IndexMetadata,
  ElementDefinition,
  UseWhenPattern,
  Relationship,
  SemanticData,
  ContextTracking,
  KeywordTracking,
  RelationshipTracking,
  ScoringConfig,
  IndexOptions,
  ElementPath
} from './types/IndexTypes.js';

// Re-export types for backward compatibility
export type {
  EnhancedIndex,
  IndexMetadata,
  ElementDefinition,
  UseWhenPattern,
  Relationship,
  SemanticData,
  ContextTracking,
  KeywordTracking,
  RelationshipTracking,
  ScoringConfig,
  IndexOptions,
  ElementPath
};


export class EnhancedIndexManager {
  private index: EnhancedIndex | null = null;
  private indexPath: string;
  private lastLoaded: Date | null = null;
  private TTL_MS: number;
  private isBuilding = false;  // Track if index is being built
  private nlpScoring: NLPScoringManager;
  private verbTriggers: VerbTriggerManager;
  private relationshipManager: RelationshipManager;
  private config: IndexConfigManager;
  private readonly configManager: ConfigManager;
  private readonly portfolioIndexManager: PortfolioIndexManager;
  private fileLock: FileLock;
  private memoryCleanupInterval: NodeJS.Timeout | null = null;
  private lastMemoryCleanup: Date = new Date();
  private readonly elementDefinitionBuilder: ElementDefinitionBuilder;
  private readonly actionTriggerExtractor: ActionTriggerExtractor;
  private readonly metricsTracker: TriggerMetricsTracker;
  private readonly semanticRelationshipService: SemanticRelationshipService;
  private readonly fileOperations: FileOperationsService;

  // Using centralized configuration for metrics batching
  private readonly METRICS_BATCH_SIZE = getValidatedBatchSize();
  private readonly METRICS_FLUSH_INTERVAL = getValidatedFlushInterval();

  // Cache configuration constants - using centralized configuration
  private static readonly MAX_METRICS_CACHE_SIZE = MEMORY_LIMITS.METRICS_CACHE.MAX_SIZE;
  private static readonly MAX_METRICS_CACHE_MEMORY_MB = MEMORY_LIMITS.METRICS_CACHE.MAX_MEMORY_MB;

  public constructor(
    indexConfigManager: IndexConfigManager,
    configManager: ConfigManager,
    portfolioIndexManager: PortfolioIndexManager,
    nlpScoringManager: NLPScoringManager,
    verbTriggerManager: VerbTriggerManager,
    relationshipManager: RelationshipManager,
    helpers: EnhancedIndexHelpers,
    fileOperations: FileOperationsService
  ) {
    const portfolioPath = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
    this.indexPath = path.join(portfolioPath, 'capability-index.yaml');

    // Initialize configuration
    this.config = indexConfigManager;
    this.configManager = configManager;
    this.portfolioIndexManager = portfolioIndexManager;
    this.fileOperations = fileOperations;
    const config = this.config.getConfig();
    this.TTL_MS = config.index.ttlMinutes * 60 * 1000;

    // Load enhanced index config from global ConfigManager
    this.loadEnhancedIndexConfig();

    // Initialize components with config
    this.nlpScoring = nlpScoringManager;
    this.verbTriggers = verbTriggerManager;
    this.relationshipManager = relationshipManager;
    this.elementDefinitionBuilder = helpers.elementDefinitionBuilder;
    this.semanticRelationshipService = helpers.semanticRelationshipService;
    this.actionTriggerExtractor = helpers.createActionTriggerExtractor({
      getConfig: () => EnhancedIndexManager.VERB_EXTRACTION_CONFIG,
      getPatterns: () => this.getTriggerPatterns()
    });
    this.metricsTracker = helpers.createTriggerMetricsTracker({
      batchSize: this.METRICS_BATCH_SIZE,
      flushIntervalMs: this.METRICS_FLUSH_INTERVAL,
      cacheLimits: {
        maxSize: EnhancedIndexManager.MAX_METRICS_CACHE_SIZE,
        maxMemoryMB: EnhancedIndexManager.MAX_METRICS_CACHE_MEMORY_MB
      },
      getIndex: () => this.getIndex(),
      persistIndex: (index) => this.writeToFile(index)
    });

    // Initialize file lock
    this.fileLock = new FileLock(this.indexPath);

    logger.debug('EnhancedIndexManager initialized', {
      indexPath: this.indexPath,
      config: {
        ttlMinutes: config.index.ttlMinutes,
        maxElements: config.performance.maxElementsForFullMatrix
      }
    });

    // Start automatic memory cleanup to prevent leaks
    this.startMemoryCleanup();
  }

  public async dispose(): Promise<void> {
    // Clear all timers
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
      this.memoryCleanupInterval = null;
    }

    // Flush pending metrics before disposal
    try {
      await this.metricsTracker.flush();
    } catch (error) {
      logger.warn('Failed to flush metrics batch during disposal', error);
    }

    this.metricsTracker.dispose();

    // Dispose of file lock
    if (this.fileLock) {
      this.fileLock.dispose();
    }

    logger.debug('Disposed EnhancedIndexManager timers and caches');
  }

  /**
   * Get the current index, loading or building as needed
   */
  public async getIndex(options: IndexOptions = {}): Promise<EnhancedIndex> {
    try {
      // Add performance tracking
      const startTime = Date.now();
      const operation = options.forceRebuild ? 'rebuild' :
                       !this.index ? 'load' : 'cached';

      if (options.forceRebuild) {
        logger.info('Force rebuild requested for Enhanced Index');
        await this.buildIndex(options);
      } else if (await this.needsRebuild()) {
        logger.info('Enhanced Index needs rebuild');
        await this.buildIndex(options);
      } else if (!this.index) {
        // Try to load from file first
        logger.info('Loading Enhanced Index from cache file');
        await this.loadIndex();
      } else {
        logger.debug('Using cached Enhanced Index from memory');
      }

      const elapsed = Date.now() - startTime;
      logger.info('Enhanced Index operation completed', {
        operation,
        elapsedMs: elapsed,
        elements: this.index?.metadata?.total_elements || 0
      });

      if (elapsed > 1000) {
        logger.warn('Enhanced Index operation took longer than expected', {
          elapsedMs: elapsed,
          operation
        });
      }

      return this.index!;
    } catch (error) {
      logger.error('Failed to get Enhanced Index', error);
      throw error;
    }
  }

  /**
   * Load index from YAML file
   */
  private async loadIndex(): Promise<void> {
    try {
      const yamlContent = await this.fileOperations.readFile(this.indexPath, {
        source: 'EnhancedIndexManager.loadIndex'
      });

      let loadedData;
      try {
        loadedData = yamlLoad(yamlContent);
      } catch (yamlError) {
        // Handle YAML parse errors gracefully
        logger.warn('Failed to parse YAML, rebuilding index', yamlError);
        await this.buildIndex();
        return;
      }

      // FIX: Add defensive checks for malformed YAML with undefined/null index
      // Previously: Assumed yamlLoad always returns valid data
      // Now: Validate structure deeply to ensure all required fields exist
      if (!loadedData || typeof loadedData !== 'object') {
        logger.warn('Loaded YAML is null or not an object, rebuilding index');
        await this.buildIndex();
        return;
      }

      // Validate required structure
      const indexData = loadedData as any;
      if (!indexData.metadata || !indexData.elements || !indexData.action_triggers) {
        logger.warn('Invalid index structure (missing metadata, elements, or action_triggers), rebuilding', {
          hasMetadata: !!indexData.metadata,
          hasElements: !!indexData.elements,
          hasActionTriggers: !!indexData.action_triggers
        });
        await this.buildIndex();
        return;
      }

      this.index = loadedData as EnhancedIndex;
      this.lastLoaded = new Date();

      // FIX: Add defensive checks for malformed YAML with undefined metadata
      // Previously: Assumed metadata always exists, causing test failures
      // Now: Safely handle cases where metadata might be undefined
      logger.info('Enhanced index loaded', {
        elements: this.index?.metadata?.total_elements ?? 0,
        version: this.index?.metadata?.version ?? 'unknown'
      });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        logger.info('No existing index found, will build new one');
        await this.buildIndex();
        return; // Return early since buildIndex will set up the index
      } else {
        logger.error('Failed to load index', error);
        throw error;
      }
    }
  }

  /**
   * Build or rebuild the index from portfolio
   */
  private async buildIndex(options: IndexOptions = {}): Promise<void> {
    // Use file locking to prevent concurrent builds
    const config = this.config.getConfig();
    const lockAcquired = await this.fileLock.acquire({
      timeout: config.index.lockTimeoutMs,
      stale: 60000  // 1 minute
    });

    if (!lockAcquired) {
      logger.warn('Could not acquire lock for index build');
      return;
    }

    this.isBuilding = true;
    const startTime = Date.now();

    try {
      // Get existing index for preservation of custom fields
      const existingIndex = options.preserveCustom && this.index ? this.index : null;

      // Initialize new index structure
      const newIndex: EnhancedIndex = {
        metadata: {
          version: '2.0.0',
          created: existingIndex?.metadata.created || new Date().toISOString(),
          last_updated: new Date().toISOString(),
          total_elements: 0
        },
        action_triggers: {},
        elements: {}
      };

      // Get portfolio index for element discovery
      const portfolioData = await this.portfolioIndexManager.getIndex();

      // Process each element type
      for (const [elementType, entries] of portfolioData.byType.entries()) {
        if (!newIndex.elements[elementType]) {
          newIndex.elements[elementType] = {};
        }

        for (const entry of entries) {
          // Skip if not in update list (when specified)
          // FIX: Add defensive check for entry.metadata
          const entryName = entry.metadata?.name;
          if (!entryName) {
            logger.warn('Skipping entry with undefined metadata.name');
            continue;
          }

          if (options.updateOnly && !options.updateOnly.includes(entryName)) {
            // Preserve existing entry
            if (existingIndex?.elements[elementType]?.[entryName]) {
              newIndex.elements[elementType][entryName] =
                existingIndex.elements[elementType][entryName];
              continue;
            }
          }

          const elementDef = this.elementDefinitionBuilder.build(entry, existingIndex);
          newIndex.elements[elementType][entryName] = elementDef;
          newIndex.metadata.total_elements++;

          // Extract action triggers
          this.extractActionTriggers(elementDef, entryName, newIndex.action_triggers);
        }
      }

      // Calculate semantic relationships using NLP
      await this.calculateSemanticRelationships(newIndex);

      // Discover additional relationship types
      await this.relationshipManager.discoverRelationships(newIndex);

      // Preserve extensions from existing index
      if (existingIndex?.extensions) {
        newIndex.extensions = existingIndex.extensions;
      }

      // Save to file
      await this.writeToFile(newIndex);

      this.index = newIndex;
      this.lastLoaded = new Date();

      const duration = Date.now() - startTime;
      logger.info('Enhanced index built', {
        duration: `${duration}ms`,
        elements: newIndex.metadata.total_elements,
        triggers: Object.keys(newIndex.action_triggers).length
      });

      // Log security event
      SecurityMonitor.logSecurityEvent({
        type: 'PORTFOLIO_CACHE_INVALIDATION',
        severity: 'LOW',
        source: 'enhanced_index',
        details: `Index rebuilt with ${newIndex.metadata.total_elements} elements in ${duration}ms`
      });

    } finally {
      this.isBuilding = false;
      await this.fileLock.release();
    }
  }

  // Configuration for verb extraction (will be overridden by ConfigManager)
  private static VERB_EXTRACTION_CONFIG: TriggerExtractionConfig = {
    // Security limits for DoS protection
    limits: {
      maxTriggersPerElement: 50,  // Maximum triggers to extract per element
      maxTriggerLength: 50,        // Maximum length for a single trigger
      maxKeywordsToCheck: 100,     // Maximum keywords to process for verb detection
    },

    // Common verb prefixes broken down by category for maintainability
    verbPrefixes: {
      actions: ['create', 'build', 'make', 'generate', 'produce', 'write', 'compose'],
      analysis: ['analyze', 'review', 'examine', 'investigate', 'inspect', 'evaluate', 'assess'],
      debugging: ['debug', 'fix', 'troubleshoot', 'solve', 'resolve', 'repair', 'patch'],
      operations: ['run', 'execute', 'start', 'stop', 'deploy', 'configure', 'install'],
      modification: ['update', 'modify', 'change', 'edit', 'alter', 'transform', 'refactor'],
      removal: ['delete', 'remove', 'clear', 'clean', 'purge', 'destroy', 'eliminate'],
      information: ['explain', 'describe', 'document', 'search', 'find', 'check', 'validate'],
      optimization: ['optimize', 'improve', 'enhance', 'streamline', 'accelerate'],
      testing: ['test', 'verify', 'validate', 'confirm', 'assert', 'ensure'],
    },

    // Common verb suffixes that indicate action words
    verbSuffixes: ['ify', 'ize', 'ate', 'en', 'fy'],

    // Noun suffixes that indicate non-verbs (to filter out)
    nounSuffixes: ['tion', 'sion', 'ment', 'ness', 'ance', 'ence', 'ity', 'ism', 'ship', 'hood', 'dom', 'ery', 'ing'],

    // Telemetry settings
    telemetry: {
      enabled: false,  // Will be configurable via environment variable
      sampleRate: 0.1, // Sample 10% of operations when enabled
      metricsInterval: 60000, // Report metrics every 60 seconds
    }
  };

  // Pre-compiled regex patterns built from config (can be updated from ConfigManager)
  private static VERB_PREFIX_PATTERN = new RegExp(
    `^(${Object.values(EnhancedIndexManager.VERB_EXTRACTION_CONFIG.verbPrefixes)
      .flat()
      .join('|')})`
  );

  private static VERB_SUFFIX_PATTERN = new RegExp(
    `(${EnhancedIndexManager.VERB_EXTRACTION_CONFIG.verbSuffixes.join('|')})$`
  );

  private static NOUN_SUFFIX_PATTERN = new RegExp(
    `(${EnhancedIndexManager.VERB_EXTRACTION_CONFIG.nounSuffixes.join('|')})$`
  );

  private getTriggerPatterns(): TriggerExtractionPatterns {
    return {
      verbPrefixPattern: EnhancedIndexManager.VERB_PREFIX_PATTERN,
      verbSuffixPattern: EnhancedIndexManager.VERB_SUFFIX_PATTERN,
      nounSuffixPattern: EnhancedIndexManager.NOUN_SUFFIX_PATTERN
    };
  }

  /**
   * Extract action triggers from element definition
   *
   * FIX: Enhanced verb extraction from multiple sources
   * Previously: Only checked elementDef.actions which personas don't have
   * Now: Checks search.triggers (personas), actions field, and keywords
   *
   * Security improvements:
   * - Added trigger count limits
   * - Added trigger length validation
   * - Using Sets for O(1) duplicate checking
   * - Pre-compiled regex patterns
   *
   * Future enhancements:
   * - Background deep content analysis for dynamic verb extraction
   * - This could scan element descriptions and content to find action words
   * - Would run asynchronously to avoid blocking main operations
   * - Results would progressively enhance the index over time
   */
  private extractActionTriggers(
    elementDef: ElementDefinition,
    elementName: string,
    triggers: Record<string, string[]>
  ): void {
    if (!elementDef) {
      return;
    }

    const telemetryStartTime = this.startTelemetry('extractActionTriggers');
    const result = this.actionTriggerExtractor.extract(elementDef, elementName);

    for (const trigger of result.triggers) {
      this.addTriggerMapping(trigger, elementName, triggers);
    }

    this.recordTelemetry('extractActionTriggers', telemetryStartTime, {
      elementName,
      elementType: elementDef?.core?.type,
      triggersExtracted: result.extractedCount,
      uniqueTriggers: result.triggers.length,
    });
  }

  /**
   * Add a trigger to element mapping
   * Preserves original element name casing for proper resolution
   *
   * Note: Triggers are persisted in the index file under action_triggers
   * Usage metrics are tracked via trackTriggerUsage() and can be retrieved with getTriggerMetrics()
   */
  private addTriggerMapping(
    verb: string,
    elementName: string,
    triggers: Record<string, string[]>
  ): void {
    // Store verb in lowercase for consistent lookup
    const normalizedVerb = verb.toLowerCase();

    if (!triggers[normalizedVerb]) {
      triggers[normalizedVerb] = [];
    }

    // Preserve original element name casing for accurate resolution
    // This supports various naming conventions users might use:
    // - lowercase: debug-detective
    // - kebab-case: Debug-Detective
    // - snake_case: debug_detective
    // - CamelCase: DebugDetective
    // - Custom: DeBuG-DeTecTiVe
    if (!triggers[normalizedVerb].includes(elementName)) {
      triggers[normalizedVerb].push(elementName);
    }
  }

  /**
   * Load enhanced index configuration from ConfigManager
   */
  private loadEnhancedIndexConfig(): void {
    try {
      const configManager = this.configManager;
      const config = configManager.getConfig();

      // Update limits from config
      if (config.elements?.enhanced_index) {
        const enhancedConfig = config.elements.enhanced_index;

        // Update limits
        if (enhancedConfig.limits) {
          EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits = {
            ...EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits,
            ...enhancedConfig.limits
          };
        }

        // Update telemetry settings
        if (enhancedConfig.telemetry) {
          EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry = {
            ...EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry,
            ...enhancedConfig.telemetry
          };
        }

        // Add custom verb patterns if provided
        if (enhancedConfig.verbPatterns) {
          const patterns = enhancedConfig.verbPatterns;

          // Add custom prefixes
          if (patterns.customPrefixes && patterns.customPrefixes.length > 0) {
            const allPrefixes = [
              ...Object.values(EnhancedIndexManager.VERB_EXTRACTION_CONFIG.verbPrefixes).flat(),
              ...patterns.customPrefixes
            ];
            EnhancedIndexManager.VERB_PREFIX_PATTERN = this.compileAndValidateRegex(
              `^(${allPrefixes.join('|')})`,
              'verb prefix'
            );
          }

          // Add custom suffixes
          if (patterns.customSuffixes && patterns.customSuffixes.length > 0) {
            const allSuffixes = [
              ...EnhancedIndexManager.VERB_EXTRACTION_CONFIG.verbSuffixes,
              ...patterns.customSuffixes
            ];
            EnhancedIndexManager.VERB_SUFFIX_PATTERN = this.compileAndValidateRegex(
              `(${allSuffixes.join('|')})$`,
              'verb suffix'
            );
          }

          // Add excluded nouns
          if (patterns.excludedNouns && patterns.excludedNouns.length > 0) {
            const allNouns = [
              ...EnhancedIndexManager.VERB_EXTRACTION_CONFIG.nounSuffixes,
              ...patterns.excludedNouns
            ];
            EnhancedIndexManager.NOUN_SUFFIX_PATTERN = this.compileAndValidateRegex(
              `(${allNouns.join('|')})$`,
              'noun suffix'
            );
          }
        }

        // Validate all regex patterns at startup
        this.validateRegexPatterns();

        logger.info('Loaded enhanced index configuration', {
          limits: EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits,
          telemetryEnabled: EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry.enabled
        });
      }
    } catch (error) {
      logger.warn('Failed to load enhanced index configuration, using defaults', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Compile and validate a regex pattern
   * Provides clear error messages if pattern is invalid
   */
  private compileAndValidateRegex(pattern: string, name: string): RegExp {
    try {
      const regex = new RegExp(pattern);

      // Test the regex with sample data to ensure it works
      const testStrings = ['test', 'debug', 'create', 'ify', 'tion'];
      for (const str of testStrings) {
        try {
          // Execute test to validate regex pattern (result not needed, just checking for errors)
          void regex.test(str);
          // Reset lastIndex for global regexes to ensure consistent behavior
          if (regex.global) {
            regex.lastIndex = 0;
          }
        } catch (testError) {
          throw new Error(`Regex pattern fails on test string '${str}': ${testError}`);
        }
      }

      return regex;
    } catch (error) {
      const errorMsg = `Invalid ${name} pattern: ${pattern}`;
      logger.error(errorMsg, {
        error: error instanceof Error ? error.message : String(error),
        pattern
      });
      throw new Error(errorMsg);
    }
  }

  /**
   * Validate all regex patterns at startup
   * Ensures patterns are valid and can handle expected input
   */
  private validateRegexPatterns(): void {
    const validationTests = [
      {
        pattern: EnhancedIndexManager.VERB_PREFIX_PATTERN,
        name: 'VERB_PREFIX_PATTERN',
        shouldMatch: ['debug', 'create', 'analyze'],
        shouldNotMatch: ['xdebug', 'created', '123debug']
      },
      {
        pattern: EnhancedIndexManager.VERB_SUFFIX_PATTERN,
        name: 'VERB_SUFFIX_PATTERN',
        shouldMatch: ['simplify', 'organize', 'automate'],
        shouldNotMatch: ['simple', 'organ', 'auto']
      },
      {
        pattern: EnhancedIndexManager.NOUN_SUFFIX_PATTERN,
        name: 'NOUN_SUFFIX_PATTERN',
        shouldMatch: ['documentation', 'management', 'happiness'],
        shouldNotMatch: ['document', 'manage', 'happy']
      }
    ];

    for (const test of validationTests) {
      // Validate pattern exists
      if (!test.pattern) {
        throw new Error(`${test.name} pattern is not initialized`);
      }

      // Test expected matches
      for (const str of test.shouldMatch) {
        if (!test.pattern.test(str)) {
          logger.warn(`Pattern validation warning: ${test.name} should match '${str}' but doesn't`);
        }
      }

      // Test expected non-matches
      for (const str of test.shouldNotMatch) {
        if (test.pattern.test(str)) {
          logger.warn(`Pattern validation warning: ${test.name} should not match '${str}' but does`);
        }
      }
    }

    logger.debug('Regex pattern validation completed successfully');
  }

  /**
   * Telemetry tracking infrastructure
   */
  private telemetryMetrics: Map<string, any> = new Map();
  private telemetryTimer: NodeJS.Timeout | null = null;

  /**
   * Start telemetry tracking for an operation
   */
  private startTelemetry(_operationName: string): number | null {
    if (!this.isTelemetryEnabled()) return null;

    // Sample based on configured rate
    if (Math.random() > EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry.sampleRate) {
      return null;
    }

    return Date.now();
  }

  /**
   * Record telemetry metrics for an operation
   */
  private recordTelemetry(
    operationName: string,
    startTime: number | null,
    metrics: Record<string, any>
  ): void {
    if (!startTime || !this.isTelemetryEnabled()) return;

    const duration = Date.now() - startTime;

    // Aggregate metrics
    if (!this.telemetryMetrics.has(operationName)) {
      this.telemetryMetrics.set(operationName, {
        count: 0,
        totalDuration: 0,
        avgDuration: 0,
        maxDuration: 0,
        minDuration: Infinity,
        lastMetrics: {},
      });
    }

    const stats = this.telemetryMetrics.get(operationName);
    stats.count++;
    stats.totalDuration += duration;
    stats.avgDuration = stats.totalDuration / stats.count;
    stats.maxDuration = Math.max(stats.maxDuration, duration);
    stats.minDuration = Math.min(stats.minDuration, duration);
    stats.lastMetrics = { ...metrics, duration };

    // Log detailed metrics in debug mode
    logger.debug(`Telemetry: ${operationName}`, {
      duration,
      ...metrics,
    });

    // Schedule periodic reporting
    this.scheduleTelemetryReport();
  }

  /**
   * Check if telemetry is enabled
   */
  private isTelemetryEnabled(): boolean {
    // Check environment variable or config
    return process.env.DOLLHOUSE_TELEMETRY_ENABLED === 'true' ||
           EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry.enabled;
  }

  /**
   * Schedule periodic telemetry reporting
   */
  private scheduleTelemetryReport(): void {
    if (this.telemetryTimer) return;

    this.telemetryTimer = setTimeout(() => {
      this.reportTelemetry();
      this.telemetryTimer = null;
    }, EnhancedIndexManager.VERB_EXTRACTION_CONFIG.telemetry.metricsInterval);
  }

  /**
   * Report aggregated telemetry metrics
   */
  private reportTelemetry(): void {
    if (this.telemetryMetrics.size === 0) return;

    const report = {
      timestamp: new Date().toISOString(),
      metrics: Object.fromEntries(this.telemetryMetrics),
    };

    // Log summary report
    logger.info('Telemetry Report', report);

    // Future: Send to telemetry endpoint if configured
    // if (process.env.DOLLHOUSE_TELEMETRY_ENDPOINT) {
    //   this.sendTelemetryToEndpoint(report);
    // }

    // Clear metrics after reporting
    this.telemetryMetrics.clear();
  }

  /**
   * Write index data to YAML file on disk
   * Private implementation detail
   */
  private async writeToFile(index: EnhancedIndex): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.indexPath);
      await this.fileOperations.createDirectory(dir);

      // Convert to YAML with nice formatting
      const yamlContent = yamlDump(index, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false  // Preserve our logical ordering
      });

      // Validate Unicode before saving
      const validation = UnicodeValidator.normalize(yamlContent);
      if (validation.detectedIssues && validation.detectedIssues.length > 0) {
        throw new Error(`Unicode issues in index: ${validation.detectedIssues.join(', ')}`);
      }

      await this.fileOperations.writeFile(this.indexPath, yamlContent, {
        source: 'EnhancedIndexManager.writeToFile'
      });

      logger.debug('Index saved to file', { path: this.indexPath });
    } catch (error) {
      logger.error('Failed to save index', error);
      throw error;
    }
  }

  /**
   * Check if index needs rebuilding
   */
  private async needsRebuild(): Promise<boolean> {
    try {
      // Check if index file exists
      const indexStats = await this.fileOperations.stat(this.indexPath).catch(() => null);
      if (!indexStats) {
        logger.info('Enhanced index file does not exist, rebuild needed');
        return true;
      }

      // Check file age FIRST - this is the key fix
      const fileAge = Date.now() - indexStats.mtime.getTime();
      const ttlMs = this.TTL_MS;

      if (fileAge > ttlMs) {
        logger.info('Enhanced index file is stale', {
          ageMinutes: Math.round(fileAge / 60000),
          ttlMinutes: Math.round(ttlMs / 60000)
        });
        return true;  // File is too old, rebuild needed
      }

      // If we reach here, file exists and is fresh
      // If not in memory, we can load it
      if (!this.index) {
        logger.debug('Enhanced index not in memory but file is fresh, will load from file');
        return false; // We can load the fresh file, no rebuild needed
      }

      // File is fresh and we have it in memory
      logger.debug('Enhanced index is current, no rebuild needed');
      return false;
    } catch (error) {
      logger.error('Error checking if rebuild needed', error);
      return true; // Safer to rebuild on error
    }
  }

  /**
   * Update specific elements in the index
   */
  public async updateElements(elementNames: string[], options: IndexOptions = {}): Promise<void> {
    await this.getIndex({
      ...options,
      updateOnly: elementNames,
      preserveCustom: true
    });
  }

  /**
   * Add or update a relationship between elements
   */
  public async addRelationship(
    fromElement: string,
    toElement: string,
    relationship: Relationship
  ): Promise<void> {
    const index = await this.getIndex();

    // Find the element
    let found = false;
    for (const [, elements] of Object.entries(index.elements)) {
      if (elements[fromElement]) {
        if (!elements[fromElement].relationships) {
          elements[fromElement].relationships = {};
        }

        const relType = relationship.type || 'related_to';
        if (!elements[fromElement].relationships[relType]) {
          elements[fromElement].relationships[relType] = [];
        }

        // Add or update relationship
        const existing = elements[fromElement].relationships[relType]
          .findIndex(r => r.element === toElement);

        if (existing >= 0) {
          elements[fromElement].relationships[relType][existing] = relationship;
        } else {
          elements[fromElement].relationships[relType].push(relationship);
        }

        found = true;
        break;
      }
    }

    if (found) {
      index.metadata.last_updated = new Date().toISOString();
      await this.writeToFile(index);
    }
  }

  /**
   * Add custom extension data
   */
  public async addExtension(key: string, data: any): Promise<void> {
    const index = await this.getIndex();

    if (!index.extensions) {
      index.extensions = {};
    }

    index.extensions[key] = data;
    index.metadata.last_updated = new Date().toISOString();

    await this.writeToFile(index);
  }

  /**
   * Persist the current in-memory index to disk
   * Public method for tests and external callers to save current state
   */
  public async persist(): Promise<void> {
    if (!this.index) {
      throw new Error('No index loaded to persist');
    }
    await this.writeToFile(this.index);
  }

  /**
   * Get elements by action verb
   * Tracks usage metrics for trigger optimization
   */
  public async getElementsByAction(verb: string): Promise<string[]> {
    const index = await this.getIndex();

    // Track trigger usage metrics
    await this.trackTriggerUsage(verb);

    return index.action_triggers[verb] || [];
  }

  /**
   * Track trigger usage for optimization metrics
   * Supports batching for high-volume scenarios to reduce disk writes
   *
   * @param trigger - The trigger verb to track
   * @param immediate - Force immediate write (bypass batching)
   */
  private async trackTriggerUsage(trigger: string, immediate: boolean = false): Promise<void> {
    try {
      await this.metricsTracker.track(trigger, immediate);
    } catch (error) {
      logger.warn('Failed to track trigger usage', { trigger, error });
    }
  }

  /**
   * Flush batched metrics to disk
   * Combines multiple metric updates into a single disk write for efficiency
   */
  private async flushMetricsBatch(): Promise<void> {
    await this.metricsTracker.flush();
  }

  /**
   * Get comprehensive trigger usage metrics for optimization analysis
   *
   * @returns Promise resolving to sorted array of trigger metrics
   * @returns {Array<Object>} metrics - Array of trigger metric objects sorted by usage frequency (descending)
   * @returns {string} metrics[].trigger - The trigger word/verb
   * @returns {number} metrics[].usage_count - Total number of times this trigger has been used
   * @returns {string} metrics[].last_used - ISO timestamp of most recent usage
   * @returns {string} metrics[].first_used - ISO timestamp of first recorded usage
   * @returns {number} metrics[].daily_average - Average daily usage based on historical data
   * @returns {'increasing'|'stable'|'decreasing'} metrics[].trend - Usage trend based on last 7 days
   *
   * @example
   * const metrics = await indexManager.getTriggerMetrics();
   * // Returns: [
   * //   { trigger: 'debug', usage_count: 45, trend: 'increasing', ... },
   * //   { trigger: 'analyze', usage_count: 32, trend: 'stable', ... }
   * // ]
   *
   * @public
   * @since 1.9.9
   */
  public async getTriggerMetrics(): Promise<{
    trigger: string;
    usage_count: number;
    last_used: string;
    first_used: string;
    daily_average: number;
    trend: 'increasing' | 'stable' | 'decreasing';
  }[]> {
    const index = await this.getIndex();

    if (!index.metadata.trigger_metrics) {
      return [];
    }

    const metrics = index.metadata.trigger_metrics;
    const results: any[] = [];

    // Calculate metrics for each trigger
    for (const trigger in metrics.usage_count) {
      // Calculate daily average
      let totalDailyUsage = 0;
      let daysWithUsage = 0;
      const recentUsage: number[] = [];

      // Get last 7 days of usage for trend analysis
      const today = new Date();
      for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];

        if (metrics.daily_usage[dateStr] && metrics.daily_usage[dateStr][trigger]) {
          recentUsage.push(metrics.daily_usage[dateStr][trigger]);
        } else {
          recentUsage.push(0);
        }
      }

      // Calculate trend (simple comparison of first and last 3 days)
      const firstHalf = recentUsage.slice(4, 7).reduce((a, b) => a + b, 0);
      const secondHalf = recentUsage.slice(0, 3).reduce((a, b) => a + b, 0);
      let trend: 'increasing' | 'stable' | 'decreasing' = 'stable';

      if (secondHalf > firstHalf * 1.2) trend = 'increasing';
      else if (secondHalf < firstHalf * 0.8) trend = 'decreasing';

      // Calculate overall daily average
      for (const date in metrics.daily_usage) {
        if (metrics.daily_usage[date][trigger]) {
          totalDailyUsage += metrics.daily_usage[date][trigger];
          daysWithUsage++;
        }
      }

      results.push({
        trigger,
        usage_count: metrics.usage_count[trigger],
        last_used: metrics.last_used[trigger],
        first_used: metrics.first_used[trigger],
        daily_average: daysWithUsage > 0 ? totalDailyUsage / daysWithUsage : 0,
        trend
      });
    }

    // Sort by usage count (descending)
    return results.sort((a, b) => b.usage_count - a.usage_count);
  }

  /**
   * Export trigger metrics for external analytics systems
   * Provides data in a format suitable for analytics platforms
   *
   * @param format - Export format ('json' | 'csv' | 'prometheus')
   * @returns Formatted metrics data
   *
   * @example
   * // Export for Prometheus monitoring
   * const prometheusMetrics = await indexManager.exportMetrics('prometheus');
   *
   * // Export as CSV for data analysis
   * const csvData = await indexManager.exportMetrics('csv');
   */
  public async exportMetrics(format: 'json' | 'csv' | 'prometheus' = 'json'): Promise<string> {
    const metrics = await this.getTriggerMetrics();

    switch (format) {
      case 'csv': {
        // CSV header
        let csv = 'trigger,usage_count,last_used,first_used,daily_average,trend\n';

        // CSV rows
        for (const metric of metrics) {
          csv += `"${metric.trigger}",${metric.usage_count},"${metric.last_used}","${metric.first_used}",${metric.daily_average.toFixed(2)},"${metric.trend}"\n`;
        }

        return csv;
      }

      case 'prometheus': {
        let output = '';
        const timestamp = Date.now();

        // Prometheus metrics format
        output += '# HELP enhanced_index_trigger_usage Total usage count for each trigger\n';
        output += '# TYPE enhanced_index_trigger_usage counter\n';

        for (const metric of metrics) {
          output += `enhanced_index_trigger_usage{trigger="${metric.trigger}",trend="${metric.trend}"} ${metric.usage_count} ${timestamp}\n`;
        }

        output += '\n# HELP enhanced_index_trigger_daily_avg Average daily usage for each trigger\n';
        output += '# TYPE enhanced_index_trigger_daily_avg gauge\n';

        for (const metric of metrics) {
          output += `enhanced_index_trigger_daily_avg{trigger="${metric.trigger}"} ${metric.daily_average.toFixed(2)} ${timestamp}\n`;
        }

        return output;
      }

      case 'json':
      default: {
        return JSON.stringify({
          timestamp: new Date().toISOString(),
          metrics,
          summary: {
            total_triggers: metrics.length,
            total_usage: metrics.reduce((sum, m) => sum + m.usage_count, 0),
            trending_up: metrics.filter(m => m.trend === 'increasing').length,
            trending_down: metrics.filter(m => m.trend === 'decreasing').length
          }
        }, null, 2);
      }
    }
  }

  /**
   * Search for elements using enhanced criteria
   */
  public async searchEnhanced(criteria: {
    verbs?: string[];
    keywords?: string[];
    type?: string;
    hasRelationships?: boolean;
  }): Promise<ElementDefinition[]> {
    const index = await this.getIndex();
    const results: ElementDefinition[] = [];

    for (const [type, elements] of Object.entries(index.elements)) {
      // Filter by type if specified
      if (criteria.type && type !== criteria.type) continue;

      for (const [, element] of Object.entries(elements)) {
        let matches = true;

        // Check verb matches
        if (criteria.verbs && element.actions) {
          const elementVerbs = Object.values(element.actions).map(a => a.verb);
          matches = criteria.verbs.some(v => elementVerbs.includes(v));
        }

        // Check keyword matches
        if (matches && criteria.keywords && element.search?.keywords) {
          matches = criteria.keywords.some(k =>
            element.search!.keywords!.includes(k)
          );
        }

        // Check relationship requirement
        if (matches && criteria.hasRelationships) {
          matches = !!element.relationships &&
                   Object.keys(element.relationships).length > 0;
        }

        if (matches) {
          results.push(element);
        }
      }
    }

    return results;
  }

  private async calculateSemanticRelationships(index: EnhancedIndex): Promise<void> {
    const config = this.config.getConfig();
    await this.semanticRelationshipService.calculate(index, config);
  }

  

  

  /**
   * Find shortest path between two elements
   */
  public async findElementPath(
    fromElement: string,
    toElement: string,
    options?: {
      relationshipTypes?: string[];
      minStrength?: number;
      maxDepth?: number;
    }
  ): Promise<ElementPath | null> {
    const index = await this.getIndex();
    return this.relationshipManager.findPath(fromElement, toElement, index, options as any);
  }

  /**
   * Get all elements connected to a given element
   */
  public async getConnectedElements(
    element: string,
    options?: {
      maxDepth?: number;
      relationshipTypes?: string[];
      minStrength?: number;
    }
  ): Promise<Map<string, ElementPath>> {
    const index = await this.getIndex();
    return this.relationshipManager.getConnectedElements(element, index, options as any);
  }

  /**
   * Get relationship statistics
   */
  public async getRelationshipStats(): Promise<Record<string, number>> {
    const index = await this.getIndex();
    return this.relationshipManager.getRelationshipStats(index);
  }

  /**
   * Get all relationships for an element
   */
  public async getElementRelationships(elementId: string): Promise<Record<string, Relationship[]>> {
    const index = await this.getIndex();
    // FIX: Use centralized element ID parsing
    const parsed = parseElementId(elementId);
    if (!parsed) {
      return {};
    }
    const element = index.elements[parsed.type]?.[parsed.name];

    if (!element) {
      return {};
    }

    return element.relationships || {};
  }

  /**
   * Clean up memory by clearing caches and old data
   * FIX: Added to prevent memory leaks as identified in PR review
   */
  public clearMemoryCache(): void {
    const now = new Date();
    const timeSinceLastCleanup = now.getTime() - this.lastMemoryCleanup.getTime();

    // Only cleanup if it's been more than 5 minutes
    // FIX: Use configuration for cleanup interval check
    const config = this.config.getConfig();
    const minCleanupInterval = config.memory.cleanupIntervalMinutes * 60 * 1000;
    if (timeSinceLastCleanup < minCleanupInterval) {
      return;
    }

    logger.debug('Performing memory cleanup for Enhanced Index');

    // Clear NLP scoring caches
    if (this.nlpScoring) {
      (this.nlpScoring as any).clearCache?.();
    }

    // Clear verb trigger caches
    if (this.verbTriggers) {
      (this.verbTriggers as any).clearCache?.();
    }

    // Clear relationship manager caches
    if (this.relationshipManager) {
      (this.relationshipManager as any).clearCache?.();
    }

    // If index is stale, clear it from memory
    // FIX: Use configuration for stale index multiplier
    if (this.index && this.lastLoaded) {
      const indexAge = now.getTime() - this.lastLoaded.getTime();
      const staleThreshold = this.TTL_MS * config.memory.staleIndexMultiplier;
      if (indexAge > staleThreshold) {
        logger.debug('Clearing stale index from memory', {
          indexAge,
          staleThreshold,
          multiplier: config.memory.staleIndexMultiplier
        });
        this.index = null;
        this.lastLoaded = null;
      }
    }

    this.lastMemoryCleanup = now;
  }

  /**
   * Start automatic memory cleanup
   */
  // FIX: Use configuration for default cleanup interval
  public startMemoryCleanup(intervalMs?: number): void {
    const config = this.config.getConfig();
    const actualInterval = intervalMs || config.memory.cleanupIntervalMinutes * 60 * 1000;
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
    }

    this.memoryCleanupInterval = setInterval(() => {
      this.clearMemoryCache();
    }, actualInterval);
    if (typeof this.memoryCleanupInterval.unref === 'function') {
      this.memoryCleanupInterval.unref();
    }

    logger.debug('Started automatic memory cleanup', { intervalMs: actualInterval });
  }

  /**
   * Stop automatic memory cleanup
   */
  public stopMemoryCleanup(): void {
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
      this.memoryCleanupInterval = null;
      logger.debug('Stopped automatic memory cleanup');
    }
  }

  /**
   * Clean up all resources (for testing and shutdown)
   */
  public async cleanup(): Promise<void> {
    this.stopMemoryCleanup();
    this.clearMemoryCache();

    try {
      await this.metricsTracker.flush();
    } catch (_error) {
      // Ignore cleanup flush errors
    }
    this.metricsTracker.dispose();

    if (this.nlpScoring && typeof (this.nlpScoring as any).dispose === 'function') {
      (this.nlpScoring as any).dispose();
    }

    // Release file lock if held
    if (this.fileLock) {
      await this.fileLock.release().catch(() => {});
    }
  }
}
