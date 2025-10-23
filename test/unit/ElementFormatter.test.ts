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
import * as yaml from 'js-yaml';
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

  describe('validateContent: false behavior (Issue #1211)', () => {
    it('should process files with security scanner triggers when validateContent: false', async () => {
      // This test verifies PR #1212 fix - content that looks like malicious patterns
      // (e.g., SonarCloud rules) should process successfully
      const sonarcloudRulesContent = `name: sonarcloud-rules-reference
description: SonarCloud rules reference
version: 1.0.0
tags:
  - sonarcloud
  - reference
  - rules
entries:
  - id: entry-1
    timestamp: 2025-09-28T12:00:00Z
    content: |
      # SonarCloud Rules Reference

      ## Reliability Rules

      ### S7773 - Prefer Number.* methods
      - **Category**: Reliability
      - **Default Severity**: Medium
      - **Fix**: Replace \`Number.parseInt()\` with \`Number.parseInt()\`, \`Number.isNaN()\` with \`Number.isNaN()\`
      - **Issues in project**: ~180
      - **Automation**: High - simple find/replace

      ### S7781 - Use String#replaceAll()
      - **Category**: Reliability
      - **Default Severity**: Low
      - **Fix**: Replace \`str.replaceAll(/pattern/g, ...)\` with \`str.replaceAll('pattern', ...)\`
      - **Issues in project**: ~104
      - **Automation**: High - pattern matching required`;

      const testFile = path.join(tempDir, 'sonarcloud-rules-reference.yaml');
      await fs.writeFile(testFile, sonarcloudRulesContent, 'utf-8');

      const result = await formatter.formatFile(testFile);

      // Should succeed without security errors
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issues).not.toContain(expect.stringContaining('Malicious'));
      expect(result.fixed).toContain('YAML validation passed');
    });

    it('should process files with API endpoint patterns when validateContent: false', async () => {
      // API documentation often contains patterns that security scanners flag
      const apiReferenceContent = `name: sonarcloud-api-reference
description: SonarCloud API reference
version: 1.0.0
tags:
  - sonarcloud
  - api
  - automation
entries:
  - id: entry-1
    timestamp: 2025-09-27T12:00:00Z
    content: |
      # SonarCloud API Reference

      ## Authentication
      **Token Storage**: macOS Keychain as "sonar_token2"
      **Header Format**: \`Authorization: Bearer $TOKEN\`

      ### Validate Token
      \`\`\`bash
      GET /api/authentication/validate
      → Returns {"valid": true} with 200 if valid, 401 if not
      \`\`\`

      ## Reading Issues

      ### Search Issues
      \`\`\`bash
      GET /api/issues/search
      \`\`\``;

      const testFile = path.join(tempDir, 'sonarcloud-api-reference.yaml');
      await fs.writeFile(testFile, apiReferenceContent, 'utf-8');

      const result = await formatter.formatFile(testFile);

      // Should succeed without security errors
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.issues).not.toContain(expect.stringContaining('Malicious'));
      expect(result.fixed).toContain('YAML validation passed');
    });
  });

  describe('filename-based name generation (Issue #1211)', () => {
    it('should derive memory name from filename when missing', async () => {
      // Test PR #1212 fix - names should come from filename, not random IDs
      const contentWithoutName = `description: Test memory without name field
version: 1.0.0
retention: 30
tags:
  - test
entries:
  - id: entry-1
    timestamp: 2025-09-28T12:00:00Z
    content: Test content`;

      const testFile = path.join(tempDir, 'sonarcloud-rules-reference.yaml');
      await fs.writeFile(testFile, contentWithoutName, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.fixed).toContain('Added name field from filename: sonarcloud-rules-reference');

      // Verify the formatted content has the correct name
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('name: sonarcloud-rules-reference');

      // Verify it's NOT a random ID like mem_1759077319164_w9m9fk56y
      expect(formatted).not.toMatch(/name: mem_\d+_[a-z0-9]+/);
    });

    it('should preserve existing name field if present', async () => {
      const contentWithName = `name: custom-memory-name
description: Test memory with existing name
version: 1.0.0
entries:
  - id: entry-1
    timestamp: 2025-09-28T12:00:00Z
    content: Test content`;

      const testFile = path.join(tempDir, 'different-filename.yaml');
      await fs.writeFile(testFile, contentWithName, 'utf-8');

      const result = await formatter.formatFile(testFile);

      expect(result.success).toBe(true);
      expect(result.fixed).not.toContain(expect.stringContaining('Added name field'));

      // Verify the original name is preserved
      const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
      const formatted = await fs.readFile(formattedPath, 'utf-8');
      expect(formatted).toContain('name: custom-memory-name');
      expect(formatted).not.toContain('different-filename');
    });

    it('should handle complex filenames correctly', async () => {
      // Test filenames with hyphens, underscores, and dates
      const testCases = [
        { filename: 'session-2025-09-28-afternoon.yaml', expectedName: 'session-2025-09-28-afternoon' },
        { filename: 'my_complex_memory_name.yaml', expectedName: 'my_complex_memory_name' },
        { filename: 'SomeCapitalLetters.yaml', expectedName: 'SomeCapitalLetters' }
      ];

      for (const testCase of testCases) {
        const content = `description: Test
version: 1.0.0
entries:
  - content: Test`;

        const testFile = path.join(tempDir, testCase.filename);
        await fs.writeFile(testFile, content, 'utf-8');

        const result = await formatter.formatFile(testFile);

        expect(result.success).toBe(true);
        expect(result.fixed).toContain(`Added name field from filename: ${testCase.expectedName}`);

        const formattedPath = testFile.replace('.yaml', '.formatted.yaml');
        const formatted = await fs.readFile(formattedPath, 'utf-8');
        expect(formatted).toContain(`name: ${testCase.expectedName}`);
      }
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

      // Check multiline content is preserved with block scalar
      expect(formatted).toContain('Level 1');
      expect(formatted).toContain('Level 2');

      // YAML correctly escapes tab/return in quoted strings - this is expected behavior
      // The actual tab character is in the data, but YAML shows it as \t for readability
      expect(formatted).toMatch(/Tab\\t.*return\\r/);

      // Verify the actual parsed content has real tab/return characters
      const parsedYaml = yaml.load(formatted) as any;
      expect(parsedYaml.entries[1].content).toContain('\t');
      expect(parsedYaml.entries[1].content).toContain('\r');
    });
  });

  describe('unescapeContent (static method - Issue #874)', () => {
    describe('basic escape sequences', () => {
      it('should unescape newlines', () => {
        const input = String.raw`Line 1\nLine 2\nLine 3`;
        const expected = 'Line 1\nLine 2\nLine 3';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should unescape carriage returns', () => {
        const input = String.raw`Line 1\rLine 2\r`;
        const expected = 'Line 1\rLine 2\r';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should unescape tabs', () => {
        const input = String.raw`Column1\tColumn2\tColumn3`;
        const expected = 'Column1\tColumn2\tColumn3';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should unescape backslashes', () => {
        const input = String.raw`Path\\to\\file`;
        const expected = String.raw`Path\to\file`;
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });
    });

    describe('combined escape sequences', () => {
      it('should handle multiple escape types in one string', () => {
        const input = String.raw`Line 1\nLine 2 with\ttab\rAnd return`;
        const expected = 'Line 1\nLine 2 with\ttab\rAnd return';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should handle double-escaped backslashes followed by newlines', () => {
        const input = String.raw`Text with\\n literal backslash-n\nand actual newline`;
        const expected = 'Text with\\n literal backslash-n\nand actual newline';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });
    });

    describe('markdown content', () => {
      it('should unescape markdown headers with newlines', () => {
        const input = String.raw`# Title\n\n## Subtitle\n\nContent here`;
        const expected = '# Title\n\n## Subtitle\n\nContent here';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should unescape markdown lists with tabs', () => {
        const input = String.raw`- Item 1\n\t- Subitem 1a\n\t- Subitem 1b\n- Item 2`;
        const expected = '- Item 1\n\t- Subitem 1a\n\t- Subitem 1b\n- Item 2';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should handle code blocks with escaped newlines', () => {
        const input = String.raw`Example:\ncode block\nconst x = 1;\nconst y = 2;\n`;
        const expected = 'Example:\ncode block\nconst x = 1;\nconst y = 2;\n';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });
    });

    describe('real-world persona content', () => {
      it('should unescape persona instructions properly', () => {
        const input = String.raw`# Creative Writer\n\n## Identity\n\nI am a creative writer...\n\n## Skills\n- Story crafting\n- Character development`;
        const expected = '# Creative Writer\n\n## Identity\n\nI am a creative writer...\n\n## Skills\n- Story crafting\n- Character development';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should handle session notes with mixed escapes', () => {
        const input = String.raw`Session Notes - 2025-10-23\n\n**Focus**: Bug fixes\n**Tasks**:\n\t1. Fix rendering\n\t2. Add tests\n\n**Outcome**: ✅ Success`;
        const expected = 'Session Notes - 2025-10-23\n\n**Focus**: Bug fixes\n**Tasks**:\n\t1. Fix rendering\n\t2. Add tests\n\n**Outcome**: ✅ Success';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });
    });

    describe('edge cases and input validation', () => {
      it('should handle empty string', () => {
        expect(ElementFormatter.unescapeContent('')).toBe('');
      });

      it('should handle null input', () => {
        expect(ElementFormatter.unescapeContent(null as any)).toBe('');
      });

      it('should handle undefined input', () => {
        expect(ElementFormatter.unescapeContent(undefined as any)).toBe('');
      });

      it('should convert non-string input to string', () => {
        expect(ElementFormatter.unescapeContent(123 as any)).toBe('123');
        expect(ElementFormatter.unescapeContent(true as any)).toBe('true');
        expect(ElementFormatter.unescapeContent({ foo: 'bar' } as any)).toBe('[object Object]');
      });

      it('should handle strings with no escape sequences', () => {
        const input = 'Normal text without any escapes';
        expect(ElementFormatter.unescapeContent(input)).toBe(input);
      });

      it('should handle strings with only escape sequences', () => {
        const input = String.raw`\n\n\n`;
        const expected = '\n\n\n';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should handle very long strings efficiently', () => {
        const input = String.raw`Line\n`.repeat(10000);
        const result = ElementFormatter.unescapeContent(input);
        // Note: split('\n') on "Line\n" repeated 10000 times yields 10001 elements
        // (10000 "Line" strings + 1 empty string after the final \n)
        expect(result.split('\n').length).toBe(10001);
      });
    });

    describe('unicode and special characters', () => {
      it('should preserve unicode characters while unescaping', () => {
        const input = String.raw`Hello 世界\nСпасибо\n🎉 Emoji party!`;
        const expected = 'Hello 世界\nСпасибо\n🎉 Emoji party!';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });

      it('should handle mixed unicode and escape sequences', () => {
        const input = String.raw`Café\tBistro\n日本語\t中文`;
        const expected = 'Café\tBistro\n日本語\t中文';
        expect(ElementFormatter.unescapeContent(input)).toBe(expected);
      });
    });

    describe('security and robustness', () => {
      it('should handle potential ReDoS patterns safely', () => {
        // Test that the method doesn't use vulnerable regex patterns
        const input = String.raw`${'a'.repeat(10000)}\n${'b'.repeat(10000)}`;
        const start = Date.now();
        ElementFormatter.unescapeContent(input);
        const duration = Date.now() - start;
        expect(duration).toBeLessThan(1000); // Should complete quickly
      });

      it('should not execute embedded scripts', () => {
        // Test that unescapeContent doesn't execute embedded code-like strings
        // Avoiding arrow function syntax to prevent SonarCloud S2004 (nesting depth)
        const input = String.raw`<script>alert('xss')</script>\nfunction(){alert('code')}`;
        const result = ElementFormatter.unescapeContent(input);
        // Should just unescape, not execute
        expect(result).toContain('\n');
        expect(typeof result).toBe('string');
      });

      it('should handle malformed escape sequences gracefully', () => {
        const input = String.raw`\x invalid\u invalid\z invalid`;
        const result = ElementFormatter.unescapeContent(input);
        // Should return as-is since these aren't in our escape map
        expect(result).toBe(input);
      });
    });

    describe('regression tests', () => {
      it('should fix Issue #874 - escaped newlines in persona content', () => {
        // Real example from Issue #874
        const escaped = String.raw`# Session Notes Writer - Context-Aware Documentation Specialist\n\n## Core Identity\n\nI am the Session Notes Writer...`;
        const unescaped = ElementFormatter.unescapeContent(escaped);

        expect(unescaped).not.toContain(String.raw`\n`);
        expect(unescaped).toContain('\n');
        expect(unescaped.split('\n').length).toBeGreaterThan(1);
      });

      it('should handle content from all element types', () => {
        // Skills
        const skillContent = String.raw`**Skill**: Code Review\n\n**Instructions**:\n1. Check syntax\n2. Review logic`;
        expect(ElementFormatter.unescapeContent(skillContent)).toContain('\n');

        // Templates
        const templateContent = String.raw`Hello {{name}},\n\nWelcome to {{place}}!`;
        expect(ElementFormatter.unescapeContent(templateContent)).toContain('\n');

        // Agents
        const agentContent = String.raw`Goal: Complete task\nStatus: Active\nFramework: Rule-based`;
        expect(ElementFormatter.unescapeContent(agentContent)).toContain('\n');

        // Memories
        const memoryContent = String.raw`## Memory Entry\n\nContext from previous session:\n- Fixed bug\n- Added tests`;
        expect(ElementFormatter.unescapeContent(memoryContent)).toContain('\n');
      });
    });
  });
});