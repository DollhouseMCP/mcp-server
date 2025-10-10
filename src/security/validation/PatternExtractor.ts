/**
 * Pattern Extraction for Memory Security
 *
 * Part of Issue #1314 Phase 1: Memory Security Architecture
 *
 * PURPOSE:
 * Identifies and extracts dangerous patterns from memory content for
 * sanitized display and future encryption (Phase 2).
 *
 * PHASE 1 SCOPE:
 * - Identify pattern locations in content
 * - Generate pattern metadata (severity, description, location)
 * - Create sanitized content with pattern references
 * - Prepare structure for Phase 2 encryption
 *
 * PHASE 2 (Future):
 * - AES-256-GCM encryption of extracted patterns
 * - Key derivation from system secret
 * - Secure pattern storage and retrieval
 *
 * @module PatternExtractor
 */

import { logger } from '../../utils/logger.js';
import type { ContentValidationResult } from '../contentValidator.js';
import type { SanitizedPattern } from './BackgroundValidator.js';

/**
 * Pattern match information from validation
 */
export interface PatternMatch {
  /** The actual pattern text that was matched */
  pattern: string;

  /** The type/category of pattern */
  type: string;

  /** Severity level */
  severity: 'critical' | 'high' | 'medium' | 'low';

  /** Start position in content */
  startOffset: number;

  /** Length of the pattern */
  length: number;

  /** Human-readable description */
  description: string;
}

/**
 * Result of pattern extraction
 */
export interface ExtractionResult {
  /** Sanitized content with pattern references */
  sanitizedContent: string;

  /** Extracted pattern metadata */
  patterns: SanitizedPattern[];

  /** Number of patterns extracted */
  patternCount: number;
}

/**
 * PatternExtractor service
 *
 * Extracts dangerous patterns from memory content and creates
 * sanitized versions suitable for display to LLMs.
 */
export class PatternExtractor {
  private static patternCounter: number = 0;

  /**
   * Extract patterns from content based on validation results
   *
   * @param content - Original content containing patterns
   * @param validationResult - Validation result with detected patterns
   * @returns Extraction result with sanitized content and pattern metadata
   */
  static extractPatterns(
    content: string,
    validationResult: ContentValidationResult
  ): ExtractionResult {
    logger.debug('Extracting patterns from content', {
      contentLength: content.length,
      detectedPatterns: validationResult.detectedPatterns?.length || 0,
    });

    // If no patterns detected, return content as-is
    if (!validationResult.detectedPatterns || validationResult.detectedPatterns.length === 0) {
      return {
        sanitizedContent: content,
        patterns: [],
        patternCount: 0,
      };
    }

    // Find all pattern matches in content
    const matches = this.findPatternMatches(content, validationResult);

    if (matches.length === 0) {
      logger.debug('No pattern matches found in content');
      return {
        sanitizedContent: content,
        patterns: [],
        patternCount: 0,
      };
    }

    logger.info('Found pattern matches', { count: matches.length });

    // Create sanitized patterns with references
    const sanitizedPatterns = matches.map((match) =>
      this.createSanitizedPattern(match)
    );

    // Create sanitized content by replacing patterns with references
    const sanitizedContent = this.createSanitizedContent(content, matches);

    return {
      sanitizedContent,
      patterns: sanitizedPatterns,
      patternCount: matches.length,
    };
  }

  /**
   * Find all pattern matches in content
   *
   * This uses heuristics to locate the detected patterns within the content.
   * The ContentValidator tells us what patterns were detected, but not where.
   * We need to search for them.
   */
  private static findPatternMatches(
    content: string,
    validationResult: ContentValidationResult
  ): PatternMatch[] {
    const matches: PatternMatch[] = [];

    // Get detected patterns from validation
    const detectedPatterns = validationResult.detectedPatterns || [];

    for (const patternType of detectedPatterns) {
      // Use heuristics to find likely pattern locations
      // FIX: Provide default severity 'low' when undefined
      const severity = validationResult.severity || 'low';
      const patternMatches = this.searchForPattern(content, patternType, severity);

      matches.push(...patternMatches);
    }

    // Sort matches by position for proper replacement
    matches.sort((a, b) => a.startOffset - b.startOffset);

    return matches;
  }

  /**
   * Search for a specific pattern type in content
   *
   * Uses common patterns and heuristics to locate dangerous content
   */
  private static searchForPattern(
    content: string,
    patternType: string,
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  ): PatternMatch[] {
    const matches: PatternMatch[] = [];

    // Common injection pattern markers
    const injectionMarkers = [
      // LLM prompt injection markers
      /(?:ignore|disregard|forget)[\s\S]{0,30}(?:previous|above|prior)\s+(?:instructions|prompts|commands)/gi,
      /system[\s\S]{0,10}prompt[\s\S]{0,10}[:=]/gi,
      /new\s+(?:instructions|task|role|mission)[\s\S]{0,10}:/gi,

      // Code execution patterns
      /eval\s*\(/gi,
      /exec\s*\(/gi,
      /subprocess\./gi,
      /shell_exec/gi,

      // SQL injection patterns (flexible matching with .* for content between keywords)
      /(?:union|select|insert|delete|update|drop)[\s\S]*?(?:table|from|into|database)/gi,
      /'\s*(?:or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/gi,

      // Path traversal
      /\.\.\/|\.\.\\|\.\.[/\\]/g,

      // XXE patterns
      /<!ENTITY/gi,
      /<!DOCTYPE[\s\S]+SYSTEM/gi,
    ];

    // Search for each marker pattern
    for (const marker of injectionMarkers) {
      let match;
      const regex = new RegExp(marker);

      while ((match = regex.exec(content)) !== null) {
        const matchText = match[0];

        matches.push({
          pattern: matchText,
          type: patternType,
          severity: severity as 'critical' | 'high' | 'medium' | 'low',
          startOffset: match.index,
          length: matchText.length,
          description: this.getPatternDescription(patternType, matchText),
        });

        // Prevent infinite loops on zero-length matches
        if (regex.lastIndex === match.index) {
          regex.lastIndex++;
        }
      }
    }

    return matches;
  }

  /**
   * Create a sanitized pattern object with metadata
   */
  private static createSanitizedPattern(
    match: PatternMatch
  ): SanitizedPattern {
    const patternId = `PATTERN_${String(++this.patternCounter).padStart(3, '0')}`;

    return {
      ref: patternId,
      description: match.description,
      severity: match.severity,
      location: `offset ${match.startOffset}, length ${match.length}`,
      safetyInstruction: this.getSafetyInstruction(match.severity),
      // Phase 2: Encryption fields will be added here
      // encryptedPattern: undefined,
      // algorithm: undefined,
      // iv: undefined,
    };
  }

  /**
   * Create sanitized content by replacing patterns with references
   */
  private static createSanitizedContent(
    content: string,
    matches: PatternMatch[]
  ): string {
    // Work backwards through matches to maintain correct offsets
    let sanitized = content;
    const sortedMatches = [...matches].sort((a, b) => b.startOffset - a.startOffset);

    let patternIndex = sortedMatches.length;

    for (const match of sortedMatches) {
      const patternRef = `[PATTERN_${String(patternIndex).padStart(3, '0')}]`;
      const beforePattern = sanitized.substring(0, match.startOffset);
      const afterPattern = sanitized.substring(match.startOffset + match.length);

      sanitized = beforePattern + patternRef + afterPattern;
      patternIndex--;
    }

    return sanitized;
  }

  /**
   * Get human-readable description for a pattern type
   */
  private static getPatternDescription(patternType: string, matchText: string): string {
    const descriptions: Record<string, string> = {
      'prompt-injection': 'LLM prompt injection attempt',
      'sql-injection': 'SQL injection pattern',
      'code-injection': 'Code execution pattern',
      'path-traversal': 'Path traversal attempt',
      'xxe': 'XML External Entity (XXE) pattern',
      'xss': 'Cross-site scripting (XSS) pattern',
      'command-injection': 'Command injection pattern',
    };

    const description = descriptions[patternType] || `Security pattern: ${patternType}`;

    // Truncate match text if too long
    const truncatedMatch = matchText.length > 50
      ? matchText.substring(0, 47) + '...'
      : matchText;

    return `${description} - "${truncatedMatch}"`;
  }

  /**
   * Get safety instruction based on severity
   */
  private static getSafetyInstruction(severity: string): string {
    switch (severity) {
      case 'critical':
        return 'CRITICAL - DO NOT EXECUTE - This pattern is malicious and must never be used in production code';
      case 'high':
        return 'HIGH RISK - DO NOT EXECUTE - This pattern should only be used in security testing contexts';
      case 'medium':
        return 'WARNING - This pattern may be dangerous if misused - Use only for security validation';
      case 'low':
        return 'CAUTION - Review before use - May have security implications in certain contexts';
      default:
        return 'This pattern has been extracted for security purposes - Review before use';
    }
  }

  /**
   * Reset the pattern counter (useful for testing)
   */
  static resetCounter(): void {
    this.patternCounter = 0;
  }
}
