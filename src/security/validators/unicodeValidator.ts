/**
 * Unicode Validator for DollhouseMCP
 * 
 * Prevents Unicode-based bypass attacks including:
 * - Homograph attacks (visually similar characters)
 * - Direction override attacks (RLO/LRO)
 * - Mixed script attacks
 * - Zero-width character injection
 * - Unicode normalization bypasses
 * 
 * Security: SEC-001 - Unicode attack prevention
 */

import { SecurityError } from '../errors.js';
import { SecurityMonitor } from '../securityMonitor.js';

export interface UnicodeValidationResult {
  isValid: boolean;
  normalizedContent: string;
  detectedIssues?: string[];
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export class UnicodeValidator {
  /**
   * Unicode attack patterns and confusable characters
   */
  private static readonly DIRECTION_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;
  private static readonly ZERO_WIDTH_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;
  private static readonly NON_PRINTABLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;
  
  /**
   * Common homograph/confusable character mappings
   * Maps visually similar Unicode characters to their ASCII equivalents
   */
  private static readonly CONFUSABLE_MAPPINGS: Map<string, string> = new Map([
    // Cyrillic to Latin
    ['а', 'a'], ['е', 'e'], ['о', 'o'], ['р', 'p'], ['с', 'c'], ['х', 'x'], ['у', 'y'],
    ['А', 'A'], ['В', 'B'], ['Е', 'E'], ['К', 'K'], ['М', 'M'], ['Н', 'H'], ['О', 'O'], 
    ['Р', 'P'], ['С', 'C'], ['Т', 'T'], ['У', 'Y'], ['Х', 'X'],
    
    // Greek to Latin
    ['α', 'a'], ['β', 'b'], ['γ', 'g'], ['δ', 'd'], ['ε', 'e'], ['ζ', 'z'], ['η', 'h'],
    ['θ', 'th'], ['ι', 'i'], ['κ', 'k'], ['λ', 'l'], ['μ', 'm'], ['ν', 'n'], ['ξ', 'x'],
    ['ο', 'o'], ['π', 'p'], ['ρ', 'r'], ['σ', 's'], ['τ', 't'], ['υ', 'u'], ['φ', 'f'],
    ['χ', 'ch'], ['ψ', 'ps'], ['ω', 'w'],
    
    // Mathematical symbols to ASCII (various styles)
    ['𝒂', 'a'], ['𝒃', 'b'], ['𝒄', 'c'], ['𝒅', 'd'], ['𝒆', 'e'], ['𝒇', 'f'], ['𝒈', 'g'], ['𝒉', 'h'], ['𝒊', 'i'], ['𝒋', 'j'], ['𝒌', 'k'], ['𝒍', 'l'], ['𝒎', 'm'], ['𝒏', 'n'], ['𝒐', 'o'], ['𝒑', 'p'], ['𝒒', 'q'], ['𝒓', 'r'], ['𝒔', 's'], ['𝒕', 't'], ['𝒖', 'u'], ['𝒗', 'v'], ['𝒘', 'w'], ['𝒙', 'x'], ['𝒚', 'y'], ['𝒛', 'z'],
    ['𝐚', 'a'], ['𝐛', 'b'], ['𝐜', 'c'], ['𝐝', 'd'], ['𝐞', 'e'], ['𝐟', 'f'], ['𝐠', 'g'], ['𝐡', 'h'], ['𝐢', 'i'], ['𝐣', 'j'], ['𝐤', 'k'], ['𝐥', 'l'], ['𝐦', 'm'], ['𝐧', 'n'], ['𝐨', 'o'], ['𝐩', 'p'], ['𝐪', 'q'], ['𝐫', 'r'], ['𝐬', 's'], ['𝐭', 't'], ['𝐮', 'u'], ['𝐯', 'v'], ['𝐰', 'w'], ['𝐱', 'x'], ['𝐲', 'y'], ['𝐳', 'z'],
    
    // Special i variants (Turkish, etc.)
    ['ı', 'i'], ['İ', 'I'], ['і', 'i'], ['Ӏ', 'I'],
    
    // Other common confusables
    ['ǝ', 'e'], ['ɐ', 'a'], ['ɔ', 'o'], ['ʇ', 't'], ['ʌ', 'v'], ['ʍ', 'w'],
    ['℃', 'C'], ['℉', 'F'], ['№', 'No'], ['™', 'TM'], ['®', 'R'],
    
    // Fullwidth characters
    ['Ａ', 'A'], ['Ｂ', 'B'], ['Ｃ', 'C'], ['Ｄ', 'D'], ['Ｅ', 'E'], ['Ｆ', 'F'], ['Ｇ', 'G'], ['Ｈ', 'H'], ['Ｉ', 'I'], ['Ｊ', 'J'], ['Ｋ', 'K'], ['Ｌ', 'L'], ['Ｍ', 'M'], ['Ｎ', 'N'], ['Ｏ', 'O'], ['Ｐ', 'P'], ['Ｑ', 'Q'], ['Ｒ', 'R'], ['Ｓ', 'S'], ['Ｔ', 'T'], ['Ｕ', 'U'], ['Ｖ', 'V'], ['Ｗ', 'W'], ['Ｘ', 'X'], ['Ｙ', 'Y'], ['Ｚ', 'Z'],
    ['ａ', 'a'], ['ｂ', 'b'], ['ｃ', 'c'], ['ｄ', 'd'], ['ｅ', 'e'], ['ｆ', 'f'], ['ｇ', 'g'], ['ｈ', 'h'], ['ｉ', 'i'], ['ｊ', 'j'], ['ｋ', 'k'], ['ｌ', 'l'], ['ｍ', 'm'], ['ｎ', 'n'], ['ｏ', 'o'], ['ｐ', 'p'], ['ｑ', 'q'], ['ｒ', 'r'], ['ｓ', 's'], ['ｔ', 't'], ['ｕ', 'u'], ['ｖ', 'v'], ['ｗ', 'w'], ['ｘ', 'x'], ['ｙ', 'y'], ['ｚ', 'z'],
    ['０', '0'], ['１', '1'], ['２', '2'], ['３', '3'], ['４', '4'], ['５', '5'], ['６', '6'], ['７', '7'], ['８', '8'], ['９', '9'],
  ]);

  /**
   * Script mixing detection patterns
   * Detects suspicious mixing of different Unicode scripts
   */
  private static readonly SCRIPT_PATTERNS = {
    LATIN: /[\u0000-\u007F\u00A0-\u00FF\u0100-\u017F\u0180-\u024F]/,
    CYRILLIC: /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/,
    GREEK: /[\u0370-\u03FF\u1F00-\u1FFF]/,
    ARABIC: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
    HEBREW: /[\u0590-\u05FF\uFB1D-\uFB4F]/,
    CJK: /[\u2E80-\u2EFF\u2F00-\u2FDF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3130-\u318F\u3190-\u319F\u31A0-\u31BF\u31C0-\u31EF\u31F0-\u31FF\u3200-\u32FF\u3300-\u33FF\u3400-\u4DBF\u4DC0-\u4DFF\u4E00-\u9FFF]/,
  };

  /**
   * Normalize Unicode content to prevent bypass attacks
   */
  static normalize(content: string): UnicodeValidationResult {
    const issues: string[] = [];
    let normalized = content;
    let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';

    try {
      // 1. Detect and log suspicious Unicode patterns before normalization
      const suspiciousPatterns = this.detectSuspiciousPatterns(content);
      issues.push(...suspiciousPatterns.issues);
      if (suspiciousPatterns.severity) {
        severity = this.escalateSeverity(severity, suspiciousPatterns.severity);
      }

      // 2. Remove direction override characters (prevents RLO/LRO attacks)
      if (this.DIRECTION_OVERRIDE_CHARS.test(normalized)) {
        issues.push('Direction override characters detected');
        severity = this.escalateSeverity(severity, 'high');
        normalized = normalized.replace(this.DIRECTION_OVERRIDE_CHARS, '');
        
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_DIRECTION_OVERRIDE',
          severity: 'HIGH',
          source: 'unicode_validation',
          details: 'Direction override characters removed from content'
        });
      }

      // 3. Remove zero-width and non-printable characters
      if (this.ZERO_WIDTH_CHARS.test(normalized) || this.NON_PRINTABLE_CHARS.test(normalized)) {
        issues.push('Zero-width or non-printable characters detected');
        severity = this.escalateSeverity(severity, 'medium');
        normalized = normalized
          .replace(this.ZERO_WIDTH_CHARS, '')
          .replace(this.NON_PRINTABLE_CHARS, '');
      }

      // 4. Apply Unicode normalization (NFC - Canonical Decomposition + Composition)
      normalized = normalized.normalize('NFC');

      // 5. Detect mixed script attacks BEFORE confusable replacement
      const mixedScriptResult = this.detectMixedScripts(normalized);
      if (mixedScriptResult.isSuspicious) {
        issues.push(`Mixed script usage detected: ${mixedScriptResult.scripts.join(', ')}`);
        severity = this.escalateSeverity(severity, 'high');
        
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_MIXED_SCRIPT',
          severity: 'HIGH',
          source: 'unicode_validation',
          details: `Mixed scripts detected: ${mixedScriptResult.scripts.join(', ')}`
        });
      }

      // 6. Replace confusable characters with ASCII equivalents (only if suspicious mixing detected)
      const confusableResult = this.replaceConfusables(normalized);
      if (confusableResult.hasConfusables) {
        // Only flag as issue if we also detected suspicious script mixing
        if (mixedScriptResult.isSuspicious) {
          normalized = confusableResult.normalized;
          issues.push('Confusable Unicode characters detected and normalized');
          severity = this.escalateSeverity(severity, 'medium');
        } else {
          // Legitimate multilingual content - don't normalize confusables
          // Just log for monitoring
          SecurityMonitor.logSecurityEvent({
            type: 'UNICODE_VALIDATION_ERROR',
            severity: 'LOW',
            source: 'unicode_validation',
            details: 'Confusable characters detected in multilingual content (not normalized)'
          });
        }
      } else {
        normalized = confusableResult.normalized;
      }

      return {
        isValid: issues.length === 0,
        normalizedContent: normalized,
        detectedIssues: issues.length > 0 ? issues : undefined,
        severity: issues.length > 0 ? severity : undefined
      };

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: 'UNICODE_VALIDATION_ERROR',
        severity: 'HIGH',
        source: 'unicode_validation',
        details: `Unicode validation failed: ${error instanceof Error ? error.message : String(error)}`
      });

      // Fallback: return original content if normalization fails
      return {
        isValid: false,
        normalizedContent: content,
        detectedIssues: ['Unicode validation failed'],
        severity: 'high'
      };
    }
  }

  /**
   * Detect suspicious Unicode patterns that might indicate attacks
   */
  private static detectSuspiciousPatterns(content: string): { issues: string[]; severity?: 'low' | 'medium' | 'high' | 'critical' } {
    const issues: string[] = [];
    let severity: 'low' | 'medium' | 'high' | 'critical' | undefined;

    // Check for excessive Unicode escapes (possible encoding bypass)
    const unicodeEscapePattern = /\\u[0-9a-fA-F]{4}/g;
    const unicodeEscapes = content.match(unicodeEscapePattern);
    if (unicodeEscapes && unicodeEscapes.length > 10) {
      issues.push(`Excessive Unicode escapes detected (${unicodeEscapes.length})`);
      severity = 'high';
    }

    // Check for suspicious Unicode ranges that might hide content
    const suspiciousRanges = [
      { range: /[\uE000-\uF8FF]/g, name: 'Private Use Area' },
      // Note: Surrogate pairs [\uD800-\uDFFF] are normal for emojis and extended Unicode - removed
      { range: /[\uFDD0-\uFDEF]/g, name: 'Non-characters' },
      { range: /[\uFFFE\uFFFF]/g, name: 'Non-characters' }
    ];

    for (const { range, name } of suspiciousRanges) {
      if (range.test(content)) {
        issues.push(`Suspicious Unicode range detected: ${name}`);
        severity = this.escalateSeverity(severity, 'medium');
      }
    }

    return { issues, severity };
  }

  /**
   * Replace confusable Unicode characters with ASCII equivalents
   */
  private static replaceConfusables(content: string): { normalized: string; hasConfusables: boolean } {
    let normalized = content;
    let hasConfusables = false;

    for (const [confusable, replacement] of this.CONFUSABLE_MAPPINGS) {
      if (normalized.includes(confusable)) {
        normalized = normalized.replace(new RegExp(this.escapeRegex(confusable), 'g'), replacement);
        hasConfusables = true;
      }
    }

    return { normalized, hasConfusables };
  }

  /**
   * Detect suspicious mixing of different Unicode scripts
   */
  private static detectMixedScripts(content: string): { isSuspicious: boolean; scripts: string[] } {
    const detectedScripts: string[] = [];

    for (const [scriptName, pattern] of Object.entries(this.SCRIPT_PATTERNS)) {
      if (pattern.test(content)) {
        detectedScripts.push(scriptName);
      }
    }

    // Consider it suspicious if:
    // 1. More than 3 scripts are mixed (legitimate text rarely mixes >3 scripts)
    // 2. Content contains Latin + dangerous confusable scripts (Cyrillic/Greek - common attack pattern)
    // Note: Latin + CJK is common and legitimate (e.g., Chinese with English)
    const isSuspicious = detectedScripts.length > 3 || 
      (detectedScripts.includes('LATIN') && detectedScripts.length > 1 && 
       (detectedScripts.includes('CYRILLIC') || detectedScripts.includes('GREEK')));

    return { isSuspicious, scripts: detectedScripts };
  }

  /**
   * Escalate severity level (higher severity takes precedence)
   */
  private static escalateSeverity(
    current: 'low' | 'medium' | 'high' | 'critical' | undefined, 
    newSeverity: 'low' | 'medium' | 'high' | 'critical'
  ): 'low' | 'medium' | 'high' | 'critical' {
    const severityLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    const currentLevel = current ? severityLevels[current] : 0;
    const newLevel = severityLevels[newSeverity];
    
    return newLevel > currentLevel ? newSeverity : (current || 'low');
  }

  /**
   * Escape special regex characters for safe replacement
   */
  private static escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Check if content contains potentially dangerous Unicode patterns
   */
  static containsDangerousUnicode(content: string): boolean {
    // Quick check for obviously dangerous patterns
    return this.DIRECTION_OVERRIDE_CHARS.test(content) ||
           this.ZERO_WIDTH_CHARS.test(content) ||
           this.NON_PRINTABLE_CHARS.test(content) ||
           /\\u[0-9a-fA-F]{4}/.test(content) && content.match(/\\u[0-9a-fA-F]{4}/g)!.length > 10;
  }

  /**
   * Get safe preview of Unicode content for logging
   */
  static getSafePreview(content: string, maxLength: number = 100): string {
    // Remove dangerous Unicode characters and truncate for safe logging
    const cleaned = content
      .replace(this.DIRECTION_OVERRIDE_CHARS, '[DIR]')
      .replace(this.ZERO_WIDTH_CHARS, '[ZW]')
      .replace(this.NON_PRINTABLE_CHARS, '[NP]');
    
    return cleaned.length > maxLength ? 
      cleaned.substring(0, maxLength) + '...' : 
      cleaned;
  }
}