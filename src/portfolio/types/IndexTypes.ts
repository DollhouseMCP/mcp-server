/**
 * Shared types for Enhanced Index system
 *
 * This file contains types used by EnhancedIndexManager, RelationshipManager,
 * and VerbTriggerManager to prevent circular dependencies.
 *
 * These are the core data structures for the semantic search and relationship
 * discovery system.
 */

import { BaseRelationship } from './RelationshipTypes.js';

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

/**
 * Index metadata
 */
export interface IndexMetadata {
  version: string;           // Schema version for compatibility
  created: string;           // ISO timestamp
  last_updated: string;      // ISO timestamp
  total_elements: number;

  // Extensible metadata
  [key: string]: any;
}

/**
 * Element definition in the index
 */
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

  // Semantic data for similarity scoring
  semantic?: SemanticData;

  // Custom fields preserved during updates
  custom?: Record<string, any>;

  // Extension point for element-specific fields
  extensions?: Record<string, any>;
}

/**
 * Action definition for verb-based triggers
 */
export interface ActionDefinition {
  description?: string;
  examples?: string[];
  confidence?: number;
  [key: string]: any;
}

/**
 * USE_WHEN pattern for automatic activation
 */
export interface UseWhenPattern {
  condition: string;
  confidence?: number;
  [key: string]: any;
}

/**
 * Relationship type (re-exported from RelationshipTypes)
 */
export type Relationship = BaseRelationship;

/**
 * Semantic data for similarity scoring
 */
export interface SemanticData {
  keywords?: string[];
  concepts?: string[];
  domain?: string;
  complexity?: number;
  [key: string]: any;
}

/**
 * Context tracking for smart injection
 */
export interface ContextTracking {
  keywords: KeywordTracking;
  relationships: RelationshipTracking;
  [key: string]: any;
}

/**
 * Keyword tracking data
 */
export interface KeywordTracking {
  frequency: Record<string, number>;
  recency: Record<string, string>;
  [key: string]: any;
}

/**
 * Relationship tracking data
 */
export interface RelationshipTracking {
  used_with: Record<string, number>;
  [key: string]: any;
}

/**
 * Scoring configuration
 */
export interface ScoringConfig {
  weights?: {
    keyword_match?: number;
    semantic_similarity?: number;
    relationship_strength?: number;
    recency?: number;
    [key: string]: number | undefined;
  };
  thresholds?: {
    min_score?: number;
    auto_inject?: number;
    [key: string]: number | undefined;
  };
  [key: string]: any;
}

/**
 * Index options for building/rebuilding
 */
export interface IndexOptions {
  forceRebuild?: boolean;
  skipValidation?: boolean;
  includeInactive?: boolean;
  [key: string]: any;
}

/**
 * Path between elements (from RelationshipManager)
 */
export interface ElementPath {
  path: string[];
  relationships: string[];  // Simplified - actual type is RelationshipType[] in RelationshipManager
  totalStrength: number;
}
