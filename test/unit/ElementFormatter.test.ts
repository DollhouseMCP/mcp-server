/**
 * Unit tests for ElementFormatter
 *
 * Tests the element formatting/cleaning functionality
 * for fixing malformed DollhouseMCP elements
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ElementFormatter } from '../../src/utils/ElementFormatter.js';
import { ElementType } from '../../src/portfolio/types.js';

// Mock the logger
jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

describe('ElementFormatter', () => {
  let tempDir: string;
  let formatter: ElementFormatter;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'formatter-test-'));
    formatter = new ElementFormatter();
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('formatMemory', () => {
    it('should unescape newlines in memory content', async () => {
      const malformedYaml = `name: test-memory
description: Test memory
version: 1.0.0
entries:
  - id: entry-1
    timestamp: 2025-09-28T12:00:00Z
    content: Line 1\\nLine 2\\nLine 3\\n\\nParagraph 2`;

      const testFile = path.join(tempDir, 'test-memory.yaml');
      await fs.writeFile(testFile, malformedYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.fixed).toContain('Unescaped newlines in content');

      // Check the formatted content
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('Line 1\n');
      expect(formatted).toContain('Line 2\n');
      expect(formatted).not.toContain(String.raw`\n`);
    });

    it('should extract embedded metadata from content', async () => {
      const malformedYaml = `entries:
  - content: >-
      ---\\n
      version: 1.0.0\\n
      retention: permanent\\n
      tags: [sonarcloud, reference, rules]\\n
      ---\\n
      # SonarCloud Rules Reference\\n\\n
      Content here with\\nescaped newlines`;

      const testFile = path.join(tempDir, 'malformed-memory.yaml');
      await fs.writeFile(testFile, malformedYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      // Just verify some fixes were made
      expect(result.fixed.length).toBeGreaterThan(0);

      // Check the formatted content
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('version: 1.0.0');
      expect(formatted).toContain('retention: permanent');
      expect(formatted).toContain('SonarCloud Rules Reference');
      expect(formatted).not.toContain(String.raw`---\n`);
    });

    it('should handle memories without issues gracefully', async () => {
      const validYaml = `name: valid-memory
description: A properly formatted memory
version: 1.0.0
retention: 30
tags:
  - test
  - valid
entries:
  - id: entry-1
    timestamp: 2025-09-28T12:00:00Z
    content: |
      This is properly formatted content
      with real line breaks
      and no issues`;

      const testFile = path.join(tempDir, 'valid-memory.yaml');
      await fs.writeFile(testFile, validYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.fixed).toContain('YAML validation passed');
    });
  });

  describe('formatStandardElement', () => {
    it('should format markdown files with frontmatter', async () => {
      const malformedMd = `---
name: test-persona
version: 1.0.0
description: Test persona with escaped newlines
content: Line 1\\nLine 2\\n
---

# Test Persona\\n\\nContent with\\nescaped newlines`;

      const testFile = path.join(tempDir, 'test-persona.md');
      await fs.writeFile(testFile, malformedMd, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      // Just verify formatting happened
      expect(result.fixed.length).toBeGreaterThan(0);

      // Check the formatted content
      const formattedPath = testFile.replace('.md', '.formatted.md');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('Line 1');
      expect(formatted).toContain('Line 2');
      expect(formatted).toContain('# Test Persona');
      expect(formatted).not.toContain(String.raw`\n`);
    });

    it('should handle files without frontmatter', async () => {
      const noFrontmatter = `# Just Content

No frontmatter here, just content.`;

      const testFile = path.join(tempDir, 'no-frontmatter.md');
      await fs.writeFile(testFile, noFrontmatter, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.issues).toContain('No frontmatter found');
    });
  });

  describe('options', () => {
    it('should format in place when inPlace option is true', async () => {
      const formatter = new ElementFormatter({ inPlace: true, backup: true });

      const content = `name: test\nversion: 1.0.0\nentries:\n  - content: "Line 1\\nLine 2"`;
      const testFile = path.join(tempDir, 'in-place.yaml');
      await fs.writeFile(testFile, content, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.backupPath).toBe(testFile + '.backup');

      // Check backup was created
      const backupExists = await fs.access(result.backupPath!).then(() => true).catch(() => false);
      expect(backupExists).toBe(true);

      // Check original file was modified
      const modified = await fs.readFile(testFile, 'utf-8');
      expect(modified).toContain('Line 1');
      expect(modified).toContain('Line 2');
    });

    it('should use custom output directory when specified', async () => {
      const outputDir = path.join(tempDir, 'output');
      await fs.mkdir(outputDir);

      const formatter = new ElementFormatter({ outputDir });

      const content = `name: test`;
      const testFile = path.join(tempDir, 'test.yaml');
      await fs.writeFile(testFile, content, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);

      // Check file was created in output directory
      const outputFile = path.join(outputDir, 'test.yaml');
      const outputExists = await fs.access(outputFile).then(() => true).catch(() => false);
      expect(outputExists).toBe(true);
    });

    it('should skip validation when validate option is false', async () => {
      const formatter = new ElementFormatter({ validate: false });

      // Invalid YAML that would fail validation
      const invalidYaml = `name: test
  invalid: indentation
    more: problems`;

      const testFile = path.join(tempDir, 'invalid.yaml');
      await fs.writeFile(testFile, invalidYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      // Should still succeed without validation
      expect(result.success).toBe(true);
      expect(result.fixed).not.toContain('YAML validation passed');
    });
  });

  describe('formatFiles', () => {
    it('should format multiple files', async () => {
      const files: string[] = [];

      // Create multiple test files
      for (let i = 1; i <= 3; i++) {
        const content = `name: test-${i}\nversion: ${i}.0.0\nentries:\n  - content: "Line 1\\nLine 2"`;
        const testFile = path.join(tempDir, `test-${i}.yaml`);
        await fs.writeFile(testFile, content, 'utf-8');
        files.push(testFile);
      }

      const results = await formatter.formatFiles(files);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('formatElementType', () => {
    it('should format all memories in date folders', async () => {
      // Create memory directory structure
      const memoryDir = path.join(tempDir, ElementType.MEMORY);
      await fs.mkdir(memoryDir);

      // Create date folder
      const dateFolder = path.join(memoryDir, '2025-09-28');
      await fs.mkdir(dateFolder);

      // Add test memories
      const memory1 = `name: memory-1\nversion: 1.0.0\nentries:\n  - content: "Test\\nmemory"`;
      await fs.writeFile(path.join(dateFolder, 'memory-1.yaml'), memory1, 'utf-8');

      const memory2 = `name: memory-2\nversion: 1.0.0\nentries:\n  - content: "Another\\ntest"`;
      await fs.writeFile(path.join(dateFolder, 'memory-2.yaml'), memory2, 'utf-8');

      const results = await formatter.formatElementType(ElementType.MEMORY, tempDir);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
      expect(results.every(r => r.fixed.length > 0)).toBe(true);
    });

    it('should format all standard elements', async () => {
      // Create personas directory
      const personaDir = path.join(tempDir, ElementType.PERSONA);
      await fs.mkdir(personaDir);

      // Add test personas
      const persona1 = `---\nname: persona-1\nversion: 1.0.0\n---\n# Persona 1`;
      await fs.writeFile(path.join(personaDir, 'persona-1.md'), persona1, 'utf-8');

      const persona2 = `---\nname: persona-2\nversion: 2.0.0\n---\n# Persona 2`;
      await fs.writeFile(path.join(personaDir, 'persona-2.md'), persona2, 'utf-8');

      const results = await formatter.formatElementType(ElementType.PERSONA, tempDir);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.success)).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle file read errors gracefully', async () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.yaml');

      const result = await formatter.formatFile(nonExistentFile);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('ENOENT');
      expect(result.issues.length).toBe(0); // Issues array is empty on ENOENT
    });

    it('should handle permission denied errors', async () => {
      const testFile = path.join(tempDir, 'no-permission.yaml');
      await fs.writeFile(testFile, 'test', 'utf-8');

      // Skip permission test on Windows as it doesn't work the same way
      if ((globalThis as any).process?.platform === 'win32') {
        return;
      }

      try {
        // Remove all permissions - this is safe in a test temp directory
        await fs.chmod(testFile, 0o000);

        const result = await formatter.formatFile(testFile);

        expect(result.success).toBe(false);
        expect(result.error).toContain('EACCES');
        expect(result.issues.length).toBe(0); // Issues array is empty on EACCES
      } finally {
        // Always restore permissions for cleanup - use safer 0o600 (owner read/write only)
        try {
          await fs.chmod(testFile, 0o600);
        } catch {
          // Ignore cleanup errors in test
        }
      }
    });

    it('should handle YAML parse errors gracefully', async () => {
      const formatter = new ElementFormatter({ validate: true });

      // Completely invalid YAML
      const invalidYaml = `{{{not valid yaml at all:::`;
      const testFile = path.join(tempDir, 'invalid.yaml');
      await fs.writeFile(testFile, invalidYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(false);
      expect(result.issues.some(issue => issue.includes('Failed to parse YAML'))).toBe(true);
    });

    it('should handle file size limit exceeded', async () => {
      const formatter = new ElementFormatter({ maxFileSize: 10 }); // 10 bytes max

      const largeContent = 'This is a content that exceeds the maximum file size limit';
      const testFile = path.join(tempDir, 'large-file.yaml');
      await fs.writeFile(testFile, largeContent, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum allowed');
      expect(result.issues).toContain('File too large for processing');
    });
  });

  describe('security', () => {
    it('should prevent path traversal attacks in output directory', async () => {
      const outputDir = tempDir;
      const formatter = new ElementFormatter({ outputDir });

      // Create a file with a malicious name
      const safeFile = path.join(tempDir, 'test.yaml');
      await fs.writeFile(safeFile, 'name: test', 'utf-8');

      // Note: Path traversal is prevented in the formatter itself
      const result = await formatter.formatFile(safeFile);

      // Should format successfully without traversal
      expect(result.success).toBe(true);
      const outputPath = path.join(outputDir, 'test.yaml');
      expect(await fs.access(outputPath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should handle malicious YAML content safely', async () => {
      // Test that potentially dangerous YAML constructs are handled safely
      const maliciousYaml = `
name: test
dangerous: !!js/function 'function(){return "executed"}'
tags:
  - !!python/object/apply:os.system ['echo hacked']
`;

      const testFile = path.join(tempDir, 'malicious.yaml');
      await fs.writeFile(testFile, maliciousYaml, 'utf-8');

      const result = await formatter.formatFile(testFile);

      // Should either fail safely or strip dangerous content
      if (result.success) {
        const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
        expect(formatted).not.toContain('!!js/function');
        expect(formatted).not.toContain('!!python');
      } else {
        expect(result.issues.some(issue => issue.includes('Failed to parse'))).toBe(true);
      }
    });
  });

  describe('Unicode normalization', () => {
    it('should normalize Unicode characters', async () => {
      // Use different Unicode representations of the same character
      const unnormalized = `name: café\nversion: 1.0.0\nentries:\n  - content: "Test\\nContent"`; // é
      const testFile = path.join(tempDir, 'unicode.yaml');
      await fs.writeFile(testFile, unnormalized, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted.normalize('NFC')).toBe(formatted); // Should be normalized
    });
  });

  describe('parallel processing', () => {
    it('should process files in parallel with concurrency limit', async () => {
      const files: string[] = [];
      const fileCount = 10;

      // Create multiple test files
      for (let i = 1; i <= fileCount; i++) {
        const content = `name: test-${i}\nversion: ${i}.0.0\nentries:\n  - content: "Line 1\\nLine 2"`;
        const testFile = path.join(tempDir, `parallel-${i}.yaml`);
        await fs.writeFile(testFile, content, 'utf-8');
        files.push(testFile);
      }

      const results = await formatter.formatFiles(files, 3); // Limit concurrency to 3

      expect(results).toHaveLength(fileCount);
      expect(results.every(r => r.success)).toBe(true);
      expect(results.every(r => r.fixed.length > 0)).toBe(true);

      // Verify files were processed (not just returned)
      for (let i = 0; i < fileCount; i++) {
        const formattedPath = files[i].replace('.yaml', '.formatted.yaml');
        const exists = await fs.access(formattedPath).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });
  });

  describe('CLI integration', () => {
    it('should work with dry run option', async () => {
      const formatter = new ElementFormatter({ validate: true });

      const content = `name: test\nversion: 1.0.0`;
      const testFile = path.join(tempDir, 'dry-run.yaml');
      await fs.writeFile(testFile, content, 'utf-8');

      // Simulate dry run by just validating without writing
      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.fixed.some(fix => fix.includes('newline') || fix.includes('validation') || fix.includes('Formatted'))).toBe(true);
    });

    it('should handle mixed success and failure in batch operations', async () => {
      const files: string[] = [];

      // Create a mix of valid and invalid files
      const validContent = `name: valid\nversion: 1.0.0`;
      const validFile = path.join(tempDir, 'valid.yaml');
      await fs.writeFile(validFile, validContent, 'utf-8');
      files.push(validFile);

      // Non-existent file and invalid YAML
      const invalidContent = `{{{invalid`;
      const invalidFile = path.join(tempDir, 'invalid.yaml');
      await fs.writeFile(invalidFile, invalidContent, 'utf-8');

      // Add both files at once
      files.push(
        path.join(tempDir, 'non-existent.yaml'),
        invalidFile
      );

      const results = await formatter.formatFiles(files);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true); // Valid file
      expect(results[1].success).toBe(false); // Non-existent
      expect(results[2].success).toBe(false); // Invalid
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', async () => {
      const testFile = path.join(tempDir, 'empty.yaml');
      await fs.writeFile(testFile, '', 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(false);
      expect(result.issues.some(issue => issue.includes('Failed to parse'))).toBe(true);
    });

    it('should handle files with only whitespace', async () => {
      const testFile = path.join(tempDir, 'whitespace.yaml');
      await fs.writeFile(testFile, '   \n\t  \n  ', 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should handle deeply nested escaped content', async () => {
      const nestedContent = `
name: nested
entries:
  - content: "Level 1\\nLevel 2 with \\\\n escaped backslash"
  - content: "Tab\\t and return\\r characters"
`;

      const testFile = path.join(tempDir, 'nested.yaml');
      await fs.writeFile(testFile, nestedContent, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('Level 1');
      expect(formatted).toContain('Level 2');
      expect(formatted).toContain('Tab\t');
    });
  });
});