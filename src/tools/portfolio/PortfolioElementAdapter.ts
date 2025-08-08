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
    this.portfolioElement = element;
    this.type = element.type;
    this.version = element.metadata.version || '1.0.0';
    
    // Generate ID from type and name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const nameSlug = element.metadata.name.toLowerCase().replace(/\s+/g, '-');
    this.id = `${element.type}_${nameSlug}_${timestamp}`;
    
    // Convert metadata to IElementMetadata format
    this.metadata = {
      name: element.metadata.name,
      description: element.metadata.description || '',
      author: element.metadata.author,
      version: element.metadata.version,
      created: element.metadata.created,
      modified: element.metadata.updated,
      tags: []
    };
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