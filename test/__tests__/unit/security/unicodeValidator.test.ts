/**
 * Unicode Validator Tests
 * 
 * Tests Unicode attack prevention including:
 * - Homograph attacks
 * - Direction override attacks 
 * - Mixed script attacks
 * - Zero-width character injection
 * - Unicode normalization bypasses
 */

import { UnicodeValidator } from '../../../../src/security/validators/unicodeValidator.js';

describe('UnicodeValidator', () => {
  describe('normalize', () => {
    test('should pass through normal ASCII content unchanged', () => {
      const content = 'Hello World! This is normal ASCII text.';
      const result = UnicodeValidator.normalize(content);
      
      expect(result.isValid).toBe(true);
      expect(result.normalizedContent).toBe(content);
      expect(result.detectedIssues).toBeUndefined();
      expect(result.severity).toBeUndefined();
    });

    test('should normalize Unicode to NFC form', () => {
      // é can be represented as single character (é) or as e + combining accent (é)
      const composed = 'café'; // Single character é
      const decomposed = 'cafe\u0301'; // e + combining acute accent
      
      const result1 = UnicodeValidator.normalize(composed);
      const result2 = UnicodeValidator.normalize(decomposed);
      
      expect(result1.normalizedContent).toBe(result2.normalizedContent);
      expect(result1.normalizedContent).toBe('café');
    });
  });

  describe('Direction Override Attack Prevention', () => {
    test('should detect and remove RLO (Right-to-Left Override) characters', () => {
      const maliciousContent = 'admin\u202Eeval\u202Dpassword'; // RLO chars
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('adminevalpassword');
      expect(result.detectedIssues).toContain('Direction override characters detected');
      expect(result.severity).toBe('high');
    });

    test('should detect and remove LRO (Left-to-Right Override) characters', () => {
      const maliciousContent = 'test\u202Dhidden\u202Ccontent'; // LRO chars
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('testhiddencontent');
      expect(result.detectedIssues).toContain('Direction override characters detected');
      expect(result.severity).toBe('high');
    });

    test('should detect bidirectional isolate characters', () => {
      const maliciousContent = 'safe\u2066dangerous\u2069content'; // FSI/PDI
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('safedangerouscontent');
      expect(result.detectedIssues).toContain('Direction override characters detected');
    });
  });

  describe('Zero-Width Character Attack Prevention', () => {
    test('should detect and remove zero-width spaces', () => {
      const maliciousContent = 'admin\u200Bpassword\u200Ceval'; // ZWSP, ZWNJ
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('adminpasswordeval');
      expect(result.detectedIssues).toContain('Zero-width or non-printable characters detected');
      expect(result.severity).toBe('medium');
    });

    test('should detect line and paragraph separators', () => {
      const maliciousContent = 'line1\u2028line2\u2029paragraph'; // LS, PS
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('line1line2paragraph');
      expect(result.detectedIssues).toContain('Zero-width or non-printable characters detected');
    });

    test('should detect BOM and non-characters', () => {
      const maliciousContent = '\uFEFFtest\uFFFEcontent\uFFFF'; // BOM, non-chars
      const result = UnicodeValidator.normalize(maliciousContent);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('testcontent');
      expect(result.detectedIssues).toContain('Zero-width or non-printable characters detected');
    });
  });

  describe('Homograph Attack Prevention', () => {
    test('should normalize Cyrillic characters to Latin equivalents', () => {
      // Cyrillic 'а' looks like Latin 'a' but has different Unicode
      const cyrillicAttack = 'аdmin'; // First char is Cyrillic 'а' (U+0430)
      const result = UnicodeValidator.normalize(cyrillicAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('admin'); // Normalized to Latin
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
      expect(result.severity).toBe('high'); // Mixed script detected first, escalates to high
    });

    test('should normalize Greek characters to Latin equivalents', () => {
      const greekAttack = 'αdmin'; // Greek alpha
      const result = UnicodeValidator.normalize(greekAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('admin');
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
    });

    test('should normalize Turkish dotless i', () => {
      const turkishAttack = 'admın'; // Turkish dotless i (ı)
      const result = UnicodeValidator.normalize(turkishAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('admin');
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
    });

    test('should normalize mathematical styled characters', () => {
      const mathAttack = '𝒂𝒅𝒎𝒊𝒏'; // Mathematical script characters
      const result = UnicodeValidator.normalize(mathAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('admin');
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
    });

    test('should normalize fullwidth characters', () => {
      const fullwidthAttack = 'ａｄｍｉｎ'; // Fullwidth Latin
      const result = UnicodeValidator.normalize(fullwidthAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('admin');
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
    });
  });

  describe('Mixed Script Attack Detection', () => {
    test('should detect suspicious Latin + Cyrillic mixing', () => {
      const mixedScript = 'adminрassword'; // Latin + Cyrillic 'р'
      const result = UnicodeValidator.normalize(mixedScript);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('adminpassword'); // Normalized
      expect(result.detectedIssues).toContain('Mixed script usage detected: LATIN, CYRILLIC');
      expect(result.severity).toBe('high');
    });

    test('should detect Latin + Greek mixing', () => {
      const mixedScript = 'adminπassword'; // Latin + Greek π
      const result = UnicodeValidator.normalize(mixedScript);
      
      expect(result.isValid).toBe(false);
      expect(result.detectedIssues).toContain('Mixed script usage detected: LATIN, GREEK');
      expect(result.severity).toBe('high');
    });

    test('should allow single script usage', () => {
      const pureGreek = 'αβγδε'; // Pure Greek
      const result = UnicodeValidator.normalize(pureGreek);
      
      // Pure Greek should be valid (no mixing) - but confusables are detected
      expect(result.isValid).toBe(false); // Confusables detected, but not mixed scripts
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
      expect(result.detectedIssues).not.toContain('Mixed script usage detected');
    });

    test('should detect excessive script mixing', () => {
      const multiScript = 'aαаأا'; // Latin + Greek + Cyrillic + Arabic + Arabic
      const result = UnicodeValidator.normalize(multiScript);
      
      expect(result.isValid).toBe(false);
      // Script order may vary, so check if it contains the expected scripts
      expect(result.detectedIssues!.some(issue => 
        issue.includes('Mixed script usage detected') && 
        issue.includes('LATIN') && 
        issue.includes('GREEK') && 
        issue.includes('CYRILLIC') && 
        issue.includes('ARABIC')
      )).toBe(true);
      expect(result.severity).toBe('high');
    });
  });

  describe('Unicode Escape Attack Detection', () => {
    test('should detect excessive Unicode escapes', () => {
      // Simulate base64 encoded payload with many Unicode escapes
      const escapeAttack = '\\u0065\\u0076\\u0061\\u006c\\u0028\\u0022\\u006d\\u0061\\u006c\\u0069\\u0063\\u0069\\u006f\\u0075\\u0073\\u0022\\u0029';
      const result = UnicodeValidator.normalize(escapeAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.detectedIssues).toContain('Excessive Unicode escapes detected (17)');
      expect(result.severity).toBe('high');
    });

    test('should allow normal Unicode escapes', () => {
      const normalEscape = 'Hello \\u0041 World'; // Just one Unicode A
      const result = UnicodeValidator.normalize(normalEscape);
      
      expect(result.isValid).toBe(true);
    });
  });

  describe('Suspicious Unicode Range Detection', () => {
    test('should detect Private Use Area characters', () => {
      const privateUse = 'test\uE000hidden\uF8FFcontent'; // PUA chars
      const result = UnicodeValidator.normalize(privateUse);
      
      expect(result.isValid).toBe(false);
      expect(result.detectedIssues).toContain('Suspicious Unicode range detected: Private Use Area');
      expect(result.severity).toBe('medium');
    });

    test('should detect non-character codepoints', () => {
      const nonChar = 'test\uFDD0content\uFDEF'; // Non-characters
      const result = UnicodeValidator.normalize(nonChar);
      
      expect(result.isValid).toBe(false);
      expect(result.detectedIssues).toContain('Suspicious Unicode range detected: Non-characters');
      expect(result.severity).toBe('medium');
    });
  });

  describe('Combined Attack Scenarios', () => {
    test('should handle multiple attack vectors simultaneously', () => {
      // Combine direction override + homographs + zero-width
      const complexAttack = 'аdmin\u202E\u200Beval\u202Dπassword';
      const result = UnicodeValidator.normalize(complexAttack);
      
      expect(result.isValid).toBe(false);
      expect(result.detectedIssues).toHaveLength(4); // Direction override, zero-width, mixed scripts, confusables
      expect(result.severity).toBe('high'); // Highest severity
      expect(result.normalizedContent).toBe('adminevalpassword');
    });

    test('should escalate severity correctly', () => {
      // Start with medium (confusables) then add high (direction override)
      const escalatedAttack = 'аdmin\u202Eeval';
      const result = UnicodeValidator.normalize(escalatedAttack);
      
      expect(result.severity).toBe('high'); // Should escalate to high
    });
  });

  describe('Real-world Attack Simulations', () => {
    test('should prevent domain spoofing attack', () => {
      // Simulate phishing URL with Cyrillic characters
      const spoofedDomain = 'gоogle.com'; // Cyrillic 'о' instead of Latin 'o'
      const result = UnicodeValidator.normalize(spoofedDomain);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('google.com');
      expect(result.detectedIssues).toContain('Confusable Unicode characters detected and normalized');
    });

    test('should prevent hidden command injection', () => {
      // Use direction override to hide malicious content
      const hiddenCommand = 'safe_command\u202E && rm -rf /\u202D_safe';
      const result = UnicodeValidator.normalize(hiddenCommand);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('safe_command && rm -rf /_safe');
      expect(result.detectedIssues).toContain('Direction override characters detected');
      expect(result.severity).toBe('high');
    });

    test('should prevent invisible character payload injection', () => {
      // Hide payload using zero-width characters
      const invisiblePayload = 'normal\u200Beval("malicious")\u200Ctext';
      const result = UnicodeValidator.normalize(invisiblePayload);
      
      expect(result.isValid).toBe(false);
      expect(result.normalizedContent).toBe('normaleval("malicious")text');
      expect(result.detectedIssues).toContain('Zero-width or non-printable characters detected');
    });
  });

  describe('Utility Methods', () => {
    describe('containsDangerousUnicode', () => {
      test('should detect dangerous Unicode patterns quickly', () => {
        expect(UnicodeValidator.containsDangerousUnicode('safe text')).toBe(false);
        expect(UnicodeValidator.containsDangerousUnicode('text\u202Ewith RLO')).toBe(true);
        expect(UnicodeValidator.containsDangerousUnicode('text\u200Bwith ZWSP')).toBe(true);
        
        // Many Unicode escapes
        const manyEscapes = '\\u0065\\u0076\\u0061\\u006c\\u0028\\u0022\\u006d\\u0061\\u006c\\u0069\\u0063\\u0069\\u006f\\u0075\\u0073\\u0022\\u0029';
        expect(UnicodeValidator.containsDangerousUnicode(manyEscapes)).toBe(true);
      });
    });

    describe('getSafePreview', () => {
      test('should create safe preview for logging', () => {
        const dangerous = 'test\u202Ewith\u200Bdangerous\u0001chars';
        const preview = UnicodeValidator.getSafePreview(dangerous, 50);
        
        expect(preview).toBe('test[DIR]with[ZW]dangerous[NP]chars');
        expect(preview.length).toBeLessThanOrEqual(50);
      });

      test('should truncate long content', () => {
        const longText = 'a'.repeat(200);
        const preview = UnicodeValidator.getSafePreview(longText, 50);
        
        expect(preview.length).toBeLessThanOrEqual(53); // 50 + '...'
        expect(preview.endsWith('...')).toBe(true);
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle normalization errors gracefully', () => {
      // Mock normalize to throw an error
      const originalNormalize = String.prototype.normalize;
      String.prototype.normalize = () => { throw new Error('Normalization failed'); };
      
      try {
        const result = UnicodeValidator.normalize('test content');
        
        expect(result.isValid).toBe(false);
        expect(result.normalizedContent).toBe('test content'); // Fallback to original
        expect(result.detectedIssues).toContain('Unicode validation failed');
        expect(result.severity).toBe('high');
      } finally {
        // Restore original method
        String.prototype.normalize = originalNormalize;
      }
    });
  });

  describe('Performance', () => {
    test('should handle large content efficiently', () => {
      // Create 50KB of mixed content
      const largeContent = 'a'.repeat(25000) + 'б'.repeat(25000); // Latin + Cyrillic
      
      const startTime = process.hrtime.bigint();
      const result = UnicodeValidator.normalize(largeContent);
      const endTime = process.hrtime.bigint();
      
      const durationMs = Number(endTime - startTime) / 1_000_000;
      
      expect(result.isValid).toBe(false); // Mixed scripts
      expect(durationMs).toBeLessThan(100); // Should complete in under 100ms
    });

    test('should be fast for normal content', () => {
      const normalContent = 'This is a normal English sentence with some numbers 123 and symbols !@#$%';
      
      const startTime = process.hrtime.bigint();
      const result = UnicodeValidator.normalize(normalContent);
      const endTime = process.hrtime.bigint();
      
      const durationMs = Number(endTime - startTime) / 1_000_000;
      
      expect(result.isValid).toBe(true);
      expect(durationMs).toBeLessThan(10); // Should be very fast for normal content
    });
  });
});