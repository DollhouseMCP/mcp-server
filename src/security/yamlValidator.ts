import yaml from 'js-yaml';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

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

// Type declarations for better type safety
type DOMPurifyInstance = ReturnType<typeof DOMPurify>;

export class YamlValidator {
  // Static cache for DOMPurify to improve performance
  private static purifyWindow: any = null;
  private static purify: DOMPurifyInstance | null = null;

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

  /**
   * Initialize DOMPurify instance if not already initialized
   */
  private static initializePurify(): void {
    if (!this.purifyWindow || !this.purify) {
      const dom = new JSDOM('');
      this.purifyWindow = dom.window;
      this.purify = DOMPurify(this.purifyWindow);
    }
  }

  /**
   * Sanitize string input using DOMPurify to prevent XSS attacks
   * This replaces the regex-based approach with a more robust solution
   */
  private static sanitizeString(input: string): string {
    // Limit input length to prevent DoS
    if (input.length > 10000) {
      input = input.substring(0, 10000);
    }
    
    // Initialize DOMPurify if needed
    this.initializePurify();
    
    // Use DOMPurify with strict configuration
    // ALLOWED_TAGS: [] strips all HTML tags
    // ALLOWED_ATTR: [] strips all attributes
    // FORBID_TAGS/FORBID_ATTR provide additional protection
    let sanitized = this.purify!.sanitize(input, {
      ALLOWED_TAGS: [],      // Strip all HTML tags
      ALLOWED_ATTR: [],      // Strip all attributes
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'style', 'href', 'src']
    });
    
    // Additional protection against command injection patterns
    // These patterns might not be caught by DOMPurify
    const commandInjectionPatterns = [
      /`[^`]{0,1000}`/g,           // Backtick expressions
      /\$\([^)]{0,1000}\)/g,       // Command substitution
      /\$\{[^}]{0,1000}\}/g,       // Variable expansion
      /\\x[0-9a-fA-F]{2}/g,        // Hex escapes
      /\\u[0-9a-fA-F]{4}/g,        // Unicode escapes
      /\\[0-7]{1,3}/g              // Octal escapes
    ];
    
    for (const pattern of commandInjectionPatterns) {
      sanitized = sanitized.replace(pattern, '');
    }
    
    // Remove null bytes and normalize whitespace
    sanitized = sanitized
      .replace(/\x00/g, '')          // Remove null bytes
      .replace(/[\r\n]+/g, ' ')      // Replace newlines with spaces
      .trim();
    
    return sanitized;
  }
  
  /**
   * Reset static DOMPurify cache (useful for long-running processes)
   */
  public static resetCache(): void {
    this.purifyWindow = null;
    this.purify = null;
  }
}