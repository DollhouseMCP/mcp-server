/**
 * Tests for SecureYamlParser Windows line ending support
 *
 * Ensures the parser correctly handles both Unix (\n) and Windows (\r\n) line endings
 * in YAML frontmatter, preventing the "Memory must have metadata with name" error
 * that occurred on Windows CI.
 */

import { describe, it, expect } from '@jest/globals';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';

describe('SecureYamlParser - Windows Line Endings', () => {
  const markdownContent = `
# Test Content

This is test markdown content.
`;

  describe('Unix line endings (\\n)', () => {
    it('should parse YAML with Unix line endings', () => {
      const input = `---\nname: test-element\ntype: memory\ndescription: Test element\nversion: 1.0.0\n---\n${markdownContent}`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.data.type).toBe('memory');
      expect(result.data.description).toBe('Test element');
      expect(result.data.version).toBe('1.0.0');
      expect(result.content).toContain('Test Content');
    });

    it('should parse frontmatter-only YAML with Unix line endings', () => {
      const input = `---\nname: test-element\ntype: memory\ndescription: Test element\nversion: 1.0.0\n---`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.content).toBe('');
    });
  });

  describe('Windows line endings (\\r\\n)', () => {
    it('should parse YAML with Windows line endings', () => {
      const input = `---\r\nname: test-element\r\ntype: memory\r\ndescription: Test element\r\nversion: 1.0.0\r\n---\r\n${markdownContent}`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.data.type).toBe('memory');
      expect(result.data.description).toBe('Test element');
      expect(result.data.version).toBe('1.0.0');
      expect(result.content).toContain('Test Content');
    });

    it('should parse frontmatter-only YAML with Windows line endings', () => {
      const input = `---\r\nname: test-element\r\ntype: memory\r\ndescription: Test element\r\nversion: 1.0.0\r\n---`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.content).toBe('');
    });

    it('should parse complex YAML structure with Windows line endings', () => {
      const input = `---\r\nname: test-memory\r\ntype: memory\r\ndescription: Test memory\r\nversion: 1.0.0\r\ntags:\r\n  - test\r\n  - memory\r\ntriggers:\r\n  - test-trigger\r\n---\r\n# Memory Content\r\n\r\nThis is memory content.`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-memory');
      expect(result.data.tags).toEqual(['test', 'memory']);
      expect(result.data.triggers).toEqual(['test-trigger']);
      expect(result.content).toContain('Memory Content');
    });
  });

  describe('Mixed line endings', () => {
    it('should handle mixed line endings gracefully', () => {
      // Frontmatter with Windows endings, content with Unix endings
      const input = `---\r\nname: test-element\r\ntype: memory\r\ndescription: Test element\r\nversion: 1.0.0\r\n---\n${markdownContent}`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.content).toContain('Test Content');
    });

    it('should handle Unix frontmatter with Windows content', () => {
      const windowsContent = '# Test\r\n\r\nContent with Windows line endings.\r\n';
      const input = `---\nname: test-element\ntype: memory\ndescription: Test element\nversion: 1.0.0\n---\n${windowsContent}`;

      const result = SecureYamlParser.parse(input);

      expect(result.data.name).toBe('test-element');
      expect(result.content).toContain('Content with Windows line endings');
    });
  });

  describe('Regression test - Memory seed installation', () => {
    it('should not fail with "Memory must have metadata with name" error on Windows', () => {
      // Simulate seed file with Windows line endings (as it would appear on Windows CI)
      const seedContent = `---\r\nname: dollhousemcp-baseline-knowledge\r\ntype: memory\r\ndescription: Baseline knowledge about DollhouseMCP\r\nversion: 1.0.0\r\nauthor: DollhouseMCP\r\n---\r\n\r\n# DollhouseMCP\r\n\r\nTest content here.`;

      // This should NOT throw "Memory must have metadata with name"
      const result = SecureYamlParser.parse(seedContent);

      expect(result.data).toBeDefined();
      expect(result.data.name).toBe('dollhousemcp-baseline-knowledge');
      expect(result.data.type).toBe('memory');
      expect(result.data.description).toBe('Baseline knowledge about DollhouseMCP');
    });
  });

  describe('Edge cases', () => {
    it('should return empty data for content without frontmatter', () => {
      const input = 'Just plain markdown content\nNo frontmatter here';

      const result = SecureYamlParser.parse(input);

      expect(result.data).toEqual({});
      expect(result.content).toBe(input);
    });

    it('should handle empty frontmatter gracefully', () => {
      const input = `---\r\n---\r\n${markdownContent}`;

      const result = SecureYamlParser.parse(input);

      // Empty frontmatter should result in empty or null data
      expect(result.data).toBeDefined();
      expect(result.content).toContain('Test Content');
    });
  });
});
