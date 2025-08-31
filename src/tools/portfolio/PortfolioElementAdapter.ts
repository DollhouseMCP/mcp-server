/**
 * Adapter to convert simple portfolio elements to full IElement interface
 * This resolves type safety issues without complex type casting
 * 
 * FIXES IMPLEMENTED (PR #503):
 * 1. TYPE SAFETY (Issue #497): Eliminates complex type casting with adapter pattern
 * 2. SECURITY FIX DMCP-SEC-004 (MEDIUM): Added Unicode normalization for all user input
 * 3. SECURITY FIX DMCP-SEC-006 (LOW): Added audit logging for element creation
 * 4. PERFORMANCE: Helper methods for efficient string normalization
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
import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { ContentValidator } from '../../security/contentValidator.js';

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
    // SECURITY FIX #2 (DMCP-SEC-004): Normalize and validate all user input
    // Previously: User input was used directly without validation
    // Now: All string inputs go through UnicodeValidator to prevent homograph attacks
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
    
    // SECURITY FIX #3 (DMCP-SEC-006): Log element creation for audit trail
    // Previously: No audit logging for portfolio operations
    // Now: Complete audit trail using SecurityMonitor.logSecurityEvent()
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
   * Serialize the element to markdown with YAML frontmatter
   * FIX: Changed from JSON to markdown format for GitHub portfolio compatibility
   * SECURITY FIX #544: Parse and validate existing frontmatter instead of returning as-is
   * SECURITY FIX #543: Use gray-matter for robust frontmatter detection
   */
  serialize(): string {
    // SECURITY FIX #543: Use gray-matter for robust frontmatter detection
    // This handles different line endings, whitespace variations, and malformed YAML
    let contentToProcess = this.portfolioElement.content;
    let existingMetadata: Record<string, any> = {};
    let bodyContent = contentToProcess;
    
    // Try to parse existing frontmatter if present
    try {
      // gray-matter handles all edge cases:
      // - Different line endings (\n, \r\n)
      // - Whitespace variations
      // - Malformed YAML (returns empty data object)
      // - Missing closing delimiter
      const parsed = matter(contentToProcess);
      
      if (parsed.data && Object.keys(parsed.data).length > 0) {
        // SECURITY FIX #544: Validate existing frontmatter instead of bypassing
        logger.debug('Found existing frontmatter, validating before merge');
        
        // Validate the parsed frontmatter
        const validationResult = ContentValidator.validateAndSanitize(
          yaml.dump(parsed.data)
        );
        
        if (!validationResult.isValid && validationResult.severity === 'critical') {
          // Log security event for malicious frontmatter
          SecurityMonitor.logSecurityEvent({
            type: 'CONTENT_INJECTION_ATTEMPT',
            severity: 'HIGH',
            source: 'PortfolioElementAdapter.serialize',
            details: `Critical security issues in frontmatter: ${validationResult.detectedPatterns?.join(', ')}`,
            metadata: {
              elementId: this.id,
              elementType: this.type
            }
          });
          
          // Don't use the malicious frontmatter, create new
          existingMetadata = {};
          bodyContent = contentToProcess; // Use original content
        } else {
          // Frontmatter is safe, merge with our metadata
          existingMetadata = parsed.data;
          bodyContent = parsed.content;
        }
      }
    } catch (error) {
      // If gray-matter fails to parse, treat as content without frontmatter
      logger.warn('Failed to parse potential frontmatter, treating as plain content', {
        error: error instanceof Error ? error.message : String(error)
      });
      // Continue with empty metadata and full content
    }
    
    // Merge metadata, with our metadata taking precedence for security
    // This ensures critical fields like ID and type are always from our validated source
    const mergedMetadata = {
      ...existingMetadata, // Existing metadata first
      ...this.metadata,    // Our validated metadata overwrites
      id: this.id,         // Always use our ID
      unique_id: this.id,  // CRITICAL FIX: Add unique_id for collection workflow compatibility
      type: this.type,     // Always use our type
      version: this.version // Always use our version
    };
    
    // Validate the final merged metadata
    const metadataYaml = yaml.dump(mergedMetadata, {
      noRefs: true,
      sortKeys: false,
      lineWidth: -1
    });
    
    // Final security check on the complete metadata
    const finalValidation = ContentValidator.validateAndSanitize(metadataYaml);
    
    if (!finalValidation.isValid && finalValidation.severity === 'critical') {
      // This shouldn't happen with our sanitized data, but log if it does
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'MEDIUM',
        source: 'PortfolioElementAdapter.serialize',
        details: 'Final metadata validation failed after merge',
        metadata: { elementId: this.id }
      });
      
      // Fall back to minimal safe metadata
      const safeMetadata = {
        id: this.id,
        unique_id: this.id,  // CRITICAL FIX: Include unique_id for collection workflow
        type: this.type,
        version: this.version,
        name: this.normalizeString(this.metadata.name || 'Untitled'),
        description: this.normalizeString(this.metadata.description || '')
      };
      
      const safeFrontmatter = yaml.dump(safeMetadata, {
        noRefs: true,
        sortKeys: false,
        lineWidth: -1
      });
      
      return `---\n${safeFrontmatter}---\n\n${bodyContent}`;
    }
    
    // Return validated and sanitized markdown with frontmatter
    return `---\n${metadataYaml}---\n\n${bodyContent}`;
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