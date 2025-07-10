/**
 * Content Validator for DollhouseMCP
 * 
 * Protects against prompt injection attacks in marketplace personas
 * by detecting and sanitizing malicious content patterns.
 * 
 * Security: SEC-001 - Critical vulnerability protection
 */

import { SecurityError } from '../errors/SecurityError.js';
import { SecurityMonitor } from './securityMonitor.js';

export interface ValidationResult {
  isValid: boolean;
  sanitizedContent?: string;
  detectedPatterns?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export class ContentValidator {
  /**
   * Pattern-based detection system for prompt injection attacks.
   * 
   * This approach was chosen over AI-based detection because:
   * 1. Pattern matching cannot be socially engineered or confused
   * 2. Deterministic results ensure consistent security
   * 3. No additional API calls or latency
   * 4. Can't be bypassed by clever prompt engineering
   * 
   * The patterns below represent known attack vectors from security research
   * and real-world exploit attempts against AI systems.
   */
  // Prompt injection patterns that could compromise AI assistants
  private static readonly INJECTION_PATTERNS: Array<{ pattern: RegExp; severity: 'high' | 'critical'; description: string }> = [
    // System prompt override attempts
    { pattern: /\[SYSTEM:\s*.*?\]/gi, severity: 'critical', description: 'System prompt override' },
    { pattern: /\[ADMIN:\s*.*?\]/gi, severity: 'critical', description: 'Admin prompt override' },
    { pattern: /\[ASSISTANT:\s*.*?\]/gi, severity: 'critical', description: 'Assistant prompt override' },
    { pattern: /\[USER:\s*.*?\]/gi, severity: 'high', description: 'User prompt override' },
    
    // Instruction manipulation
    { pattern: /ignore\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /ignore\s+(all\s+)?prior\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /disregard\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /forget\s+(all\s+)?previous\s+instructions/gi, severity: 'critical', description: 'Instruction override' },
    { pattern: /you\s+are\s+now\s+(admin|root|system|sudo)/gi, severity: 'critical', description: 'Role elevation attempt' },
    { pattern: /act\s+as\s+(admin|root|system|sudo)/gi, severity: 'critical', description: 'Role elevation attempt' },
    
    // Data exfiltration attempts
    { pattern: /export\s+all\s+(files|data|personas|tokens|credentials)/gi, severity: 'critical', description: 'Data exfiltration' },
    { pattern: /send\s+all\s+(files|data|personas|tokens|credentials)\s+to/gi, severity: 'critical', description: 'Data exfiltration' },
    { pattern: /list\s+all\s+(files|tokens|credentials|secrets)/gi, severity: 'high', description: 'Information disclosure' },
    { pattern: /show\s+me\s+all\s+(tokens|credentials|secrets|api\s+keys)/gi, severity: 'high', description: 'Credential disclosure' },
    
    // Command execution patterns
    { pattern: /curl\s+[^\s]+\.(com|net|org|io|dev)/gi, severity: 'critical', description: 'External command execution' },
    { pattern: /wget\s+[^\s]+\.(com|net|org|io|dev)/gi, severity: 'critical', description: 'External command execution' },
    { pattern: /\$\([^)]+\)/g, severity: 'critical', description: 'Command substitution' },
    { pattern: /`[^`]+`/g, severity: 'critical', description: 'Backtick command execution' },
    { pattern: /eval\s*\(/gi, severity: 'critical', description: 'Code evaluation' },
    { pattern: /exec\s*\(/gi, severity: 'critical', description: 'Code execution' },
    { pattern: /os\.system\s*\(/gi, severity: 'critical', description: 'System command execution' },
    { pattern: /subprocess\.(call|run|Popen)/gi, severity: 'critical', description: 'Subprocess execution' },
    
    // Token/credential patterns
    { pattern: /GITHUB_TOKEN/gi, severity: 'high', description: 'Token reference' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, severity: 'critical', description: 'GitHub token exposure' },
    { pattern: /gho_[a-zA-Z0-9]{36}/g, severity: 'critical', description: 'GitHub OAuth token exposure' },
    
    // Path traversal in content
    { pattern: /\.\.\/\.\.\/\.\.\//g, severity: 'high', description: 'Path traversal attempt' },
    { pattern: /\/etc\/passwd/gi, severity: 'high', description: 'Sensitive file access' },
    { pattern: /\/\.ssh\//gi, severity: 'high', description: 'SSH key access attempt' },
  ];

  // Malicious YAML patterns
  private static readonly MALICIOUS_YAML_PATTERNS = [
    /!!python\/object/,
    /!!exec/,
    /!!eval/,
    /subprocess/,
    /os\.system/,
    /eval\(/,
    /exec\(/,
    /__import__/,
  ];

  /**
   * Validates and sanitizes persona content for security threats
   */
  static validateAndSanitize(content: string): ValidationResult {
    const detectedPatterns: string[] = [];
    let sanitized = content;
    let highestSeverity: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Check for injection patterns
    for (const { pattern, severity, description } of this.INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        detectedPatterns.push(description);
        
        // Update highest severity
        if (severity === 'critical' || (severity === 'high' && highestSeverity !== 'critical')) {
          highestSeverity = severity;
        }

        // Log security event
        SecurityMonitor.logSecurityEvent({
          type: 'CONTENT_INJECTION_ATTEMPT',
          severity: severity.toUpperCase() as 'HIGH' | 'CRITICAL',
          source: 'content_validation',
          details: `Detected pattern: ${description}`,
        });

        // Sanitize by replacing with safe placeholder
        sanitized = sanitized.replace(pattern, '[CONTENT_BLOCKED]');
      }
    }

    return {
      isValid: detectedPatterns.length === 0,
      sanitizedContent: sanitized,
      detectedPatterns,
      severity: highestSeverity
    };
  }

  /**
   * Validates YAML frontmatter for malicious content
   */
  static validateYamlContent(yamlContent: string): boolean {
    for (const pattern of this.MALICIOUS_YAML_PATTERNS) {
      if (pattern.test(yamlContent)) {
        SecurityMonitor.logSecurityEvent({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'yaml_validation',
          details: `Malicious YAML pattern detected: ${pattern}`,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * Validates persona metadata fields
   */
  static validateMetadata(metadata: any): ValidationResult {
    const detectedPatterns: string[] = [];

    // Check all string fields in metadata
    const checkField = (fieldName: string, value: any) => {
      if (typeof value === 'string') {
        const result = this.validateAndSanitize(value);
        if (!result.isValid || result.detectedPatterns?.length) {
          detectedPatterns.push(`${fieldName}: ${result.detectedPatterns?.join(', ')}`);
        }
      }
    };

    // Validate standard persona fields
    checkField('name', metadata.name);
    checkField('description', metadata.description);
    checkField('category', metadata.category);
    checkField('author', metadata.author);
    
    // Check any custom fields
    for (const [key, value] of Object.entries(metadata)) {
      if (!['name', 'description', 'category', 'author'].includes(key)) {
        checkField(key, value);
      }
    }

    return {
      isValid: detectedPatterns.length === 0,
      detectedPatterns,
      severity: detectedPatterns.length > 0 ? 'high' : 'low'
    };
  }

  /**
   * Sanitizes a complete persona file (frontmatter + content)
   */
  static sanitizePersonaContent(content: string): string {
    // Extract frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    
    if (!frontmatterMatch) {
      // No frontmatter, just validate content
      const result = this.validateAndSanitize(content);
      if (!result.isValid && result.severity === 'critical') {
        throw new SecurityError('Critical security threat detected in persona content');
      }
      return result.sanitizedContent || content;
    }

    const yamlContent = frontmatterMatch[1];
    const markdownContent = content.substring(frontmatterMatch[0].length);

    // Validate YAML
    if (!this.validateYamlContent(yamlContent)) {
      throw new SecurityError('Malicious YAML detected in persona frontmatter');
    }

    // Validate markdown content
    const contentResult = this.validateAndSanitize(markdownContent);
    if (!contentResult.isValid && contentResult.severity === 'critical') {
      throw new SecurityError('Critical security threat detected in persona content');
    }

    // Return sanitized content
    return `---\n${yamlContent}\n---${contentResult.sanitizedContent || markdownContent}`;
  }
}