import yaml from 'js-yaml';
import { z } from 'zod';
import { logger } from '../utils/logger.js';

const PersonaMetadataSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  unique_id: z.string().optional(),
  author: z.string().max(50).optional(),
  triggers: z.array(z.string().max(50)).max(20).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  category: z.enum(['creative', 'professional', 'educational', 'gaming', 'personal']).optional(),
  age_rating: z.enum(['all', '13+', '18+']).optional(),
  content_flags: z.array(z.string()).optional(),
  ai_generated: z.boolean().optional(),
  generation_method: z.string().max(50).optional(),
  price: z.string().max(20).optional(),
  license: z.string().max(100).optional(),
  created_date: z.string().optional()
});

export class YamlValidator {
  static parsePersonaMetadataSafely(yamlContent: string): any {
    if (!yamlContent || typeof yamlContent !== 'string') {
      throw new Error('YAML content must be a non-empty string');
    }
    
    // Size check
    if (yamlContent.length > 50000) { // 50KB
      throw new Error('YAML content too large');
    }
    
    // Check for dangerous tags
    if (yamlContent.includes('!!js/') || yamlContent.includes('!!python/')) {
      throw new Error('Dangerous YAML tags detected');
    }
    
    // Check for excessive anchors/aliases (YAML bomb protection)
    const anchorCount = (yamlContent.match(/&\w+/g) || []).length;
    const aliasCount = (yamlContent.match(/\*\w+/g) || []).length;
    
    if (anchorCount > 10 || aliasCount > 20) {
      throw new Error('Potential YAML bomb detected');
    }
    
    try {
      // Use safe load with restricted schema
      const rawData = yaml.load(yamlContent, {
        schema: yaml.CORE_SCHEMA, // No functions, only basic types
        onWarning: (warning) => {
          logger.warn('YAML parsing warning:', warning);
        }
      });
      
      // Validate against schema
      const validatedData = PersonaMetadataSchema.parse(rawData);
      
      // Additional sanitization
      return this.sanitizeMetadata(validatedData);
    } catch (error) {
      if (error instanceof Error && error.name === 'YAMLException') {
        throw new Error(`Invalid YAML syntax: ${error.message}`);
      }
      throw new Error(`Invalid persona metadata: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private static sanitizeMetadata(data: any): any {
    const sanitized = { ...data };
    
    // Sanitize string fields
    const stringFields = ['name', 'description', 'author', 'unique_id'];
    for (const field of stringFields) {
      if (sanitized[field]) {
        sanitized[field] = this.sanitizeString(sanitized[field]);
      }
    }
    
    // Sanitize array fields
    if (sanitized.triggers) {
      sanitized.triggers = sanitized.triggers.map((t: string) => this.sanitizeString(t));
    }
    
    return sanitized;
  }

  private static sanitizeString(input: string): string {
    // Comprehensive XSS protection
    return input
      // Remove HTML tags and potential XSS vectors
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove script tags
      .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '') // Remove iframe tags
      .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '') // Remove object tags
      .replace(/<embed[^>]*>/gi, '') // Remove embed tags
      .replace(/<[^>]+>/g, '') // Remove all remaining HTML tags
      // Remove dangerous attributes
      .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '') // Remove event handlers
      .replace(/javascript\s*:/gi, '') // Remove javascript: protocol
      .replace(/vbscript\s*:/gi, '') // Remove vbscript: protocol
      // Remove other dangerous characters
      .replace(/\x00/g, '') // Remove null bytes
      .replace(/[\r\n]/g, ' ') // Replace newlines with spaces
      .trim();
  }
}