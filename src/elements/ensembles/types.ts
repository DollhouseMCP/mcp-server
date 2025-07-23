/**
 * Type definitions for Ensemble elements
 * 
 * Ensembles are collections of elements that work together as a cohesive unit.
 * They support various activation strategies and conflict resolution mechanisms.
 */

import { IElement, IElementMetadata } from '../../types/elements/index.js';

/**
 * Activation strategy determines how elements within an ensemble are activated
 * 
 * Note: All strategies activate elements to work as a unified entity.
 * Elements are layered/combined rather than acting as separate entities.
 */
export type ActivationStrategy = 
  | 'all'          // Activate all elements simultaneously as one unit
  | 'sequential'   // Activate elements one by one in dependency order
  | 'lazy'         // Activate elements only when needed
  | 'conditional'  // Activate based on rules/conditions
  | 'priority';    // Activate in priority order

/**
 * Conflict resolution strategy for when multiple elements affect the same context
 */
export type ConflictResolutionStrategy = 
  | 'last-write'   // Last element to write wins
  | 'first-write'  // First element to write wins
  | 'priority'     // Higher priority element wins
  | 'merge'        // Attempt to merge values
  | 'error';       // Throw error on conflict

/**
 * Element role within an ensemble
 */
export type ElementRole = 
  | 'primary'      // Main functionality provider
  | 'support'      // Augments primary elements
  | 'override'     // Can override other elements
  | 'monitor';     // Observes but doesn't interfere

/**
 * Ensemble-specific metadata
 */
export interface EnsembleMetadata extends IElementMetadata {
  activationStrategy?: ActivationStrategy;
  conflictResolution?: ConflictResolutionStrategy;
  maxElements?: number;
  maxActivationTime?: number;  // Milliseconds
  allowNested?: boolean;
  maxNestingDepth?: number;
}

/**
 * Element reference within an ensemble
 */
export interface EnsembleElement {
  elementId: string;
  elementType: string;
  role: ElementRole;
  priority?: number;
  activationCondition?: string;  // Simple condition expression
  dependencies?: string[];       // Other element IDs this depends on
}

/**
 * Activation result for an element
 */
export interface ElementActivationResult {
  elementId: string;
  success: boolean;
  duration: number;  // Milliseconds
  error?: Error;
  context?: Record<string, any>;
}

/**
 * Shared context that elements can read/write
 */
export interface SharedContext {
  values: Map<string, any>;
  owners: Map<string, string>;  // key -> elementId that set it
  timestamps: Map<string, Date>;
}

/**
 * Conflict detected during context updates
 */
export interface ContextConflict {
  key: string;
  currentValue: any;
  currentOwner: string;
  newValue: any;
  newOwner: string;
  resolution?: any;  // Resolved value if merge strategy used
}

/**
 * Ensemble activation result
 */
export interface EnsembleActivationResult {
  success: boolean;
  activatedElements: string[];
  failedElements: string[];
  conflicts: ContextConflict[];
  totalDuration: number;
  elementResults: ElementActivationResult[];
}

/**
 * Circular dependency information
 */
export interface CircularDependency {
  path: string[];  // Element IDs forming the cycle
  message: string;
}