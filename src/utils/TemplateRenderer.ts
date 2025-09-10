/**
 * TemplateRenderer - Utility class for rendering templates with comprehensive validation
 * 
 * IMPROVEMENTS IMPLEMENTED (per Debug Detective recommendations):
 * 1. instanceof Template verification for type safety
 * 2. Performance logging to track render times
 * 3. Validation of render() return value
 * 4. Clear separation of concerns from index.ts
 * 
 * This addresses Issues #913 and #914 from the v1.7.3 hotfix
 */

import { Template } from '../elements/templates/Template.js';
import { TemplateManager } from '../elements/templates/TemplateManager.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface RenderResult {
  success: boolean;
  content?: string;
  error?: string;
  performance?: {
    lookupTime: number;
    renderTime: number;
    totalTime: number;
  };
}

export class TemplateRenderer {
  constructor(private templateManager: TemplateManager) {}

  /**
   * Render a template with comprehensive validation and performance tracking
   * 
   * VALIDATION CHAIN:
   * 1. Unicode normalization of template name
   * 2. Template exists in manager
   * 3. Template is proper Template instance
   * 4. Template has render() method
   * 5. render() returns a string
   * 
   * SECURITY:
   * - Unicode normalization prevents homograph attacks
   * - Variables are normalized by Template.render() internally
   * 
   * PERFORMANCE TRACKING:
   * - Lookup time (finding template)
   * - Render time (actual rendering)
   * - Total time (complete operation)
   */
  async render(name: string, variables: Record<string, any> = {}): Promise<RenderResult> {
    const startTime = performance.now();
    
    try {
      // SECURITY: Normalize template name to prevent Unicode attacks
      const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
      
      // STEP 1: Find template with performance tracking
      const lookupStart = performance.now();
      const template = await this.templateManager.find(t => t.metadata.name === normalizedName);
      const lookupTime = performance.now() - lookupStart;
      
      logger.debug(`Template lookup for '${normalizedName}' completed in ${lookupTime.toFixed(2)}ms`);
      
      // VALIDATION 1: Template exists
      if (!template) {
        const totalTime = performance.now() - startTime;
        logger.warn(`Template '${normalizedName}' not found after ${lookupTime.toFixed(2)}ms lookup`);
        
        return {
          success: false,
          error: `Template '${normalizedName}' not found`,
          performance: { lookupTime, renderTime: 0, totalTime }
        };
      }
      
      // VALIDATION 2: Verify template is proper Template instance with render method
      if (!(template instanceof Template) || typeof template.render !== 'function') {
        const totalTime = performance.now() - startTime;
        const isInstance = template instanceof Template;
        const hasRender = typeof (template as any)?.render === 'function';
        
        logger.error(
          `Template '${normalizedName}' validation failed. ` +
          `Is Template instance: ${isInstance}, Has render method: ${hasRender}`
        );
        
        return {
          success: false,
          error: `Template '${normalizedName}' is not a valid Template instance`,
          performance: { lookupTime, renderTime: 0, totalTime }
        };
      }
      
      // STEP 2: Render template with performance tracking
      // Note: Template.render() internally handles Unicode normalization for variables
      logger.debug(
        `Starting render for template '${normalizedName}': ` +
        `variables=${JSON.stringify(Object.keys(variables))}, template.id=${template.id}`
      );
      
      const renderStart = performance.now();
      const rendered = await template.render(variables);
      const renderTime = performance.now() - renderStart;
      
      // VALIDATION 3: Verify render() returned a string
      if (typeof rendered !== 'string') {
        const totalTime = performance.now() - startTime;
        logger.error(`Template '${normalizedName}' render() returned non-string: ${typeof rendered}`);
        
        return {
          success: false,
          error: `Template render failed: invalid return type (${typeof rendered})`,
          performance: { lookupTime, renderTime, totalTime }
        };
      }
      
      // SUCCESS: Log performance metrics
      const totalTime = performance.now() - startTime;
      logger.info(
        `Template '${normalizedName}' rendered successfully: ` +
        `lookup=${lookupTime.toFixed(2)}ms, ` +
        `render=${renderTime.toFixed(2)}ms, ` +
        `total=${totalTime.toFixed(2)}ms, ` +
        `output_length=${rendered.length}`
      );
      
      return {
        success: true,
        content: rendered,
        performance: { lookupTime, renderTime, totalTime }
      };
      
    } catch (error) {
      const totalTime = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Use original name in error message for clarity
      logger.error(`Failed to render template '${name}' after ${totalTime.toFixed(2)}ms:`, error);
      
      return {
        success: false,
        error: `Failed to render template: ${errorMessage}`,
        performance: { lookupTime: 0, renderTime: 0, totalTime }
      };
    }
  }

  /**
   * Batch render multiple templates (useful for testing)
   * SECURITY: Each template name is normalized individually
   */
  async renderBatch(
    templates: Array<{ name: string; variables: Record<string, any> }>
  ): Promise<Map<string, RenderResult>> {
    const results = new Map<string, RenderResult>();
    
    for (const { name, variables } of templates) {
      // Each render call handles its own Unicode normalization
      results.set(name, await this.render(name, variables));
    }
    
    return results;
  }

  /**
   * Validate that a template can be rendered without actually rendering it
   * SECURITY: Template name is normalized to prevent Unicode attacks
   */
  async validate(name: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      // SECURITY: Normalize template name
      const normalizedName = UnicodeValidator.normalize(name).normalizedContent;
      
      const template = await this.templateManager.find(t => t.metadata.name === normalizedName);
      
      if (!template) {
        return { valid: false, reason: 'Template not found' };
      }
      
      if (!(template instanceof Template)) {
        return { valid: false, reason: 'Not a valid Template instance' };
      }
      
      if (typeof template.render !== 'function') {
        return { valid: false, reason: 'Missing render method' };
      }
      
      return { valid: true };
      
    } catch (error) {
      return { 
        valid: false, 
        reason: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }
}