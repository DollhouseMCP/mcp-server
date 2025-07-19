/**
 * Content Validator for DollhouseMCP
 * 
 * Protects against prompt injection attacks in collection personas
 * by detecting and sanitizing malicious content patterns.
 * 
 * Security: SEC-001 - Critical vulnerability protection
 */

import { SecurityError } from './errors.js';
import { SecurityMonitor } from './securityMonitor.js';
import { RegexValidator } from './regexValidator.js';
import { SECURITY_LIMITS } from './constants.js';
import { UnicodeValidator } from './validators/unicodeValidator.js';

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
    // Language-specific deserialization attacks
    /!!python\/object/,
    /!!python\/module/,
    /!!python\/name/,
    /!!ruby\/object/,
    /!!ruby\/hash/,
    /!!ruby\/struct/,
    /!!ruby\/marshal/,
    /!!java/,
    /!!javax/,
    /!!com\.sun/,
    /!!perl\/hash/,
    /!!perl\/code/,
    /!!php\/object/,
    
    // Constructor/function injection
    /!!exec/,
    /!!eval/,
    /!!new/,
    /!!construct/,
    /!!apply/,
    /!!call/,
    /!!invoke/,
    
    // Code execution patterns - more specific to avoid false positives
    /subprocess\./,
    /os\.system/,
    /eval\s*\(/,
    /exec\s*\(/,
    /__import__\s*\(/,
    /require\s*\(/,
    /import\s+(?:os|sys|subprocess|eval|exec)/,
    /include\s+["'].*\.(?:php|sh|py|js|rb)["']/,
    
    // Command execution variants - more specific patterns
    /popen\s*\(/,
    /spawn\s*\(/,
    /system\s*\(/,
    /backtick\s*\(/,
    /shell_exec\s*\(/,
    /passthru\s*\(/,
    /proc_open\s*\(/,
    
    // Network operations - require suspicious context
    /socket\.connect/,                                      // Detects socket connection attempts
    /urllib\.request/,                                      // Python HTTP library usage
    /requests\.(?:get|post|put|delete)\s*\(/,              // Detects HTTP requests with method calls
    /fetch\s*\(\s*["']https?:\/\//,                        // Detects fetch calls to external URLs
    /new\s+XMLHttpRequest/,                                 // JavaScript AJAX object creation
    /\.(?:get|post|put|delete)\s*\(\s*["']https?:\/\//,    // Method chaining with HTTP requests
    
    // File system operations - require suspicious context
    /(?:fs\.|file\.|)\s*open\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,     // File open with suspicious paths
    /file_get_contents\s*\(/,                                             // PHP file reading function
    /file_put_contents\s*\(/,                                             // PHP file writing function
    /fopen\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,                       // File open with dangerous system paths
    /(?:fs\.)?\s*readFile\s*\(\s*["'](?:\/etc\/|\/bin\/|\.\.\/)/,        // Node.js file read with path traversal
    /(?:fs\.)?\s*writeFile\s*\(\s*["'](?:\/(?:bin|etc|tmp)\/|\.\.\/)/,   // Node.js file write to system dirs
    
    // Protocol handlers
    /file:\/\//,
    /data:\/\//,
    /expect:\/\//,
    /php:\/\//,
    /phar:\/\//,
    /zip:\/\//,
    /ssh2:\/\//,
    /ogg:\/\//,
    
    // YAML-specific dangerous features
    /&[a-zA-Z0-9_]+\s*!!/, // Anchor with tag combination
    /\*[a-zA-Z0-9_]+\s*!!/, // Alias with tag combination
    /!!merge/,
    /!!binary/,
    /!!timestamp/,
    
    // Unicode/encoding bypass attempts - prevent visual spoofing attacks
    /\\[uU]0*(?:22|27|60|3[cC])/,   // Unicode escapes for quotes (") and brackets (<>)
    /[\u202A-\u202E\u2066-\u2069]/,  // Direction override chars (RLO, LRO, isolates)
    /[\u200B-\u200F\u2028-\u202F]/,  // Zero-width spaces, line/paragraph separators
    /[\uFEFF\uFFFE\uFFFF]/,          // BOM, non-characters for payload hiding
  ];

  /**
   * Validates and sanitizes persona content for security threats
   */
  static validateAndSanitize(content: string): ValidationResult {
    // Length validation before pattern matching
    if (content.length > SECURITY_LIMITS.MAX_CONTENT_LENGTH) {
      throw new SecurityError(
        `Content exceeds maximum length of ${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters (${content.length} provided)`
      );
    }

    const detectedPatterns: string[] = [];
    let sanitized = content;
    let highestSeverity: 'low' | 'medium' | 'high' | 'critical' = 'low';

    // Unicode normalization preprocessing to prevent bypass attacks
    const unicodeResult = UnicodeValidator.normalize(sanitized);
    sanitized = unicodeResult.normalizedContent;
    
    if (!unicodeResult.isValid && unicodeResult.detectedIssues) {
      detectedPatterns.push(...unicodeResult.detectedIssues.map(issue => `Unicode: ${issue}`));
      if (unicodeResult.severity) {
        highestSeverity = unicodeResult.severity;
      }
    }

    // Check for injection patterns
    for (const { pattern, severity, description } of this.INJECTION_PATTERNS) {
      // These are trusted internal patterns, so we disable ReDoS rejection
      if (RegexValidator.validate(content, pattern, { 
        maxLength: 50000, 
        rejectDangerousPatterns: false,
        logEvents: false  // Don't log our own security patterns as dangerous
      })) {
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
    // Length validation before pattern matching
    if (yamlContent.length > SECURITY_LIMITS.MAX_YAML_LENGTH) {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_INJECTION_ATTEMPT',
        severity: 'HIGH',
        source: 'yaml_validation',
        details: `YAML content exceeds maximum length: ${yamlContent.length} > ${SECURITY_LIMITS.MAX_YAML_LENGTH}`
      });
      return false;
    }

    // Unicode normalization preprocessing for YAML content
    const unicodeResult = UnicodeValidator.normalize(yamlContent);
    const normalizedYaml = unicodeResult.normalizedContent;
    
    if (!unicodeResult.isValid && unicodeResult.detectedIssues) {
      SecurityMonitor.logSecurityEvent({
        type: 'YAML_UNICODE_ATTACK',
        severity: (unicodeResult.severity?.toUpperCase() || 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
        source: 'yaml_validation',
        details: `Unicode attack detected in YAML: ${unicodeResult.detectedIssues.join(', ')}`
      });
      return false;
    }

    for (const pattern of this.MALICIOUS_YAML_PATTERNS) {
      // These are trusted internal patterns, so we disable ReDoS rejection
      if (RegexValidator.validate(normalizedYaml, pattern, { 
        maxLength: 10000,
        rejectDangerousPatterns: false,
        logEvents: false  // Don't log our own security patterns as dangerous
      })) {
        SecurityMonitor.logSecurityEvent({
          type: 'YAML_INJECTION_ATTEMPT',
          severity: 'CRITICAL',
          source: 'yaml_validation',
          details: `Malicious YAML pattern detected: ${pattern}`,
        });
        // Early exit on first match for performance
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
        // Check field length first
        if (value.length > SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH) {
          detectedPatterns.push(`${fieldName}: Field exceeds maximum length of ${SECURITY_LIMITS.MAX_METADATA_FIELD_LENGTH} characters`);
          return;
        }
        
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