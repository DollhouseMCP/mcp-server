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
  ValidationResult,
  ValidationError,
  ValidationWarning,
  FeedbackContext,
  UserFeedback
} from '../types/elements/index.js';
import { ElementType } from '../portfolio/types.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';

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
  
  constructor(type: ElementType, metadata: Partial<IElementMetadata> = {}) {
    this.type = type;
    this.id = metadata.name ? this.generateId(metadata.name) : uuidv4();
    this.version = metadata.version || '1.0.0';
    
    // Initialize metadata with defaults
    this.metadata = {
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
      .replace(/^-|-$/g, '');
    const timestamp = Date.now();
    
    return `${typeSlug}_${nameSlug}_${timestamp}`;
  }
  
  /**
   * Core validation that all elements share.
   * Subclasses should override and call super.validate() first.
   */
  public validate(): ValidationResult {
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
    
    // Validate version format (semver)
    const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
    if (!semverRegex.test(this.version)) {
      errors.push({ 
        field: 'version', 
        message: 'Version must follow semantic versioning (e.g., 1.0.0)',
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
   * Default serialization to JSON.
   * Subclasses can override for custom formats.
   */
  public serialize(): string {
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
   * Default deserialization from JSON.
   * Subclasses can override for custom formats.
   */
  public deserialize(data: string): void {
    try {
      const parsed = JSON.parse(data);
      
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
      logger.error('Failed to deserialize element', { error, data });
      throw new Error(`Failed to deserialize element: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  /**
   * Process user feedback and update ratings.
   */
  public receiveFeedback(feedback: string, context?: FeedbackContext): void {
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
    
    // Create feedback entry
    const userFeedback: UserFeedback = {
      timestamp: new Date(),
      feedback,
      sentiment: this.analyzeSentiment(feedback),
      inferredRating: this.inferRating(feedback),
      context,
      elementVersion: this.version
    };
    
    // Add to history
    if (!this.ratings.feedbackHistory) {
      this.ratings.feedbackHistory = [];
    }
    this.ratings.feedbackHistory.push(userFeedback);
    
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