/**
 * Base abstract class implementing IElement interface.
 * Provides common functionality that all element types can extend.
 */

import {
  IElement,
  IElementMetadata,
  ElementStatus,
  ElementRatings,
  Reference,
  ElementValidationResult,
  ValidationError,
  ValidationWarning,
  FeedbackContext,
  UserFeedback
} from '../types/elements/index.js';
import { ElementType } from '../portfolio/types.js';
import { v4 as uuidv4 } from 'uuid';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';

/**
 * Normalizes version strings to full semver format (X.Y.Z)
 * This helps maintain consistency while accepting flexible input formats
 * 
 * @param version - The version string to normalize
 * @returns Normalized version string in X.Y.Z format with leading zeros removed
 * 
 * @example
 * normalizeVersion("1")        // "1.0.0"
 * normalizeVersion("1.2")      // "1.2.0"
 * normalizeVersion("1.2.3")    // "1.2.3"
 * normalizeVersion("1.0-beta") // "1.0.0-beta"
 * normalizeVersion("01.02.03") // "1.2.3" (strips leading zeros)
 */
export function normalizeVersion(version: string): string {
  // Extract base version and any prerelease/build metadata
  const match = version.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].+)?$/);
  
  if (!match) {
    // Return as-is if not a valid version format
    return version;
  }
  
  const [, major, minor = '0', patch = '0', suffix = ''] = match;
  
  // Strip leading zeros but preserve "0" as valid
  const normalizedMajor = parseInt(major, 10).toString();
  const normalizedMinor = parseInt(minor, 10).toString();
  const normalizedPatch = parseInt(patch, 10).toString();
  
  return `${normalizedMajor}.${normalizedMinor}.${normalizedPatch}${suffix}`;
}

export abstract class BaseElement implements IElement {
  // Identity
  public id: string;
  public type: ElementType;
  public version: string;
  
  // Metadata
  public metadata: IElementMetadata;
  
  // Features
  public references?: Reference[];
  public extensions?: Record<string, any>;
  public ratings?: ElementRatings;
  
  // Internal state
  protected _status: ElementStatus = ElementStatus.INACTIVE;
  protected _isDirty: boolean = false;
  
  // Constants
  private readonly MAX_FEEDBACK_HISTORY = 100;
  
  constructor(type: ElementType, metadata: Partial<IElementMetadata> = {}) {
    this.type = type;
    this.id = metadata.name ? this.generateId(metadata.name) : uuidv4();
    this.version = metadata.version || '1.0.0';
    
    // Initialize metadata with defaults
    // FIX #1124: Build metadata object with known fields first
    const baseMetadata: any = {
      name: metadata.name || 'Unnamed Element',
      description: metadata.description || '',
      author: metadata.author,
      version: this.version,
      created: metadata.created || new Date().toISOString(),
      modified: metadata.modified || new Date().toISOString(),
      tags: metadata.tags || [],
      dependencies: metadata.dependencies || [],
      custom: metadata.custom || {}
    };

    // Selectively preserve additional string array fields like triggers
    // This avoids spreading non-serializable objects that break YAML serialization
    if ('triggers' in metadata && Array.isArray((metadata as any).triggers)) {
      baseMetadata.triggers = (metadata as any).triggers;
    }

    this.metadata = baseMetadata;
    
    // Initialize optional features
    this.references = [];
    this.extensions = {};
    this.ratings = {
      aiRating: 0,
      userRating: undefined,
      ratingCount: 0,
      lastEvaluated: new Date(),
      confidence: 0,
      trend: 'stable',
      feedbackHistory: []
    };
  }
  
  /**
   * Generate a unique ID for the element based on its name and type.
   * Format: type_name-slug_timestamp
   */
  protected generateId(name: string): string {
    const typeSlug = this.type.toLowerCase();
    const nameSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-)|(-$)/g, '');
    const timestamp = Date.now();
    
    return `${typeSlug}_${nameSlug}_${timestamp}`;
  }
  
  /**
   * Core validation that all elements share.
   * Subclasses should override and call super.validate() first.
   */
  public validate(): ElementValidationResult {
    // Log security-relevant validation event
    SecurityMonitor.logSecurityEvent({
      type: 'YAML_PARSE_SUCCESS',
      severity: 'LOW',
      source: 'BaseElement.validate',
      details: `Element validation performed for ${this.type}:${this.id}`,
      additionalData: { elementType: this.type, elementId: this.id }
    });
    
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const suggestions: string[] = [];
    
    // Validate required fields
    if (!this.id) {
      errors.push({ field: 'id', message: 'Element ID is required' });
    }
    
    if (!this.metadata.name || this.metadata.name.trim() === '') {
      errors.push({ field: 'metadata.name', message: 'Element name is required' });
    }
    
    if (!this.metadata.description || this.metadata.description.trim() === '') {
      warnings.push({ 
        field: 'metadata.description', 
        message: 'Element description is recommended',
        severity: 'medium'
      });
    }
    
    // Validate version format - more flexible to support LLM-generated content
    // FIX for Issue #935: Allow flexible version formats like "1.0", "1.1", "2.0.0"
    // Previously: Strict semver regex requiring X.Y.Z format caused skills activation failures
    // Now: Accept common version patterns that LLMs and humans naturally use
    // Note: Leading zeros are allowed (e.g., "01.02.03") but will be normalized to "1.2.3"
    // Security: No injection risk as version is just metadata, not executed
    const flexibleVersionRegex = /^\d+(\.\d+)?(\.\d+)?(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
    if (!flexibleVersionRegex.test(this.version)) {
      errors.push({ 
        field: 'version', 
        message: 'Version must start with numbers in format: MAJOR[.MINOR][.PATCH][-PRERELEASE][+BUILD]. Valid examples: "1", "1.0", "1.0.0", "2.1", "1.0.0-beta", "1.0.0-alpha.1", "1.0.0+build123". The major version is required, minor and patch are optional. Note: Leading zeros (e.g., "01.02") are accepted but will be normalized to "1.2".',
        code: 'INVALID_VERSION_FORMAT'
      });
    }
    
    // Validate references
    if (this.references) {
      this.references.forEach((ref, index) => {
        if (!ref.uri || ref.uri.trim() === '') {
          errors.push({ 
            field: `references[${index}].uri`, 
            message: 'Reference URI is required' 
          });
        }
        if (!ref.title || ref.title.trim() === '') {
          warnings.push({ 
            field: `references[${index}].title`, 
            message: 'Reference title is recommended',
            severity: 'low'
          });
        }
      });
    }
    
    // Validate ratings if present
    if (this.ratings) {
      if (this.ratings.aiRating < 0 || this.ratings.aiRating > 5) {
        errors.push({ 
          field: 'ratings.aiRating', 
          message: 'AI rating must be between 0 and 5' 
        });
      }
      if (this.ratings.userRating !== undefined && 
          (this.ratings.userRating < 0 || this.ratings.userRating > 5)) {
        errors.push({ 
          field: 'ratings.userRating', 
          message: 'User rating must be between 0 and 5' 
        });
      }
    }
    
    // Add suggestions
    if (!this.metadata.tags || this.metadata.tags.length === 0) {
      suggestions.push('Consider adding tags to improve discoverability');
    }
    
    if (!this.metadata.author) {
      suggestions.push('Consider adding author information');
    }
    
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined
    };
  }
  
  /**
   * Serialize to JSON format for internal use and testing.
   * Maintains backward compatibility with existing tests.
   */
  public serializeToJSON(): string {
    const data = {
      id: this.id,
      type: this.type,
      version: this.version,
      metadata: this.metadata,
      references: this.references,
      extensions: this.extensions,
      ratings: this.ratings
    };
    
    return JSON.stringify(data, null, 2);
  }

  /**
   * Default serialization to markdown with YAML frontmatter.
   * Uses js-yaml for secure YAML generation to prevent injection attacks.
   * FIX: Changed from JSON to proper markdown format for GitHub portfolio storage.
   * This ensures elements are readable on GitHub and compatible with collection workflow.
   */
  public serialize(): string {
    // Build YAML frontmatter starting with all metadata fields
    // This ensures subclasses can add their own fields
    const frontmatter: Record<string, any> = {
      ...this.metadata,  // Include all metadata fields
      type: this.type,
      version: this.version
    };
    
    // Note: metadata already includes name, description, author, created, modified
    // and any additional fields added by subclasses
    if (this.references && this.references.length > 0) {
      frontmatter.references = this.references.map(ref => ({
        type: ref.type,
        uri: ref.uri,
        title: ref.title
      }));
    }
    if (this.ratings && this.ratings.aiRating > 0) {
      frontmatter.ratings = {
        aiRating: this.ratings.aiRating,
        userRating: this.ratings.userRating,
        ratingCount: this.ratings.ratingCount
      };
    }
    
    // Remove undefined/null values
    const cleanFrontmatter = Object.fromEntries(
      Object.entries(frontmatter).filter(([_, value]) => value !== undefined && value !== null)
    );
    
    // Use js-yaml for secure YAML generation
    // This prevents YAML injection attacks and handles special characters properly
    let yamlFrontmatter: string;
    try {
      yamlFrontmatter = yaml.dump(cleanFrontmatter, {
        noRefs: true,          // Don't use YAML references
        sortKeys: false,       // Keep our order
        lineWidth: -1,         // Don't wrap lines
        quotingType: '"',      // Use double quotes when needed
        forceQuotes: false,    // Only quote when necessary
        skipInvalid: false     // Don't skip invalid values
      });
    } catch (error) {
      // If YAML generation fails, log and throw a more informative error
      logger.error('Failed to generate YAML frontmatter', { error, frontmatter: cleanFrontmatter });
      throw new Error(`Failed to serialize element metadata to YAML: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Validate the generated YAML can be parsed back using SecureYamlParser
    // HIGH SEVERITY FIX: Use SecureYamlParser instead of yaml.load to prevent code execution
    try {
      SecureYamlParser.parse(yamlFrontmatter, {
        maxYamlSize: 64 * 1024, // 64KB limit for frontmatter
        validateContent: true
      });
    } catch (error) {
      logger.error('Generated invalid YAML', { error, yaml: yamlFrontmatter });
      throw new Error(`Generated YAML is invalid: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Get content - subclasses should override this to provide actual content
    const content = this.getContent ? this.getContent() : `# ${this.metadata.name}\n\n${this.metadata.description || ''}`;
    
    // Trim the YAML to remove trailing newline that yaml.dump adds
    return `---\n${yamlFrontmatter.trim()}\n---\n\n${content}`;
  }
  
  /**
   * Get element content for serialization.
   * Subclasses should override this to provide their specific content.
   */
  protected getContent?(): string;
  
  /**
   * Default deserialization from JSON.
   * Subclasses can override for custom formats.
   */
  public deserialize(data: string): void {
    try {
      // Normalize Unicode input before parsing
      const validationResult = UnicodeValidator.normalize(data);
      const parsed = JSON.parse(validationResult.normalizedContent);
      
      // Validate required fields
      if (!parsed.id || !parsed.type || !parsed.metadata) {
        throw new Error('Invalid element data: missing required fields');
      }
      
      // Update properties
      this.id = parsed.id;
      this.type = parsed.type;
      this.version = parsed.version || '1.0.0';
      this.metadata = parsed.metadata;
      this.references = parsed.references || [];
      this.extensions = parsed.extensions || {};
      this.ratings = parsed.ratings;
      
      this._isDirty = false;
    } catch (error) {
      // Enhanced error context preservation
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      
      logger.error('Failed to deserialize element', { 
        error: errorMessage,
        stack: errorStack,
        dataPreview: data.substring(0, 200), // First 200 chars for context
        elementType: this.type
      });
      
      // Create new error with original as cause
      const deserializeError = new Error(`BaseElement deserialization failed: ${errorMessage}`);
      if (error instanceof Error) {
        deserializeError.cause = error;
      }
      throw deserializeError;
    }
  }
  
  /**
   * Process user feedback and update ratings.
   */
  public receiveFeedback(feedback: string, context?: FeedbackContext): void {
    // Normalize Unicode input to prevent security issues
    const validationResult = UnicodeValidator.normalize(feedback);
    const normalizedFeedback = validationResult.normalizedContent;
    
    // Log security event for feedback processing
    SecurityMonitor.logSecurityEvent({
      type: 'CONTENT_INJECTION_ATTEMPT',
      severity: 'LOW',
      source: 'BaseElement.receiveFeedback',
      details: `Feedback processed for element ${this.type}:${this.id}`,
      additionalData: { 
        elementType: this.type, 
        elementId: this.id,
        feedbackLength: feedback.length,
        hasUnicodeIssues: !validationResult.isValid
      }
    });
    
    if (!this.ratings) {
      this.ratings = {
        aiRating: 0,
        userRating: undefined,
        ratingCount: 0,
        lastEvaluated: new Date(),
        confidence: 0,
        trend: 'stable',
        feedbackHistory: []
      };
    }
    
    // Create feedback entry with normalized content
    const userFeedback: UserFeedback = {
      timestamp: new Date(),
      feedback: normalizedFeedback,
      sentiment: this.analyzeSentiment(normalizedFeedback),
      inferredRating: this.inferRating(normalizedFeedback),
      context,
      elementVersion: this.version
    };
    
    // Add to history with bounds checking
    if (!this.ratings.feedbackHistory) {
      this.ratings.feedbackHistory = [];
    }
    this.ratings.feedbackHistory.push(userFeedback);
    
    // Prevent unbounded growth
    if (this.ratings.feedbackHistory.length > this.MAX_FEEDBACK_HISTORY) {
      this.ratings.feedbackHistory = this.ratings.feedbackHistory.slice(-this.MAX_FEEDBACK_HISTORY);
      logger.debug(`Feedback history trimmed to ${this.MAX_FEEDBACK_HISTORY} entries for element ${this.id}`);
    }
    
    // Update user rating if we inferred one
    if (userFeedback.inferredRating !== undefined) {
      this.updateUserRating(userFeedback.inferredRating);
    }
    
    this._isDirty = true;
  }
  
  /**
   * Simple sentiment analysis.
   * Subclasses can override for more sophisticated analysis.
   */
  protected analyzeSentiment(feedback: string): 'positive' | 'negative' | 'neutral' {
    const lower = feedback.toLowerCase();
    
    const positiveWords = ['excellent', 'great', 'good', 'helpful', 'useful', 'perfect', 'amazing', 'love'];
    const negativeWords = ['bad', 'poor', 'terrible', 'useless', 'broken', 'hate', 'awful', 'disappointing'];
    
    const positiveCount = positiveWords.filter(word => lower.includes(word)).length;
    const negativeCount = negativeWords.filter(word => lower.includes(word)).length;
    
    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }
  
  /**
   * Simple rating inference from feedback.
   * Subclasses can override for more sophisticated inference.
   */
  protected inferRating(feedback: string): number | undefined {
    const sentiment = this.analyzeSentiment(feedback);
    const lower = feedback.toLowerCase();
    
    // Look for explicit ratings
    const ratingMatch = lower.match(/(\d+)\s*(stars?|\/5|out of 5)/);
    if (ratingMatch) {
      const rating = parseInt(ratingMatch[1]);
      if (rating >= 1 && rating <= 5) return rating;
    }
    
    // Infer from sentiment
    if (sentiment === 'positive') {
      if (lower.includes('perfect') || lower.includes('excellent')) return 5;
      if (lower.includes('great') || lower.includes('very good')) return 4;
      return 4;
    } else if (sentiment === 'negative') {
      if (lower.includes('terrible') || lower.includes('awful')) return 1;
      if (lower.includes('poor') || lower.includes('bad')) return 2;
      return 2;
    }
    
    return 3; // Neutral
  }
  
  /**
   * Update user rating with a new value.
   */
  protected updateUserRating(newRating: number): void {
    if (!this.ratings) return;
    
    if (this.ratings.userRating === undefined) {
      this.ratings.userRating = newRating;
      this.ratings.ratingCount = 1;
    } else {
      // Calculate running average
      const totalRating = this.ratings.userRating * this.ratings.ratingCount + newRating;
      this.ratings.ratingCount++;
      this.ratings.userRating = totalRating / this.ratings.ratingCount;
    }
    
    // Update delta and trend
    this.ratings.ratingDelta = this.ratings.userRating - this.ratings.aiRating;
    
    // Simple trend calculation based on recent feedback
    const recentFeedback = this.ratings.feedbackHistory?.slice(-5) || [];
    const recentSentiments = recentFeedback.map(f => f.sentiment);
    const positiveCount = recentSentiments.filter(s => s === 'positive').length;
    const negativeCount = recentSentiments.filter(s => s === 'negative').length;
    
    if (positiveCount > negativeCount + 1) {
      this.ratings.trend = 'improving';
    } else if (negativeCount > positiveCount + 1) {
      this.ratings.trend = 'declining';
    } else {
      this.ratings.trend = 'stable';
    }
  }
  
  /**
   * Get current element status.
   */
  public getStatus(): ElementStatus {
    return this._status;
  }
  
  /**
   * Default lifecycle methods - subclasses should override as needed.
   */
  public async beforeActivate(): Promise<void> {
    logger.debug(`Preparing to activate ${this.type} element: ${this.metadata.name}`);
    this._status = ElementStatus.ACTIVATING;
  }
  
  public async activate(): Promise<void> {
    logger.info(`Activating ${this.type} element: ${this.metadata.name}`);
    this._status = ElementStatus.ACTIVE;
  }
  
  public async afterActivate(): Promise<void> {
    logger.debug(`Completed activation of ${this.type} element: ${this.metadata.name}`);
  }
  
  public async deactivate(): Promise<void> {
    logger.info(`Deactivating ${this.type} element: ${this.metadata.name}`);
    this._status = ElementStatus.DEACTIVATING;
    // Subclasses should implement cleanup logic
    this._status = ElementStatus.INACTIVE;
  }
  
  /**
   * Mark element as modified.
   */
  protected markDirty(): void {
    this._isDirty = true;
    this.metadata.modified = new Date().toISOString();
  }
  
  /**
   * Check if element has unsaved changes.
   */
  public isDirty(): boolean {
    return this._isDirty;
  }
  
  /**
   * Mark element as saved.
   */
  public markClean(): void {
    this._isDirty = false;
  }
}