/**
 * Core element interface that all element types must implement.
 * This provides the foundation for the portfolio system with support for:
 * - Identity and versioning
 * - References to external/internal resources
 * - Extensibility for future features
 * - Ratings and feedback mechanisms
 * - Lifecycle management
 */

import { ElementType } from '../../portfolio/types.js';
import type { ElementGatekeeperPolicy } from '../../handlers/mcp-aql/GatekeeperTypes.js';

// Core identity and metadata
export interface IElement {
  // Identity
  id: string;
  type: ElementType;
  version: string;
  
  // Metadata
  metadata: IElementMetadata;
  
  // Features
  references?: Reference[];
  extensions?: Record<string, any>;
  ratings?: ElementRatings;
  
  // Core operations
  validate(): ElementValidationResult;
  serialize(): string;
  deserialize(data: string): void;
  receiveFeedback?(feedback: string, context?: FeedbackContext): void;
  
  // Lifecycle (optional)
  beforeActivate?(): Promise<void>;
  activate?(): Promise<void>;
  afterActivate?(): Promise<void>;
  deactivate?(): Promise<void>;
  getStatus(): ElementStatus;
}

// Element metadata common to all types
export interface IElementMetadata {
  name: string;
  description: string;
  type?: ElementType;       // Element type for backward compatibility and type safety
  author?: string;
  version?: string;
  created?: string;
  modified?: string;
  tags?: string[];

  // References support
  dependencies?: ElementDependency[];

  // Extensibility
  custom?: Record<string, any>;

  /**
   * v2.0 dual-field architecture: behavioral directives loaded from YAML frontmatter.
   *
   * During deserialization, managers extract `instructions` from the parsed YAML
   * metadata and assign it to `element.instructions`. This field is then deleted
   * from the metadata object to avoid duplication. Its presence in YAML frontmatter
   * is used to detect v2 format vs v1 (body-text-only) format.
   *
   * @since Issue #602 — Dual-field element architecture
   */
  instructions?: string;

  /**
   * Gatekeeper access-control policy for this element.
   *
   * When the element is active, its policy participates in Layer 2
   * (element policy resolution) of the Gatekeeper enforcement pipeline.
   * {@link resolveElementPolicy} iterates all active elements and evaluates
   * their `gatekeeper` field to determine whether an MCP-AQL operation
   * should be allowed, denied, or require confirmation.
   *
   * Policy fields (all optional):
   * - `allow`  — Operations auto-approved when this element is active
   * - `confirm` — Operations requiring user confirmation
   * - `deny`   — Operations blocked outright
   * - `scopeRestrictions` — Restrict operations to/from specific element types
   *
   * Defined in YAML front matter and validated at both write time
   * ({@link validateGatekeeperPolicy}) and read time via
   * {@link parseElementPolicy}. Malformed policies are logged and stripped.
   *
   * @since Issue #524 — Extended from agents to all element types
   * @see ElementGatekeeperPolicy
   * @see resolveElementPolicy
   */
  gatekeeper?: ElementGatekeeperPolicy;
}

// Reference to external or internal resources
export interface Reference {
  type: ReferenceType;
  uri: string;              // URL, file path, document ID, portfolio reference
  title: string;            // Human-readable name
  description?: string;     // What this reference provides
  required?: boolean;       // Is this reference essential?
  ragEnabled?: boolean;     // Should this be loaded for RAG?
  cacheable?: boolean;      // Can this be cached locally?
  refreshInterval?: number; // How often to refresh (in hours)
}

// Types of references supported
export enum ReferenceType {
  INTERNAL = 'internal',      // Reference to another element
  EXTERNAL = 'external',      // Web URL
  DOCUMENT = 'document',      // Local or RAG document
  REPOSITORY = 'repository',  // Git repository
  API = 'api',               // API endpoint
  PORTFOLIO = 'portfolio'     // Reference within portfolio
}

// Element dependency specification
export interface ElementDependency {
  elementId: string;
  elementType: ElementType;
  versionConstraint?: string;  // e.g., "^1.0.0", ">=2.0.0"
  optional?: boolean;
}

// Validation result for elements
export interface ElementValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  warnings?: ValidationWarning[];
  suggestions?: string[];
}

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  severity?: 'low' | 'medium' | 'high';
}

// Element status tracking
export enum ElementStatus {
  INACTIVE = 'inactive',
  ACTIVATING = 'activating',
  ACTIVE = 'active',
  DEACTIVATING = 'deactivating',
  ERROR = 'error',
  SUSPENDED = 'suspended'
}

// Rating system for continuous improvement
export interface ElementRatings {
  aiRating: number;              // 0-5 stars (AI evaluation)
  userRating?: number;           // 0-5 stars (user feedback)
  ratingCount: number;           // Number of ratings
  lastEvaluated: Date;          // When last evaluated
  confidence: number;            // 0-1 confidence in rating
  
  // Detailed breakdowns (customizable per element type)
  breakdown?: RatingBreakdown;
  
  // Delta tracking
  ratingDelta?: number;         // Difference between AI and user rating
  trend: 'improving' | 'declining' | 'stable';
  
  // Feedback history
  feedbackHistory?: UserFeedback[];
}

// Base rating breakdown - element types can extend this
export interface RatingBreakdown {
  // Base metrics all elements share
  effectiveness: number;         // How well it achieves its purpose
  reliability: number;          // How consistent it is
  usability: number;           // How easy to work with
  
  // Element-specific metrics (via index signature)
  [key: string]: number;
}

// User feedback tracking
export interface UserFeedback {
  timestamp: Date;
  feedback: string;             // Natural language feedback
  sentiment: 'positive' | 'negative' | 'neutral';
  inferredRating?: number;      // Rating inferred from feedback
  context?: FeedbackContext;    // What was happening
  elementVersion?: string;      // Version at time of feedback
}

// Context for feedback
export interface FeedbackContext {
  task?: string;                // What task was being performed
  relatedElements?: string[];   // Other active elements
  sessionId?: string;          // For grouping related feedback
  environmentData?: Record<string, any>;
}

// Schema versioning support
export interface ISchemaVersion {
  schemaVersion?: string;       // Track interface version
  migrate?(fromVersion: string): void;  // Migration support
}