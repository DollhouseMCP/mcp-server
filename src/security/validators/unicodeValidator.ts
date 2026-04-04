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

import { SecurityMonitor } from '../securityMonitor.js';
import { escalateSeverity } from '../constants.js';

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
  
  /**
   * Direction override characters that can hide or reverse text display
   * @see https://unicode.org/reports/tr9/#Directional_Formatting_Characters
   * U+202A-U+202E: Left/Right embedding and override marks (LRE, RLE, PDF, LRO, RLO)
   * U+2066-U+2069: Isolate formatting characters (LRI, RLI, FSI, PDI)
   */
  private static readonly DIRECTION_OVERRIDE_CHARS = /[\u202A-\u202E\u2066-\u2069]/g;
  
  /**
   * Zero-width and invisible formatting characters often used to hide payloads
   * U+200B-U+200F: Zero-width spaces and directional marks
   * U+2028-U+202F: Line/paragraph separators and formatting characters
   * U+FEFF: Zero-width no-break space (Byte Order Mark)
   */
  private static readonly ZERO_WIDTH_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g;
  
  /**
   * Non-printable control characters that should not appear in normal text
   * U+0000-U+0008, U+000B-U+000C, U+000E-U+001F: C0 control codes (except TAB, LF, CR)
   * U+007F-U+009F: Delete and C1 control codes
   * U+FFFE-U+FFFF: Non-characters that should never appear in valid text
   */
  // eslint-disable-next-line no-control-regex -- Intentionally matching control chars for security sanitization
  private static readonly NON_PRINTABLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g; // NOSONAR - Intentionally matching control characters for security sanitization
  
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
    // eslint-disable-next-line no-control-regex -- Intentionally includes control chars for comprehensive Latin script detection
    LATIN: /[\u0000-\u007F\u00A0-\u00FF\u0100-\u017F\u0180-\u024F]/, // NOSONAR - Intentionally includes control characters for comprehensive Latin script detection
    // Use alternation to avoid SonarCloud thinking \u052F\u2DE0 is a combined character
    CYRILLIC: /(?:[\u0400-\u04FF]|[\u0500-\u052F]|[\u2DE0-\u2DFF]|[\uA640-\uA69F])/,
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
        severity = escalateSeverity(severity, suspiciousPatterns.severity);
      }

      // 2. Remove direction override characters (prevents RLO/LRO attacks)
      if (this.DIRECTION_OVERRIDE_CHARS.test(normalized)) {
        issues.push('Direction override characters detected');
        severity = escalateSeverity(severity, 'high');
        normalized = normalized.replace(this.DIRECTION_OVERRIDE_CHARS, '');
        
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_DIRECTION_OVERRIDE',
          severity: 'HIGH',
          source: 'UnicodeValidator',
          details: 'Direction override characters removed from content'
        });
      }

      // 3. Remove zero-width and non-printable characters
      if (this.ZERO_WIDTH_CHARS.test(normalized) || this.NON_PRINTABLE_CHARS.test(normalized)) {
        // Check if the zero-width chars include direction marks (U+200E, U+200F)
        const hasDirectionMarks = /[\u200E\u200F]/.test(normalized);
        if (hasDirectionMarks) {
          issues.push('Direction marks (LRM/RLM) detected');
          severity = escalateSeverity(severity, 'high');
        } else {
          issues.push('Zero-width or non-printable characters detected');
          severity = escalateSeverity(severity, 'medium');
        }
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
        severity = escalateSeverity(severity, 'high');
        
        SecurityMonitor.logSecurityEvent({
          type: 'UNICODE_MIXED_SCRIPT',
          severity: 'HIGH',
          source: 'UnicodeValidator',
          details: `Mixed scripts detected: ${mixedScriptResult.scripts.join(', ')}`
        });
      }

      // 6. Always replace confusable characters with ASCII equivalents for security
      // This prevents homograph attacks regardless of script mixing
      const confusableResult = this.replaceConfusables(normalized);
      if (confusableResult.hasConfusables) {
        normalized = confusableResult.normalized;
        issues.push('Confusable Unicode characters detected and normalized');
        severity = escalateSeverity(severity, 'medium');
        
        // Log if this happens in legitimate multilingual context
        if (!mixedScriptResult.isSuspicious) {
          SecurityMonitor.logSecurityEvent({
            type: 'UNICODE_VALIDATION_ERROR',
            severity: 'LOW',
            source: 'UnicodeValidator',
            details: 'Confusable characters normalized in legitimate multilingual content'
          });
        }
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
        source: 'UnicodeValidator',
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
    /**
     * Pattern to match Unicode escape sequences
     * \\u: Literal backslash followed by 'u'
     * [0-9a-fA-F]{4}: Exactly 4 hexadecimal digits
     * Used to detect attempts to bypass filters using \u0061dmin style encoding
     */
    const unicodeEscapePattern = /\\u[0-9a-fA-F]{4}/g;
    const unicodeEscapes = content.match(unicodeEscapePattern);
    if (unicodeEscapes && unicodeEscapes.length > 10) {
      issues.push(`Excessive Unicode escapes detected (${unicodeEscapes.length})`);
      severity = 'high';
    }

    // Check for suspicious Unicode ranges that might hide content
    const suspiciousRanges = [
      { range: /[\uE000-\uF8FF]/g, name: 'Private Use Area' },
      // Note: Properly paired surrogate pairs [\uD800-\uDFFF] are normal for emojis
      { range: /[\uFDD0-\uFDEF]/g, name: 'Non-characters' },
      { range: /[\uFFFE\uFFFF]/g, name: 'Non-characters' }
    ];

    for (const { range, name } of suspiciousRanges) {
      if (range.test(content)) {
        issues.push(`Suspicious Unicode range detected: ${name}`);
        severity = escalateSeverity(severity, 'medium');
      }
    }

    // Check for malformed surrogate pairs using safe character-by-character validation
    // This avoids ReDoS vulnerabilities from complex regex patterns
    if (this.hasMalformedSurrogates(content)) {
      issues.push('Malformed surrogate pairs detected');
      severity = escalateSeverity(severity, 'high');
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
    // 2. Content contains Latin + Cyrillic (homoglyph attack — Cyrillic а/о/р look identical to Latin)
    // Note: Latin + CJK is common and legitimate (e.g., Chinese with English)
    // Note: Latin + Greek is common and legitimate (e.g., α, β, γ, π, Σ, Δ in math/science)
    const isSuspicious = detectedScripts.length > 3 ||
      (detectedScripts.includes('LATIN') && detectedScripts.length > 1 &&
       detectedScripts.includes('CYRILLIC'));

    return { isSuspicious, scripts: detectedScripts };
  }

  /**
   * Escape special regex characters for safe replacement
   */
  private static escapeRegex(string: string): string {
    return string.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Check if content contains potentially dangerous Unicode patterns
   */
  static containsDangerousUnicode(content: string): boolean {
    // Quick check for obviously dangerous patterns
    return this.DIRECTION_OVERRIDE_CHARS.test(content) ||
           this.ZERO_WIDTH_CHARS.test(content) ||
           this.NON_PRINTABLE_CHARS.test(content) ||
           this.hasExcessiveUnicodeEscapes(content);
  }

  /**
   * Check if content has excessive Unicode escape sequences
   * Prevents null pointer exception by safely checking match results
   */
  private static hasExcessiveUnicodeEscapes(content: string): boolean {
    const matches = content.match(/\\u[0-9a-fA-F]{4}/g);
    return matches !== null && matches.length > 10;
  }

  /**
   * Safely check for malformed surrogate pairs without ReDoS vulnerability
   * Uses character-by-character validation instead of complex regex
   */
  private static hasMalformedSurrogates(content: string): boolean {
    for (let i = 0; i < content.length; i++) {
      // SONARCLOUD FALSE POSITIVE (S7758): Must use charCodeAt here, not codePointAt
      // This code specifically checks for malformed surrogate pairs at the 16-bit code unit level.
      // codePointAt() would automatically combine valid pairs, making malformed detection impossible.
      const char = content.charCodeAt(i);

      // High surrogate (U+D800-U+DBFF)
      if (char >= 0xD800 && char <= 0xDBFF) {
        // Check if it's followed by a low surrogate
        if (i + 1 >= content.length) {
          return true; // High surrogate at end of string
        }
        const nextChar = content.charCodeAt(i + 1);
        if (nextChar < 0xDC00 || nextChar > 0xDFFF) {
          return true; // High surrogate not followed by low surrogate
        }
        i++; // Skip the valid low surrogate
      }
      // Low surrogate (U+DC00-U+DFFF) without preceding high surrogate
      else if (char >= 0xDC00 && char <= 0xDFFF) {
        return true; // Unpaired low surrogate
      }
    }
    return false;
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
