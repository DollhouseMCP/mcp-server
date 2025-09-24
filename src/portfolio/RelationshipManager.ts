/**
 * Relationship Manager - Discovers and manages cross-element relationships
 *
 * Implements GraphRAG-style relationship tracking between elements:
 * - similar_to: Semantic similarity (Jaccard-based)
 * - used_by / uses: Usage dependencies
 * - prerequisite_for / depends_on: Learning paths
 * - helps_debug / debugged_by: Debugging relationships
 * - contradicts / supports: Conflicting or supporting elements
 *
 * Features:
 * - Automatic relationship discovery from content
 * - Graph traversal for relationship paths
 * - Relationship strength scoring
 * - Bidirectional relationship tracking
 */

import { logger } from '../utils/logger.js';
import { EnhancedIndex, ElementDefinition, Relationship } from './EnhancedIndexManager.js';
import { NLPScoringManager } from './NLPScoringManager.js';
import { VerbTriggerManager } from './VerbTriggerManager.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/**
 * Relationship types and their inverse mappings
 */
export const RELATIONSHIP_TYPES = {
  // Similarity relationships
  similar_to: 'similar_to',  // Bidirectional

  // Usage relationships
  uses: 'used_by',
  used_by: 'uses',

  // Dependency relationships
  prerequisite_for: 'depends_on',
  depends_on: 'prerequisite_for',
  requires: 'required_by',
  required_by: 'requires',

  // Debugging relationships
  helps_debug: 'debugged_by',
  debugged_by: 'helps_debug',

  // Support/conflict relationships
  supports: 'supported_by',
  supported_by: 'supports',
  contradicts: 'contradicts',  // Bidirectional
  complements: 'complements',  // Bidirectional

  // Hierarchical relationships
  parent_of: 'child_of',
  child_of: 'parent_of',
  contains: 'contained_by',
  contained_by: 'contains',

  // Temporal relationships
  follows: 'preceded_by',
  preceded_by: 'follows',

  // Example relationships
  example_of: 'has_example',
  has_example: 'example_of'
} as const;

export type RelationshipType = keyof typeof RELATIONSHIP_TYPES;

/**
 * Relationship discovery configuration
 */
export interface RelationshipConfig {
  // Minimum confidence to establish relationship
  minConfidence?: number;

  // Maximum relationships per element
  maxRelationshipsPerElement?: number;

  // Enable automatic discovery
  enableAutoDiscovery?: boolean;

  // Custom relationship patterns
  customPatterns?: RelationshipPattern[];
}

/**
 * Pattern for discovering relationships
 */
export interface RelationshipPattern {
  type: RelationshipType;
  pattern: RegExp;
  confidence: number;
  bidirectional?: boolean;
}

/**
 * Graph traversal options
 */
export interface TraversalOptions {
  maxDepth?: number;
  relationshipTypes?: RelationshipType[];
  minStrength?: number;
  visited?: Set<string>;
}

/**
 * Path between elements
 */
export interface ElementPath {
  path: string[];
  relationships: RelationshipType[];
  totalStrength: number;
}

export class RelationshipManager {
  private static instance: RelationshipManager | null = null;
  private nlpScoring: NLPScoringManager;
  private verbTriggers: VerbTriggerManager;
  private config: RelationshipConfig;

  // Default patterns for relationship discovery
  private readonly defaultPatterns: RelationshipPattern[] = [
    // Usage patterns
    { type: 'uses', pattern: /uses?\s+(\w+[-\w]*)/gi, confidence: 0.8 },
    { type: 'uses', pattern: /requires?\s+(\w+[-\w]*)/gi, confidence: 0.7 },
    { type: 'uses', pattern: /depends?\s+on\s+(\w+[-\w]*)/gi, confidence: 0.7 },

    // Prerequisite patterns
    { type: 'prerequisite_for', pattern: /prerequisite\s+for\s+(\w+[-\w]*)/gi, confidence: 0.9 },
    { type: 'depends_on', pattern: /after\s+(\w+[-\w]*)/gi, confidence: 0.6 },

    // Debug patterns
    { type: 'helps_debug', pattern: /debug(?:s|ging)?\s+(\w+[-\w]*)/gi, confidence: 0.7 },
    { type: 'helps_debug', pattern: /troubleshoot(?:s|ing)?\s+(\w+[-\w]*)/gi, confidence: 0.7 },

    // Support patterns
    { type: 'supports', pattern: /supports?\s+(\w+[-\w]*)/gi, confidence: 0.8 },
    { type: 'complements', pattern: /complements?\s+(\w+[-\w]*)/gi, confidence: 0.8 },
    { type: 'contradicts', pattern: /contradicts?\s+(\w+[-\w]*)/gi, confidence: 0.9 },

    // Example patterns
    { type: 'example_of', pattern: /example\s+of\s+(\w+[-\w]*)/gi, confidence: 0.9 },
    { type: 'has_example', pattern: /see\s+(\w+[-\w]*)\s+for\s+example/gi, confidence: 0.7 }
  ];

  private constructor(config: RelationshipConfig = {}) {
    this.config = {
      minConfidence: config.minConfidence || 0.5,
      maxRelationshipsPerElement: config.maxRelationshipsPerElement || 20,
      enableAutoDiscovery: config.enableAutoDiscovery !== false,
      customPatterns: config.customPatterns || []
    };

    this.nlpScoring = new NLPScoringManager();
    this.verbTriggers = VerbTriggerManager.getInstance();

    logger.debug('RelationshipManager initialized', { config: this.config });
  }

  public static getInstance(config?: RelationshipConfig): RelationshipManager {
    if (!this.instance) {
      this.instance = new RelationshipManager(config);
    }
    return this.instance;
  }

  /**
   * Discover relationships for all elements in the index
   */
  public async discoverRelationships(index: EnhancedIndex): Promise<void> {
    const startTime = Date.now();
    let relationshipsFound = 0;

    // FIX: Add timeout to prevent infinite loops
    const MAX_DISCOVERY_TIME = 3000; // 3 seconds max

    logger.info('Starting relationship discovery');

    // First, ensure semantic relationships are calculated
    // (This is already done in EnhancedIndexManager)

    // Then discover other relationship types
    for (const [type, elements] of Object.entries(index.elements)) {
      for (const [name, element] of Object.entries(elements)) {
        // FIX: Check timeout
        if (Date.now() - startTime > MAX_DISCOVERY_TIME) {
          logger.warn('Relationship discovery timeout', {
            elapsed: Date.now() - startTime,
            relationshipsFound
          });
          return;
        }
        const discovered = await this.discoverElementRelationships(
          element,
          `${type}:${name}`,
          index
        );

        // Merge discovered relationships with existing ones
        if (discovered.length > 0) {
          if (!element.relationships) {
            element.relationships = {};
          }

          for (const rel of discovered) {
            const relType = rel.type?.split('_').join('_') || 'related';
            if (!element.relationships[relType]) {
              element.relationships[relType] = [];
            }

            // Check if relationship already exists
            const existing = element.relationships[relType].find(
              r => r.element === rel.element
            );

            if (!existing) {
              element.relationships[relType].push(rel);
              relationshipsFound++;

              // Add inverse relationship if needed
              await this.addInverseRelationship(rel, `${type}:${name}`, index);
            }
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.info('Relationship discovery completed', {
      duration: `${duration}ms`,
      relationshipsFound
    });
  }

  /**
   * Discover relationships for a single element
   */
  private async discoverElementRelationships(
    element: ElementDefinition,
    elementId: string,
    index: EnhancedIndex
  ): Promise<Relationship[]> {
    const relationships: Relationship[] = [];

    if (!this.config.enableAutoDiscovery) {
      return relationships;
    }

    // Combine text from various fields for analysis
    const text = this.getElementText(element);

    // Apply patterns to discover relationships
    const patterns = [...this.defaultPatterns, ...(this.config.customPatterns || [])];

    for (const pattern of patterns) {
      const matches = text.matchAll(pattern.pattern);

      for (const match of matches) {
        const targetName = match[1];

        // Find matching element
        const targetElement = this.findElementByName(targetName, index);
        if (targetElement && targetElement !== elementId) {
          relationships.push({
            element: targetElement,
            type: pattern.type,
            strength: pattern.confidence,
            metadata: {
              discoveryMethod: 'pattern',
              pattern: pattern.pattern.source
            }
          });
        }
      }
    }

    // Discover verb-based relationships (fixed: now passes index to avoid circular dependency)
    const verbRelationships = this.discoverVerbRelationships(element, elementId, index);
    relationships.push(...verbRelationships);

    // Filter by confidence and limit
    const filtered = relationships
      .filter(r => (r.strength || 0) >= this.config.minConfidence!)
      .sort((a, b) => (b.strength || 0) - (a.strength || 0))
      .slice(0, this.config.maxRelationshipsPerElement);

    return filtered;
  }

  /**
   * Discover relationships based on verb associations
   */
  private discoverVerbRelationships(
    element: ElementDefinition,
    elementId: string,
    index: EnhancedIndex
  ): Relationship[] {
    const relationships: Relationship[] = [];

    try {
      // Get verbs associated with this element
      const [, name] = elementId.split(':');
      const verbs = this.verbTriggers.getVerbsForElement(name, index);

      for (const verb of verbs) {
        // Find other elements with same verb
        const matches = this.verbTriggers.getElementsForVerb(verb, index);

        for (const match of matches) {
          if (match.name !== name) {
            // Determine relationship type based on verb category
            const category = this.verbTriggers.getVerbCategory(verb);
            let relType: RelationshipType = 'similar_to';

            switch (category) {
              case 'debugging':
                relType = 'helps_debug';
                break;
              case 'creation':
                relType = 'complements';
                break;
              case 'explanation':
                relType = 'supports';
                break;
              case 'analysis':
                relType = 'complements';
                break;
            }

            relationships.push({
              element: `${match.type}:${match.name}`,
              type: relType,
              strength: match.confidence * 0.7,  // Slightly lower confidence for verb-based
              metadata: {
                discoveryMethod: 'verb',
                verb,
                category
              }
            });
          }
        }
      }
    } catch (error) {
      // If verb trigger fails, just continue without verb-based relationships
      logger.debug('Verb-based relationship discovery failed', { elementId, error });
    }

    return relationships;
  }

  /**
   * Add inverse relationship if applicable
   */
  private async addInverseRelationship(
    relationship: Relationship,
    sourceElement: string,
    index: EnhancedIndex
  ): Promise<void> {
    const relType = relationship.type as RelationshipType;
    const inverseType = RELATIONSHIP_TYPES[relType];

    if (!inverseType || inverseType === relType) {
      // Bidirectional or no inverse
      return;
    }

    const [targetType, targetName] = relationship.element.split(':');
    const targetElement = index.elements[targetType]?.[targetName];

    if (!targetElement) {
      return;
    }

    if (!targetElement.relationships) {
      targetElement.relationships = {};
    }

    if (!targetElement.relationships[inverseType]) {
      targetElement.relationships[inverseType] = [];
    }

    // Check if inverse already exists
    const existing = targetElement.relationships[inverseType].find(
      r => r.element === sourceElement
    );

    if (!existing) {
      targetElement.relationships[inverseType].push({
        element: sourceElement,
        type: inverseType,
        strength: relationship.strength,
        metadata: {
          ...relationship.metadata,
          inverse: true
        }
      });
    }
  }

  /**
   * Find element by partial name match
   */
  private findElementByName(name: string, index: EnhancedIndex): string | null {
    const nameLower = name.toLowerCase().replace(/[_-]/g, '');

    for (const [type, elements] of Object.entries(index.elements)) {
      for (const [elementName, element] of Object.entries(elements)) {
        const elementNameLower = elementName.toLowerCase().replace(/[_-]/g, '');

        // Check exact match first
        if (elementNameLower === nameLower) {
          return `${type}:${elementName}`;
        }

        // Check if element name contains the search term
        if (elementNameLower.includes(nameLower) || nameLower.includes(elementNameLower)) {
          return `${type}:${elementName}`;
        }

        // Check display name
        const displayNameLower = element.core.name?.toLowerCase().replace(/[_-]/g, '');
        if (displayNameLower && (displayNameLower === nameLower || displayNameLower.includes(nameLower))) {
          return `${type}:${elementName}`;
        }
      }
    }

    return null;
  }

  /**
   * Get combined text from element for analysis
   */
  private getElementText(element: ElementDefinition): string {
    const parts: string[] = [];

    // Core fields
    if (element.core.name) parts.push(element.core.name);
    if (element.core.description) parts.push(element.core.description);

    // Keywords and tags from search optimization
    if (element.search?.keywords) parts.push(...element.search.keywords);
    if (element.search?.tags) parts.push(...element.search.tags);

    // Custom fields (might contain relevant text)
    if (element.custom) {
      const customText = this.extractTextFromObject(element.custom);
      if (customText) parts.push(customText);
    }

    // Normalize Unicode for security (DMCP-SEC-004)
    const combinedText = parts.join(' ');
    const validation = UnicodeValidator.normalize(combinedText);
    if (validation.detectedIssues && validation.detectedIssues.length > 0) {
      logger.warn('Unicode issues in relationship text', { issues: validation.detectedIssues });
    }

    return validation.normalizedContent;
  }

  /**
   * Extract text from nested object
   */
  private extractTextFromObject(obj: any): string {
    const texts: string[] = [];

    for (const value of Object.values(obj)) {
      if (typeof value === 'string') {
        texts.push(value);
      } else if (Array.isArray(value)) {
        texts.push(...value.filter(v => typeof v === 'string'));
      } else if (typeof value === 'object' && value !== null) {
        const nested = this.extractTextFromObject(value);
        if (nested) texts.push(nested);
      }
    }

    return texts.join(' ');
  }

  /**
   * Find shortest path between two elements
   */
  public findPath(
    fromElement: string,
    toElement: string,
    index: EnhancedIndex,
    options: TraversalOptions = {}
  ): ElementPath | null {
    const {
      maxDepth = 5,
      relationshipTypes,
      minStrength = 0,
      visited = new Set()
    } = options;

    // BFS to find shortest path
    const queue: ElementPath[] = [{
      path: [fromElement],
      relationships: [],
      totalStrength: 1.0
    }];

    visited.add(fromElement);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.path.length > maxDepth) {
        continue;
      }

      const currentElement = current.path[current.path.length - 1];

      if (currentElement === toElement) {
        return current;
      }

      // Get relationships from current element
      const [type, name] = currentElement.split(':');
      const element = index.elements[type]?.[name];

      if (!element?.relationships) {
        continue;
      }

      // Explore all relationships
      for (const [relType, relations] of Object.entries(element.relationships)) {
        // Filter by relationship types if specified
        if (relationshipTypes && !relationshipTypes.includes(relType as RelationshipType)) {
          continue;
        }

        for (const rel of relations) {
          // Filter by strength
          if ((rel.strength || 0) < minStrength) {
            continue;
          }

          if (!visited.has(rel.element)) {
            visited.add(rel.element);

            queue.push({
              path: [...current.path, rel.element],
              relationships: [...current.relationships, relType as RelationshipType],
              totalStrength: current.totalStrength * (rel.strength || 0.5)
            });
          }
        }
      }
    }

    return null;
  }

  /**
   * Get all connected elements within a certain depth
   */
  public getConnectedElements(
    element: string,
    index: EnhancedIndex,
    options: TraversalOptions = {}
  ): Map<string, ElementPath> {
    const {
      maxDepth = 2,
      relationshipTypes,
      minStrength = 0
    } = options;

    const connected = new Map<string, ElementPath>();
    const visited = new Set<string>([element]);

    const queue: ElementPath[] = [{
      path: [element],
      relationships: [],
      totalStrength: 1.0
    }];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.path.length > maxDepth + 1) {
        continue;
      }

      const currentElement = current.path[current.path.length - 1];
      const [type, name] = currentElement.split(':');
      const elementDef = index.elements[type]?.[name];

      if (!elementDef?.relationships) {
        continue;
      }

      for (const [relType, relations] of Object.entries(elementDef.relationships)) {
        if (relationshipTypes && !relationshipTypes.includes(relType as RelationshipType)) {
          continue;
        }

        for (const rel of relations) {
          if ((rel.strength || 0) < minStrength) {
            continue;
          }

          if (!visited.has(rel.element)) {
            visited.add(rel.element);

            const path: ElementPath = {
              path: [...current.path, rel.element],
              relationships: [...current.relationships, relType as RelationshipType],
              totalStrength: current.totalStrength * (rel.strength || 0.5)
            };

            connected.set(rel.element, path);

            if (current.path.length < maxDepth) {
              queue.push(path);
            }
          }
        }
      }
    }

    return connected;
  }

  /**
   * Get relationship statistics for the index
   */
  public getRelationshipStats(index: EnhancedIndex): Record<string, number> {
    const stats: Record<string, number> = {
      totalRelationships: 0,
      elementsWithRelationships: 0
    };

    // Count by relationship type
    for (const relType of Object.keys(RELATIONSHIP_TYPES)) {
      stats[relType] = 0;
    }

    for (const elements of Object.values(index.elements)) {
      for (const element of Object.values(elements)) {
        if (element.relationships) {
          stats.elementsWithRelationships++;

          for (const [relType, relations] of Object.entries(element.relationships)) {
            const count = relations.length;
            stats.totalRelationships += count;
            stats[relType] = (stats[relType] || 0) + count;
          }
        }
      }
    }

    return stats;
  }
}