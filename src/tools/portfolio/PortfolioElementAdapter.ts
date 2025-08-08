/**
 * Adapter to convert simple portfolio elements to full IElement interface
 * This resolves type safety issues without complex type casting
 */

import { 
  IElement, 
  IElementMetadata, 
  ElementValidationResult, 
  ElementStatus,
  ValidationError,
  ValidationWarning
} from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { PortfolioElement } from './submitToPortfolioTool.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';

/**
 * Adapter class that wraps a simple PortfolioElement and implements IElement
 * This allows us to pass portfolio elements to methods expecting IElement
 * without complex type casting
 */
export class PortfolioElementAdapter implements IElement {
  public readonly id: string;
  public readonly type: ElementType;
  public readonly version: string;
  public readonly metadata: IElementMetadata;
  private readonly portfolioElement: PortfolioElement;

  constructor(element: PortfolioElement) {
    // SECURITY: Normalize and validate all user input (DMCP-SEC-004)
    const normalizedName = UnicodeValidator.normalize(element.metadata.name);
    if (!normalizedName.isValid) {
      // Log security event for invalid Unicode
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'PortfolioElementAdapter.constructor',
        details: `Invalid Unicode in element name: ${normalizedName.detectedIssues?.[0] || 'unknown'}`
      });
      logger.warn('Invalid Unicode detected in element name', {
        issues: normalizedName.detectedIssues
      });
    }
    
    this.portfolioElement = element;
    this.type = element.type;
    this.version = element.metadata.version || '1.0.0';
    
    // Generate ID from type and normalized name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = normalizedName.normalizedContent || element.metadata.name;
    const nameSlug = safeName.toLowerCase().replace(/\s+/g, '-');
    this.id = `${element.type}_${nameSlug}_${timestamp}`;
    
    // Convert metadata to IElementMetadata format with normalized values
    this.metadata = {
      name: safeName,
      description: this.normalizeString(element.metadata.description || ''),
      author: this.normalizeString(element.metadata.author || ''),
      version: element.metadata.version,
      created: element.metadata.created,
      modified: element.metadata.updated,
      tags: []
    };
    
    // SECURITY: Log element creation for audit trail (DMCP-SEC-006)
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'PortfolioElementAdapter.constructor',
      details: `Created portfolio element adapter: ${this.id}`,
      metadata: {
        elementType: this.type,
        elementId: this.id
      }
    });
  }
  
  /**
   * Helper to normalize string values safely
   */
  private normalizeString(value: string): string {
    if (!value) return value;
    const normalized = UnicodeValidator.normalize(value);
    return normalized.normalizedContent || value;
  }

  /**
   * Validate the element
   */
  validate(): ElementValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!this.metadata.name) {
      errors.push({
        field: 'name',
        message: 'Element name is required'
      });
    }
    
    if (!this.portfolioElement.content) {
      errors.push({
        field: 'content',
        message: 'Element content is required'
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Serialize the element to string
   */
  serialize(): string {
    return JSON.stringify({
      id: this.id,
      type: this.type,
      version: this.version,
      metadata: this.metadata,
      content: this.portfolioElement.content
    }, null, 2);
  }

  /**
   * Deserialize from string (not implemented for adapter)
   */
  deserialize(data: string): void {
    throw new Error('Deserialization not supported for PortfolioElementAdapter');
  }

  /**
   * Get element status
   */
  getStatus(): ElementStatus {
    return ElementStatus.INACTIVE;
  }

  /**
   * Get the original portfolio element content
   */
  getContent(): string {
    return this.portfolioElement.content;
  }
}