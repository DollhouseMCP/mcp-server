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

import * as fs from 'fs/promises';
import * as path from 'path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { logger } from '../utils/logger.js';
import { PortfolioIndexManager, IndexEntry } from './PortfolioIndexManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { NLPScoringManager } from './NLPScoringManager.js';
import { VerbTriggerManager } from './VerbTriggerManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { IndexConfigManager, IndexConfiguration } from './config/IndexConfig.js';
import { FileLock } from '../utils/FileLock.js';
import { parseElementId, parseElementIdStrict, formatElementId } from '../utils/elementId.js';
import { RelationshipManager, ElementPath } from './RelationshipManager.js';
import {
  BaseRelationship,
  createRelationship,
  RelationshipTypes
} from './types/RelationshipTypes.js';

/**
 * Enhanced index schema - fully extensible
 */
export interface EnhancedIndex {
  // Metadata about the index itself
  metadata: IndexMetadata;

  // Verb-based action triggers (extensible)
  action_triggers: Record<string, string[]>;

  // Element definitions (extensible types and fields)
  elements: Record<string, Record<string, ElementDefinition>>;

  // Context tracking for smart injection
  context?: ContextTracking;

  // Scoring configuration
  scoring?: ScoringConfig;

  // Extension point for future features
  extensions?: Record<string, any>;
}

export interface IndexMetadata {
  version: string;           // Schema version for compatibility
  created: string;           // ISO timestamp
  last_updated: string;      // ISO timestamp
  total_elements: number;

  // Extensible metadata
  [key: string]: any;
}

export interface ElementDefinition {
  // Core fields (always present)
  core: {
    name: string;
    type: string;
    version?: string;
    description?: string;
    created?: string;
    updated?: string;
  };

  // Search optimization
  search?: {
    keywords?: string[];
    tags?: string[];
    triggers?: string[];
  };

  // Verb-based actions (extensible)
  actions?: Record<string, ActionDefinition>;

  // USE_WHEN patterns for automatic activation
  use_when?: UseWhenPattern[];

  // Cross-element relationships
  relationships?: Record<string, Relationship[]>;

  // Context snippets for injection
  context_snippets?: Record<string, string>;

  // Semantic scoring data
  semantic?: SemanticData;

  // Extension point - any custom fields
  custom?: Record<string, any>;
}

export interface ActionDefinition {
  verb: string;
  behavior?: string;
  confidence?: number;

  // Extensible action properties
  [key: string]: any;
}

export interface UseWhenPattern {
  pattern: string;      // Regex pattern
  confidence: number;   // 0-1 confidence score
  description?: string;

  // Extensible pattern properties
  [key: string]: any;
}

/**
 * Re-export BaseRelationship as Relationship for backward compatibility
 *
 * This maintains API compatibility with existing code while the internal
 * implementation now uses type-safe variants (ParsedRelationship, InvalidRelationship).
 * Existing code using the 'Relationship' type will continue to work without changes.
 */
export type Relationship = BaseRelationship;

export interface SemanticData {
  entropy?: number;           // Shannon entropy
  unique_terms?: number;
  total_terms?: number;
  jaccard_scores?: Record<string, number>;  // Pairwise similarities

  // Extensible semantic properties
  [key: string]: any;
}

export interface ContextTracking {
  recent_keywords: KeywordTracking[];
  active_relationships?: RelationshipTracking[];

  // Extensible context properties
  [key: string]: any;
}

export interface KeywordTracking {
  term: string;
  frequency: number;
  last_seen: string;
  weight: number;
}

export interface RelationshipTracking {
  from: string;
  to: string;
  strength: number;
  reason?: string;
}

export interface ScoringConfig {
  jaccard_weights?: Record<string, number>;
  entropy_thresholds?: Record<string, number>;
  context_decay?: {
    half_life_minutes: number;
    minimum_weight: number;
  };

  // Extensible scoring properties
  [key: string]: any;
}

/**
 * Options for index operations
 */
export interface IndexOptions {
  forceRebuild?: boolean;
  updateOnly?: string[];  // Only update specific elements
  preserveCustom?: boolean;  // Preserve custom fields during update
}

export class EnhancedIndexManager {
  private static instance: EnhancedIndexManager | null = null;
  private index: EnhancedIndex | null = null;
  private indexPath: string;
  private lastLoaded: Date | null = null;
  private TTL_MS: number;
  private isBuilding = false;  // Track if index is being built
  private nlpScoring: NLPScoringManager;
  private verbTriggers: VerbTriggerManager;
  private relationshipManager: RelationshipManager;
  private config: IndexConfigManager;
  private fileLock: FileLock;
  private memoryCleanupInterval: NodeJS.Timeout | null = null;
  private lastMemoryCleanup: Date = new Date();

  private constructor() {
    const portfolioPath = path.join(process.env.HOME || '', '.dollhouse', 'portfolio');
    this.indexPath = path.join(portfolioPath, 'capability-index.yaml');

    // Initialize configuration
    this.config = IndexConfigManager.getInstance();
    const config = this.config.getConfig();
    this.TTL_MS = config.index.ttlMinutes * 60 * 1000;

    // Load enhanced index config from global ConfigManager
    this.loadEnhancedIndexConfig();

    // Initialize components with config
    this.nlpScoring = new NLPScoringManager({
      cacheExpiry: config.nlp.cacheExpiryMinutes * 60 * 1000,
      minTokenLength: config.nlp.minTokenLength,
      entropyBands: config.nlp.entropyBands,
      jaccardThresholds: config.nlp.jaccardThresholds
    });

    this.verbTriggers = VerbTriggerManager.getInstance({
      confidenceThreshold: config.verbs.confidenceThreshold,
      maxElementsPerVerb: config.verbs.maxElementsPerVerb,
      includeSynonyms: config.verbs.includeSynonyms
    });

    // Initialize relationship manager
    this.relationshipManager = RelationshipManager.getInstance({
      minConfidence: config.performance.similarityThreshold,
      enableAutoDiscovery: true
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

  public static getInstance(): EnhancedIndexManager {
    if (!this.instance) {
      this.instance = new EnhancedIndexManager();
    }
    return this.instance;
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
      const yamlContent = await fs.readFile(this.indexPath, 'utf-8');

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
      const portfolioIndex = PortfolioIndexManager.getInstance();
      const portfolioData = await portfolioIndex.getIndex();

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

          // Build element definition
          const elementDef = await this.buildElementDefinition(entry, existingIndex);
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

  /**
   * Build element definition from portfolio entry
   */
  private async buildElementDefinition(
    entry: IndexEntry,
    existingIndex: EnhancedIndex | null
  ): Promise<ElementDefinition> {
    // FIX: Add defensive checks for entry.metadata properties
    const entryName = entry.metadata?.name || 'unknown';
    const existing = existingIndex?.elements[entry.elementType]?.[entryName];

    const definition: ElementDefinition = {
      core: {
        name: entryName,
        type: entry.elementType,
        version: entry.metadata?.version,
        description: entry.metadata?.description,
        created: entry.metadata?.created,
        updated: entry.metadata?.updated || new Date().toISOString()
      }
    };

    // Add search fields if present
    // FIX: Add defensive checks for metadata properties
    if (entry.metadata?.keywords || entry.metadata?.tags || entry.metadata?.triggers) {
      definition.search = {
        keywords: entry.metadata?.keywords,
        tags: entry.metadata?.tags,
        triggers: entry.metadata?.triggers
      };

      // Debug logging for trigger extraction
      if (entry.metadata?.triggers && entry.metadata.triggers.length > 0) {
        logger.debug('Found triggers for element', {
          name: entryName,
          type: entry.elementType,
          triggers: entry.metadata.triggers
        });
      }
    }

    // Preserve custom fields from existing
    if (existing?.custom) {
      definition.custom = existing.custom;
    }

    // Preserve relationships from existing
    if (existing?.relationships) {
      definition.relationships = existing.relationships;
    }

    // Preserve actions from existing
    if (existing?.actions) {
      definition.actions = existing.actions;
    }

    // Auto-generate basic action triggers from name/description
    if (!definition.actions) {
      definition.actions = this.generateDefaultActions(entry);
    }

    return definition;
  }

  /**
   * Generate default actions based on element type and metadata
   */
  private generateDefaultActions(entry: IndexEntry): Record<string, ActionDefinition> | undefined {
    const actions: Record<string, ActionDefinition> = {};

    // FIX: Add defensive check for metadata.name
    const entryName = entry.metadata?.name || '';
    if (!entryName) {
      return undefined;
    }

    // Generate based on element type
    switch (entry.elementType) {
      case 'personas':
        if (entryName.includes('debug')) {
          actions.debug = { verb: 'debug', behavior: 'activate', confidence: 0.8 };
          actions.fix = { verb: 'fix', behavior: 'activate', confidence: 0.7 };
        }
        if (entryName.includes('creative')) {
          actions.write = { verb: 'write', behavior: 'activate', confidence: 0.8 };
          actions.create = { verb: 'create', behavior: 'activate', confidence: 0.8 };
        }
        break;

      case 'memories':
        if (entryName.includes('session')) {
          actions.recall = { verb: 'recall', behavior: 'retrieve', confidence: 0.7 };
          actions.remember = { verb: 'remember', behavior: 'retrieve', confidence: 0.7 };
        }
        break;

      case 'skills':
        actions.use = { verb: 'use', behavior: 'execute', confidence: 0.6 };
        actions.apply = { verb: 'apply', behavior: 'execute', confidence: 0.6 };
        break;
    }

    return Object.keys(actions).length > 0 ? actions : undefined;
  }

  // Configuration for verb extraction (will be overridden by ConfigManager)
  private static VERB_EXTRACTION_CONFIG = {
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
    // Null safety check
    if (!elementDef) return;

    // Start telemetry tracking if enabled
    const telemetryStartTime = this.startTelemetry('extractActionTriggers');

    // Track unique triggers for this element to prevent duplicates
    const elementTriggers = new Set<string>();
    const triggerCountRef = { count: 0 }; // Use object reference to track count across methods

    // Extract from search.triggers field
    this.extractTriggersFromSearchField(elementDef, elementName, triggers, elementTriggers, triggerCountRef);

    // Extract from actions field
    this.extractTriggersFromActions(elementDef, elementName, triggers, elementTriggers, triggerCountRef);

    // Extract from keywords (limited to prevent DoS)
    this.extractTriggersFromKeywords(elementDef, elementName, triggers, elementTriggers, triggerCountRef);

    // Record telemetry
    this.recordTelemetry('extractActionTriggers', telemetryStartTime, {
      elementName,
      elementType: elementDef.core?.type,
      triggersExtracted: triggerCountRef.count,
      uniqueTriggers: elementTriggers.size,
    });
  }

  /**
   * Extract triggers from search.triggers field
   */
  private extractTriggersFromSearchField(
    elementDef: ElementDefinition,
    elementName: string,
    triggers: Record<string, string[]>,
    elementTriggers: Set<string>,
    triggerCountRef: { count: number }
  ): void {
    if (!elementDef.search?.triggers) return;

    const triggerArray = this.normalizeToArray(elementDef.search.triggers);

    for (const trigger of triggerArray) {
      if (triggerCountRef.count >= EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement) {
        logger.warn('Trigger limit exceeded for element', {
          elementName,
          limit: EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement
        });
        break;
      }

      const normalizedTrigger = this.normalizeTrigger(trigger);
      if (!normalizedTrigger) continue;

      if (!elementTriggers.has(normalizedTrigger)) {
        elementTriggers.add(normalizedTrigger);
        this.addTriggerMapping(normalizedTrigger, elementName, triggers);
        triggerCountRef.count++;
      }
    }
  }

  /**
   * Extract triggers from actions field
   */
  private extractTriggersFromActions(
    elementDef: ElementDefinition,
    elementName: string,
    triggers: Record<string, string[]>,
    elementTriggers: Set<string>,
    triggerCountRef: { count: number }
  ): void {
    if (!elementDef.actions) return;

    for (const [actionKey, action] of Object.entries(elementDef.actions)) {
      if (triggerCountRef.count >= EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement) {
        logger.warn('Trigger limit exceeded for element', {
          elementName,
          limit: EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement
        });
        break;
      }

      const verb = action.verb || actionKey;
      const normalizedVerb = this.normalizeTrigger(verb);
      if (!normalizedVerb) continue;

      if (!elementTriggers.has(normalizedVerb)) {
        elementTriggers.add(normalizedVerb);
        this.addTriggerMapping(normalizedVerb, elementName, triggers);
        triggerCountRef.count++;
      }
    }
  }

  /**
   * Extract verb-like keywords as triggers
   */
  private extractTriggersFromKeywords(
    elementDef: ElementDefinition,
    elementName: string,
    triggers: Record<string, string[]>,
    elementTriggers: Set<string>,
    triggerCountRef: { count: number }
  ): void {
    if (!elementDef.search?.keywords) return;

    const keywords = this.normalizeToArray(elementDef.search.keywords);

    for (const keyword of keywords) {
      if (triggerCountRef.count >= EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement) {
        logger.warn('Trigger limit exceeded for element', {
          elementName,
          limit: EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggersPerElement
        });
        break;
      }

      const normalizedKeyword = this.normalizeTrigger(keyword);
      if (!normalizedKeyword || !this.looksLikeVerb(normalizedKeyword)) continue;

      if (!elementTriggers.has(normalizedKeyword)) {
        elementTriggers.add(normalizedKeyword);
        this.addTriggerMapping(normalizedKeyword, elementName, triggers);
        triggerCountRef.count++;
      }
    }
  }

  /**
   * Normalize a value to an array of strings
   */
  private normalizeToArray(value: any): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter(v => typeof v === 'string');
    }
    if (typeof value === 'string') {
      return [value];
    }
    return [];
  }

  /**
   * Normalize and validate a trigger string
   */
  private normalizeTrigger(trigger: any): string | null {
    if (typeof trigger !== 'string') return null;

    // Trim and lowercase
    const normalized = trigger.trim().toLowerCase();

    // Validate
    if (!normalized ||
        normalized.length > EnhancedIndexManager.VERB_EXTRACTION_CONFIG.limits.maxTriggerLength ||
        !/^[a-z][a-z-]*$/.test(normalized)) {
      return null;
    }

    return normalized;
  }

  /**
   * Add a trigger to element mapping
   * Preserves original element name casing for proper resolution
   *
   * TODO: Future enhancement - Implement persistent trigger indexing for better performance at scale
   *       Could use a dedicated trigger index file with lazy loading and incremental updates
   *
   * TODO: Add trigger usage metrics to track which triggers are most frequently used
   *       This data could be used to optimize Enhanced Index search ranking
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
   * Check if a word looks like a verb using pre-compiled patterns
   * Avoid false positives like "documentation" which ends in "ation" (noun suffix)
   */
  private looksLikeVerb(word: string): boolean {
    const lowerWord = word.toLowerCase();

    // Check for noun suffixes that should NOT be considered verbs
    if (EnhancedIndexManager.NOUN_SUFFIX_PATTERN.test(lowerWord)) {
      return false;
    }

    // Check for verb patterns
    return EnhancedIndexManager.VERB_PREFIX_PATTERN.test(lowerWord) ||
           EnhancedIndexManager.VERB_SUFFIX_PATTERN.test(lowerWord);
  }

  /**
   * Load enhanced index configuration from ConfigManager
   */
  private loadEnhancedIndexConfig(): void {
    try {
      const configManager = ConfigManager.getInstance();
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
          regex.test(str);
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
  private startTelemetry(operationName: string): number | null {
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
      await fs.mkdir(dir, { recursive: true });

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

      await fs.writeFile(this.indexPath, yamlContent, 'utf-8');

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
      const indexStats = await fs.stat(this.indexPath).catch(() => null);
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
   */
  public async getElementsByAction(verb: string): Promise<string[]> {
    const index = await this.getIndex();
    return index.action_triggers[verb] || [];
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

  /**
   * Calculate semantic relationships between elements using NLP
   * Optimized for large numbers of elements
   */
  private async calculateSemanticRelationships(index: EnhancedIndex): Promise<void> {
    const startTime = Date.now();
    const config = this.config.getConfig();

    // FIX: Add timeout circuit breaker to prevent infinite loops
    // FIX: Use configuration instead of hardcoded value
    const MAX_EXECUTION_TIME = config.performance.circuitBreakerTimeoutMs;

    // Prepare text content for each element
    const elementTexts = new Map<string, string>();
    const elementCount = Object.values(index.elements)
      .reduce((sum, elements) => sum + Object.keys(elements).length, 0);

    logger.info('Starting semantic relationship calculation', {
      elementCount,
      maxForFullMatrix: config.performance.maxElementsForFullMatrix
    });

    // First pass: Calculate entropy for all elements
    for (const [elementType, elements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(elements)) {
        // FIX: Check for timeout
        if (Date.now() - startTime > MAX_EXECUTION_TIME) {
          logger.warn('Semantic relationship calculation timeout', {
            elapsed: Date.now() - startTime,
            processed: elementTexts.size
          });
          return;
        }
        // Combine relevant text fields for analysis
        const textParts = [
          element.core.name,
          element.core.description || '',
          ...(element.search?.keywords || []),
          ...(element.search?.tags || []),
          ...(element.search?.triggers || [])
        ];

        const fullText = textParts.join(' ');
        const key = `${elementType}:${name}`;
        elementTexts.set(key, fullText);

        // Calculate entropy for this element
        if (!element.semantic) {
          element.semantic = {};
        }
        element.semantic.entropy = this.nlpScoring.calculateEntropy(fullText);
        element.semantic.unique_terms = fullText.split(/\s+/).filter(t => t.length > 1).length;
      }
    }

    const keys = Array.from(elementTexts.keys());

    // FIX: Use configuration for safety limits
    // These are hard safety limits to prevent runaway memory usage in tests
    const MAX_SAFE_ELEMENTS = 50;  // Hard safety limit for full matrix
    const MAX_SAFE_COMPARISONS = 500;  // Hard safety limit for total comparisons

    // Override config if it's too high
    const safeConfig = {
      ...config,
      performance: {
        ...config.performance,
        maxElementsForFullMatrix: Math.min(config.performance.maxElementsForFullMatrix, MAX_SAFE_ELEMENTS),
        maxSimilarityComparisons: Math.min(config.performance.maxSimilarityComparisons, MAX_SAFE_COMPARISONS)
      }
    };

    // Decide strategy based on element count
    if (elementCount <= safeConfig.performance.maxElementsForFullMatrix) {
      // Small dataset: Calculate all relationships
      await this.calculateFullMatrix(index, elementTexts, keys, safeConfig);
    } else {
      // Large dataset: Use smart sampling and batching
      await this.calculateSampledRelationships(index, elementTexts, keys, safeConfig);
    }

    const duration = Date.now() - startTime;
    logger.info('Semantic relationships calculated', {
      elements: elementTexts.size,
      duration: `${duration}ms`,
      strategy: elementCount <= config.performance.maxElementsForFullMatrix ? 'full' : 'sampled',
      timedOut: duration > MAX_EXECUTION_TIME
    });
  }

  /**
   * Calculate full similarity matrix for small datasets
   */
  private async calculateFullMatrix(
    index: EnhancedIndex,
    elementTexts: Map<string, string>,
    keys: string[],
    config: IndexConfiguration
  ): Promise<void> {
    let comparisons = 0;
    const batchSize = config.performance.similarityBatchSize;
    const threshold = config.performance.similarityThreshold;
    const startTime = Date.now();
    // FIX: Use configuration instead of hardcoded value
    const MAX_EXECUTION_TIME = config.performance.circuitBreakerTimeoutMs;

    // Process in batches to allow event loop to breathe
    for (let i = 0; i < keys.length; i++) {
      // FIX: Check for timeout
      if (Date.now() - startTime > MAX_EXECUTION_TIME) {
        logger.warn('Full matrix calculation timeout', {
          elapsed: Date.now() - startTime,
          processed: `${i}/${keys.length}`,
          comparisons
        });
        return;
      }
      const key1 = keys[i];
      // FIX: Use centralized element ID parsing
      const parsed1 = parseElementIdStrict(key1);
      const text1 = elementTexts.get(key1)!;

      // Process batch of comparisons
      const batch: Array<{ key2: string; type2: string; name2: string }> = [];

      for (let j = i + 1; j < keys.length && batch.length < batchSize; j++) {
        const key2 = keys[j];
        // FIX: Use centralized element ID parsing
        const parsed2 = parseElementIdStrict(key2);
        batch.push({ key2, type2: parsed2.type, name2: parsed2.name });
      }

      // Process batch asynchronously
      await Promise.all(batch.map(async ({ key2, type2, name2 }) => {
        const text2 = elementTexts.get(key2)!;
        const scoring = this.nlpScoring.scoreRelevance(text1, text2);

        // Store high-confidence relationships
        if (scoring.combinedScore > threshold) {
          // Get elements safely
          const element1 = index.elements[parsed1.type]?.[parsed1.name];
          const element2 = index.elements[type2]?.[name2];

          if (!element1 || !element2) return;

          // Add relationship to element1
          if (!element1.relationships) {
            element1.relationships = {};
          }
          if (!element1.relationships.similar) {
            element1.relationships.similar = [];
          }
          element1.relationships.similar.push(createRelationship(
            type2,
            name2,
            RelationshipTypes.SEMANTIC_SIMILARITY,
            scoring.combinedScore,
            {
              jaccard: scoring.jaccard,
              entropy_diff: Math.abs(
                (element1.semantic?.entropy || 0) -
                (element2.semantic?.entropy || 0)
              )
            }
          ));

          // Add reverse relationship to element2
          if (!element2.relationships) {
            element2.relationships = {};
          }
          if (!element2.relationships.similar) {
            element2.relationships.similar = [];
          }
          element2.relationships.similar.push(createRelationship(
            parsed1.type,
            parsed1.name,
            RelationshipTypes.SEMANTIC_SIMILARITY,
            scoring.combinedScore,
            {
              jaccard: scoring.jaccard,
              entropy_diff: Math.abs(
                (element1.semantic?.entropy || 0) -
                (element2.semantic?.entropy || 0)
              )
            }
          ));

          // Store Jaccard scores in semantic data
          if (element1.semantic) {
            if (!element1.semantic.jaccard_scores) {
              element1.semantic.jaccard_scores = {};
            }
            element1.semantic.jaccard_scores[formatElementId(type2, name2)] = scoring.jaccard;
          }

          if (element2.semantic) {
            if (!element2.semantic.jaccard_scores) {
              element2.semantic.jaccard_scores = {};
            }
            element2.semantic.jaccard_scores[formatElementId(parsed1.type, parsed1.name)] = scoring.jaccard;
          }
        }
      }));

      comparisons += batch.length;

      // Yield to event loop periodically
      if (comparisons % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  /**
   * Calculate sampled relationships for large datasets
   * Uses proportional sampling and keyword clustering
   */
  private async calculateSampledRelationships(
    index: EnhancedIndex,
    elementTexts: Map<string, string>,
    keys: string[],
    config: IndexConfiguration
  ): Promise<void> {
    const threshold = config.performance.similarityThreshold;
    const maxComparisons = config.performance.maxSimilarityComparisons;

    logger.info('Using sampled relationship calculation', {
      elements: keys.length,
      maxComparisons
    });

    // FIX: Early return if no keys to process
    if (keys.length === 0) {
      logger.debug('No elements to calculate relationships for');
      return;
    }

    // First Pass: Keyword-based clustering for high-probability relationships
    const keywordClusters = await this.buildKeywordClusters(index, keys);
    let comparisons = 0;

    // Compare within clusters first (high probability of relationships)
    // FIX: Make cluster budget ratio configurable
    const clusterBudgetRatio = 0.6; // 60% of budget for clusters (could be made configurable)
    const clusterComparisons = Math.floor(maxComparisons * clusterBudgetRatio);

    for (const [, clusterKeys] of keywordClusters.entries()) {
      if (comparisons >= clusterComparisons) break;

      // Within-cluster comparisons
      for (let i = 0; i < clusterKeys.length - 1; i++) {
        if (comparisons >= clusterComparisons) break;

        const key1 = clusterKeys[i];
        // FIX: Use centralized element ID parsing
        const parsed1 = parseElementIdStrict(key1);
        const text1 = elementTexts.get(key1)!;

        // Sample from rest of cluster
        const sampleSize = Math.min(
          Math.ceil(Math.sqrt(clusterKeys.length - i - 1)),
          config.sampling.clusterSampleLimit  // Configurable cluster limit
        );

        const sampledIndices = this.randomSample(
          Array.from({ length: clusterKeys.length - i - 1 }, (_, j) => i + j + 1),
          sampleSize
        );

        for (const j of sampledIndices) {
          if (comparisons >= clusterComparisons) break;

          const key2 = clusterKeys[j];
          // FIX: Use centralized element ID parsing
          const parsed2 = parseElementIdStrict(key2);
          const text2 = elementTexts.get(key2)!;

          const scoring = this.nlpScoring.scoreRelevance(text1, text2);
          comparisons++;

          if (scoring.combinedScore > threshold) {
            this.storeRelationship(index, parsed1.type, parsed1.name, parsed2.type, parsed2.name, scoring);
          }
        }
      }

      // Yield to event loop
      if (comparisons % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Second Pass: Proportional cross-type sampling for unexpected relationships
    const crossTypeComparisons = maxComparisons - comparisons; // Remaining budget

    // FIX: Skip second pass if we've already hit our comparison limit
    if (comparisons >= maxComparisons || crossTypeComparisons <= 0) {
      logger.debug('Skipping cross-type sampling, comparison budget exhausted', {
        comparisons,
        maxComparisons
      });
      return;
    }

    // Build type distribution
    const elementsByType = new Map<string, string[]>();
    const typeCounts = new Map<string, number>();

    for (const key of keys) {
      // FIX: Use centralized element ID parsing
      const parsed = parseElementId(key);
      if (!parsed) continue;
      if (!elementsByType.has(parsed.type)) {
        elementsByType.set(parsed.type, []);
        typeCounts.set(parsed.type, 0);
      }
      elementsByType.get(parsed.type)!.push(key);
      typeCounts.set(parsed.type, typeCounts.get(parsed.type)! + 1);
    }

    // Calculate proportional sample sizes
    const totalElements = keys.length;
    const typeSampleSizes = new Map<string, number>();

    for (const [type, count] of typeCounts.entries()) {
      const proportion = count / totalElements;
      // Allocate comparisons proportionally, with minimum of 1
      const allocatedComparisons = Math.max(1, Math.floor(crossTypeComparisons * proportion));
      // Sample size is sqrt of allocated comparisons for efficiency
      const sampleSize = Math.ceil(Math.sqrt(allocatedComparisons));
      typeSampleSizes.set(type, sampleSize);
    }

    logger.debug('Proportional sampling distribution', {
      typeCounts: Object.fromEntries(typeCounts),
      sampleSizes: Object.fromEntries(typeSampleSizes)
    });

    // FIX: Perform LIMITED cross-type sampling to prevent O(n²) explosion
    // Previously: for each key1, sample from EVERY type - this creates n * types * sampleSize comparisons!
    // Now: Sample a subset of keys first, then process those

    // Sample a limited number of keys to process (sqrt of total for balanced coverage)
    const maxKeysToProcess = Math.min(
      Math.ceil(Math.sqrt(keys.length)),
      Math.ceil(crossTypeComparisons / typeSampleSizes.size)
    );

    const sampledKeys1 = this.randomSample(keys, maxKeysToProcess);

    logger.debug('Cross-type sampling with limited key set', {
      totalKeys: keys.length,
      sampledKeys: sampledKeys1.length,
      maxKeysToProcess
    });

    // Perform proportional cross-type sampling on LIMITED key set
    for (const key1 of sampledKeys1) {
      if (comparisons >= maxComparisons) break;

      // FIX: Use centralized element ID parsing
      const parsed1 = parseElementIdStrict(key1);
      const text1 = elementTexts.get(key1)!;

      // Sample from each type proportionally
      for (const [type, typeKeys] of elementsByType.entries()) {
        if (comparisons >= maxComparisons) break;

        const sampleSize = typeSampleSizes.get(type) || 1;
        const sampledKeys = this.randomSample(typeKeys, Math.min(sampleSize, typeKeys.length))
          .filter(k => k !== key1);

        for (const key2 of sampledKeys) {
          if (comparisons >= maxComparisons) break;

          // FIX: Use centralized element ID parsing
          const parsed2 = parseElementIdStrict(key2);
          const text2 = elementTexts.get(key2)!;

          const scoring = this.nlpScoring.scoreRelevance(text1, text2);
          comparisons++;

          if (scoring.combinedScore > threshold) {
            this.storeRelationship(index, parsed1.type, parsed1.name, parsed2.type, parsed2.name, scoring);
          }
        }
      }

      // Yield to event loop
      if (comparisons % 100 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    logger.info('Sampled relationships calculated', {
      comparisons,
      maxComparisons,
      clusterComparisons,
      crossTypeComparisons: comparisons - clusterComparisons
    });
  }

  /**
   * Build keyword clusters for first-pass relationship discovery
   */
  private async buildKeywordClusters(
    index: EnhancedIndex,
    keys: string[]
  ): Promise<Map<string, string[]>> {
    const clusters = new Map<string, string[]>();
    const keywordFrequency = new Map<string, number>();

    // Extract keywords from all elements
    for (const key of keys) {
      // FIX: Use centralized element ID parsing
      const parsed = parseElementIdStrict(key);
      const element = index.elements[parsed.type][parsed.name];
      const keywords = [
        ...(element.search?.keywords || []),
        ...(element.search?.tags || [])
      ];

      for (const keyword of keywords) {
        const normalized = keyword.toLowerCase();
        keywordFrequency.set(normalized, (keywordFrequency.get(normalized) || 0) + 1);

        if (!clusters.has(normalized)) {
          clusters.set(normalized, []);
        }
        clusters.get(normalized)!.push(key);
      }
    }

    // Keep only significant clusters (appears in at least 2 elements but not more than 50% of elements)
    const significantClusters = new Map<string, string[]>();
    const maxFrequency = Math.floor(keys.length * 0.5);

    for (const [keyword, elementKeys] of clusters.entries()) {
      if (elementKeys.length >= 2 && elementKeys.length <= maxFrequency) {
        significantClusters.set(keyword, elementKeys);
      }
    }

    logger.debug('Keyword clusters built', {
      totalClusters: clusters.size,
      significantClusters: significantClusters.size,
      largestCluster: Math.max(...Array.from(significantClusters.values()).map(v => v.length))
    });

    return significantClusters;
  }

  /**
   * Store a bidirectional relationship between elements
   */
  private storeRelationship(
    index: EnhancedIndex,
    type1: string,
    name1: string,
    type2: string,
    name2: string,
    scoring: any
  ): void {
    // Add relationship to element1
    if (!index.elements[type1][name1].relationships) {
      index.elements[type1][name1].relationships = {};
    }
    if (!index.elements[type1][name1].relationships.similar) {
      index.elements[type1][name1].relationships.similar = [];
    }

    // Check if relationship already exists to avoid duplicates
    const targetElement = formatElementId(type2, name2);
    const existing1 = index.elements[type1][name1].relationships.similar
      .find(r => r.element === targetElement);

    if (!existing1) {
      index.elements[type1][name1].relationships.similar.push(createRelationship(
        type2,
        name2,
        RelationshipTypes.SEMANTIC_SIMILARITY,
        scoring.combinedScore,
        {
          jaccard: scoring.jaccard,
          entropy_diff: Math.abs(
            (index.elements[type1][name1].semantic?.entropy || 0) -
            (index.elements[type2][name2].semantic?.entropy || 0)
          )
        }
      ));
    }

    // Add reverse relationship
    if (!index.elements[type2][name2].relationships) {
      index.elements[type2][name2].relationships = {};
    }
    if (!index.elements[type2][name2].relationships.similar) {
      index.elements[type2][name2].relationships.similar = [];
    }

    const sourceElement = formatElementId(type1, name1);
    const existing2 = index.elements[type2][name2].relationships.similar
      .find(r => r.element === sourceElement);

    if (!existing2) {
      index.elements[type2][name2].relationships.similar.push(createRelationship(
        type1,
        name1,
        RelationshipTypes.SEMANTIC_SIMILARITY,
        scoring.combinedScore,
        {
          jaccard: scoring.jaccard,
          entropy_diff: Math.abs(
            (index.elements[type1][name1].semantic?.entropy || 0) -
            (index.elements[type2][name2].semantic?.entropy || 0)
          )
        }
      ));
    }
  }

  /**
   * Random sample from array
   */
  private randomSample<T>(array: T[], size: number): T[] {
    const shuffled = [...array].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
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

    // Release file lock if held
    if (this.fileLock) {
      await this.fileLock.release().catch(() => {});
    }

    // Clear the singleton instance
    if (EnhancedIndexManager.instance === this) {
      EnhancedIndexManager.instance = null;
    }
  }

  /**
   * Reset singleton instance (mainly for testing)
   */
  public static resetInstance(): void {
    if (this.instance) {
      this.instance.cleanup().catch(() => {});
      this.instance = null;
    }
  }
}