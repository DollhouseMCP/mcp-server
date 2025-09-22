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
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { dump as yamlDump, load as yamlLoad } from 'js-yaml';
import { logger } from '../utils/logger.js';
import { ElementType } from './types.js';
import { PortfolioManager } from './PortfolioManager.js';
import { PortfolioIndexManager, IndexEntry } from './PortfolioIndexManager.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

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

export interface Relationship {
  element: string;      // Target element name
  type?: string;        // Relationship type
  strength?: number;    // Relationship strength/confidence
  metadata?: Record<string, any>;  // Extensible metadata
}

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
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes
  private isBuilding = false;

  private constructor() {
    const portfolioPath = PortfolioManager.getPortfolioPath();
    this.indexPath = path.join(portfolioPath, 'capability-index.yaml');
    logger.debug('EnhancedIndexManager initialized', { indexPath: this.indexPath });
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
    if (options.forceRebuild || this.needsRebuild()) {
      await this.buildIndex(options);
    } else if (!this.index) {
      await this.loadIndex();
    }

    return this.index!;
  }

  /**
   * Load index from YAML file
   */
  private async loadIndex(): Promise<void> {
    try {
      const yamlContent = await fs.readFile(this.indexPath, 'utf-8');
      this.index = yamlLoad(yamlContent) as EnhancedIndex;
      this.lastLoaded = new Date();

      logger.info('Enhanced index loaded', {
        elements: this.index.metadata.total_elements,
        version: this.index.metadata.version
      });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        logger.info('No existing index found, will build new one');
        await this.buildIndex();
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
    if (this.isBuilding) {
      logger.warn('Index build already in progress');
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
          if (options.updateOnly && !options.updateOnly.includes(entry.metadata.name)) {
            // Preserve existing entry
            if (existingIndex?.elements[elementType]?.[entry.metadata.name]) {
              newIndex.elements[elementType][entry.metadata.name] =
                existingIndex.elements[elementType][entry.metadata.name];
              continue;
            }
          }

          // Build element definition
          const elementDef = await this.buildElementDefinition(entry, existingIndex);
          newIndex.elements[elementType][entry.metadata.name] = elementDef;
          newIndex.metadata.total_elements++;

          // Extract action triggers
          this.extractActionTriggers(elementDef, entry.metadata.name, newIndex.action_triggers);
        }
      }

      // Preserve extensions from existing index
      if (existingIndex?.extensions) {
        newIndex.extensions = existingIndex.extensions;
      }

      // Save to file
      await this.saveIndex(newIndex);

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
        type: 'INDEX_REBUILT',
        severity: 'INFO',
        details: {
          elements: newIndex.metadata.total_elements,
          duration
        }
      });

    } finally {
      this.isBuilding = false;
    }
  }

  /**
   * Build element definition from portfolio entry
   */
  private async buildElementDefinition(
    entry: IndexEntry,
    existingIndex: EnhancedIndex | null
  ): Promise<ElementDefinition> {
    const existing = existingIndex?.elements[entry.elementType]?.[entry.metadata.name];

    const definition: ElementDefinition = {
      core: {
        name: entry.metadata.name,
        type: entry.elementType,
        version: entry.metadata.version,
        description: entry.metadata.description,
        created: entry.metadata.created,
        updated: entry.metadata.updated || new Date().toISOString()
      }
    };

    // Add search fields if present
    if (entry.metadata.keywords || entry.metadata.tags || entry.metadata.triggers) {
      definition.search = {
        keywords: entry.metadata.keywords,
        tags: entry.metadata.tags,
        triggers: entry.metadata.triggers
      };
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

    // Generate based on element type
    switch (entry.elementType) {
      case 'personas':
        if (entry.metadata.name.includes('debug')) {
          actions.debug = { verb: 'debug', behavior: 'activate', confidence: 0.8 };
          actions.fix = { verb: 'fix', behavior: 'activate', confidence: 0.7 };
        }
        if (entry.metadata.name.includes('creative')) {
          actions.write = { verb: 'write', behavior: 'activate', confidence: 0.8 };
          actions.create = { verb: 'create', behavior: 'activate', confidence: 0.8 };
        }
        break;

      case 'memories':
        if (entry.metadata.name.includes('session')) {
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

  /**
   * Extract action triggers from element definition
   */
  private extractActionTriggers(
    elementDef: ElementDefinition,
    elementName: string,
    triggers: Record<string, string[]>
  ): void {
    if (!elementDef.actions) return;

    for (const [actionKey, action] of Object.entries(elementDef.actions)) {
      const verb = action.verb || actionKey;

      if (!triggers[verb]) {
        triggers[verb] = [];
      }

      if (!triggers[verb].includes(elementName)) {
        triggers[verb].push(elementName);
      }
    }
  }

  /**
   * Save index to YAML file
   */
  private async saveIndex(index: EnhancedIndex): Promise<void> {
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
      if (!validation.isValid) {
        throw new Error(`Invalid Unicode in index: ${validation.error}`);
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
  private needsRebuild(): boolean {
    if (!this.index || !this.lastLoaded) return true;

    const age = Date.now() - this.lastLoaded.getTime();
    return age > this.TTL_MS;
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
    for (const [type, elements] of Object.entries(index.elements)) {
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
      await this.saveIndex(index);
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

    await this.saveIndex(index);
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

      for (const [name, element] of Object.entries(elements)) {
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
}