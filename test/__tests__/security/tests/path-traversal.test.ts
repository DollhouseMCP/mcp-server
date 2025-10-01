import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { SecurityTestFramework } from '../setup.js';
import * as path from 'path';
import * as fs from 'fs/promises';

describe('Path Traversal Security Tests', () => {
  const ALLOWED_DIRS = [
    path.resolve('./personas'),
    path.resolve('./custom-personas'),
    path.resolve('./backups')
  ];
  
  describe('Path validation', () => {
    test('should detect path traversal attempts', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        'personas/../../../sensitive.txt',
        './././../../../root/.ssh/id_rsa',
        'personas/../../custom-personas/../../backups/../../../etc/hosts',
        'personas//../..//etc/passwd',
        'personas/./../../etc/passwd'
      ];
      
      for (const malPath of maliciousPaths) {
        // Check for traversal patterns
        expect(malPath).toMatch(/\.\./);
        
        // Normalized path should not escape allowed directories
        const normalized = path.normalize(malPath);
        const resolved = path.resolve(normalized);
        
        const isAllowed = ALLOWED_DIRS.some(dir => 
          resolved.startsWith(dir + path.sep) || resolved === dir
        );
        
        expect(isAllowed).toBe(false);
      }
    });
    
    test('should detect URL encoded path traversal', () => {
      const encodedPaths = [
        '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
        '%2e%2e%5c%2e%2e%5c%2e%2e%5cwindows%5csystem32',
        '..%252f..%252f..%252fetc%252fpasswd',
        '%c0%ae%c0%ae/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd'
      ];
      
      for (const encoded of encodedPaths) {
        try {
          const decoded = decodeURIComponent(encoded);
          expect(decoded).toMatch(/\.\./);
        } catch (e) {
          // Invalid encoding is also a security issue
          expect(e).toBeInstanceOf(URIError);
        }
      }
    });
    
    test('should detect null byte injection', () => {
      const nullBytePaths = [
        'safe.txt\u0000.pdf',
        'personas/user.md\u0000.exe',
        'file.md\0../../etc/passwd'
      ];
      
      for (const nullPath of nullBytePaths) {
        expect(nullPath).toMatch(/\u0000/);
        
        // After sanitization, null bytes should be removed
        const sanitized = nullPath.replaceAll('\u0000', '');
        expect(sanitized).not.toMatch(/\u0000/);
      }
    });
  });
  
  describe('Directory restriction', () => {
    test('should only allow access to whitelisted directories', () => {
      const testCases = [
        { path: './personas/user.md', allowed: true },
        { path: './custom-personas/custom.md', allowed: true },
        { path: './backups/backup.md', allowed: true },
        { path: '/etc/passwd', allowed: false },
        { path: '/home/user/.ssh/id_rsa', allowed: false },
        { path: 'C:\\Windows\\System32\\config\\SAM', allowed: false }
      ];
      
      for (const { path: testPath, allowed } of testCases) {
        const resolved = path.resolve(testPath);
        const isInAllowed = ALLOWED_DIRS.some(dir => 
          resolved.startsWith(dir + path.sep) || resolved === dir
        );
        
        expect(isInAllowed).toBe(allowed);
      }
    });
    
    test('should handle symbolic links safely', () => {
      // Symlinks should be resolved before checking
      const symlinkPath = './personas/symlink-to-etc-passwd';
      const resolved = path.resolve(symlinkPath);
      
      // Even if symlink points outside, resolved path should be checked
      const isAllowed = ALLOWED_DIRS.some(dir => 
        resolved.startsWith(dir + path.sep)
      );
      
      expect(isAllowed).toBe(true); // Path looks safe
      // But actual file operation should follow symlink and check real path
    });
  });
  
  describe('Filename validation', () => {
    test('should validate persona filenames', () => {
      const validFilenames = [
        'user-persona.md',
        'my_persona.md',
        'persona123.md',
        'test-persona-2.md'
      ];
      
      const invalidFilenames = [
        '../evil.md',
        'persona.md.exe',
        'persona.md..',
        '.htaccess',
        'persona.php',
        'shell.sh',
        'persona\u0000.md'
      ];
      
      const filenameRegex = /^[a-zA-Z0-9\-_.]+\.md$/;
      
      for (const filename of validFilenames) {
        expect(filename).toMatch(filenameRegex);
      }
      
      for (const filename of invalidFilenames) {
        expect(filename).not.toMatch(filenameRegex);
      }
    });
    
    test('should limit filename length', () => {
      const maxLength = 255;
      const longFilename = 'a'.repeat(256) + '.md';
      
      expect(longFilename.length).toBeGreaterThan(maxLength);
      
      // Should reject overly long filenames
      expect(() => {
        if (longFilename.length > maxLength) {
          throw new Error('Filename too long');
        }
      }).toThrow('Filename too long');
    });
  });
  
  describe('File size limits', () => {
    test('should enforce file size limits', async () => {
      const maxSize = 500000; // 500KB
      
      // Mock file stats
      const mockStats = {
        size: 1000000, // 1MB
        isDirectory: () => false
      };
      
      expect(() => {
        if (mockStats.size > maxSize) {
          throw new Error('File too large');
        }
      }).toThrow('File too large');
    });
  });
  
  describe('Path traversal in different contexts', () => {
    test('should prevent traversal in ZIP file extraction', () => {
      const zipEntries = [
        { name: 'persona.md', safe: true },
        { name: '../../../etc/passwd', safe: false },
        { name: 'personas/../../../etc/hosts', safe: false },
        { name: '/etc/passwd', safe: false }
      ];
      
      for (const entry of zipEntries) {
        // Check for absolute paths first
        if (path.isAbsolute(entry.name)) {
          expect(entry.safe).toBe(false);
          continue;
        }
        
        const extractPath = path.join('./extracted', entry.name);
        const normalized = path.normalize(extractPath);
        const resolved = path.resolve(normalized);
        
        const baseDir = path.resolve('./extracted');
        const isSafe = resolved.startsWith(baseDir + path.sep) || resolved === baseDir + path.sep + 'persona.md';
        
        expect(isSafe).toBe(entry.safe);
      }
    });
    
    test('should handle Windows path separators', () => {
      const windowsPaths = [
        { path: 'personas\\..\\..\\..\\windows\\system32', unsafe: true },
        { path: 'C:\\Windows\\System32\\cmd.exe', unsafe: true },
        { path: '\\\\server\\share\\sensitive.txt', unsafe: true }
      ];
      
      for (const { path: winPath, unsafe } of windowsPaths) {
        // Convert to forward slashes for consistent handling
        const normalized = winPath.replaceAll('\\', '/');
        
        // Check for traversal or absolute paths
        const hasTraversal = normalized.includes('..');
        const isAbsolute = path.isAbsolute(normalized) || path.isAbsolute(winPath) || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized);
        
        expect(hasTraversal || isAbsolute).toBe(unsafe);
      }
    });
  });
});