/**
 * Edge case tests for metadata-based test detection
 * Tests unusual file formats, boundary conditions, and error scenarios
 */

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DefaultElementProvider } from '../../../../src/portfolio/DefaultElementProvider.js';

describe('Metadata Detection - Edge Cases', () => {
  let tempDir: string;
  let provider: DefaultElementProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-edge-test-'));
    provider = new DefaultElementProvider({ loadTestData: true });
  });

  afterEach(async () => {
    // More robust cleanup with retry logic for macOS CI
    let retries = 3;
    while (retries > 0) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        break;
      } catch (error: any) {
        retries--;
        if (retries === 0 || !error.message?.includes('ENOTEMPTY')) {
          // On final retry or non-ENOTEMPTY errors, use platform-specific cleanup
          if (process.platform === 'darwin') {
            // macOS: Try using rmdir with force
            try {
              const { execSync } = require('child_process');
              execSync(`rm -rf "${tempDir}"`, { stdio: 'ignore' });
            } catch {
              // Ignore cleanup errors in CI - temp dirs will be cleaned by the system
              if (process.env.CI) {
                console.warn(`Warning: Could not clean temp dir ${tempDir}, will be cleaned by system`);
              } else {
                throw error;
              }
            }
          } else {
            throw error;
          }
        }
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    // CRITICAL MEMORY LEAK FIX: Clean up static caches to prevent memory accumulation
    DefaultElementProvider.cleanup();
  });

  describe('Unusual File Formats and Content', () => {
    it('should handle files with multiple frontmatter blocks', async () => {
      const testFile = path.join(tempDir, 'multiple-frontmatter.md');
      const content = `---
name: First Block
_dollhouseMCPTest: true
---
# Content between blocks
---
name: Second Block
_dollhouseMCPTest: false
---
# Final content`;

      await fs.writeFile(testFile, content);

      // Should only read the first frontmatter block
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata?.name).toBe('First Block');
      expect(metadata?._dollhouseMCPTest).toBe(true);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(true);
    });

    it('should handle frontmatter with different marker styles', async () => {
      const testCases = [
        {
          name: 'standard-markers.md',
          content: `---
name: Standard
_dollhouseMCPTest: true
---
# Standard markers`
        },
        {
          name: 'extra-dashes.md',
          content: `-----
name: Extra Dashes
_dollhouseMCPTest: true
-----
# Extra dashes (should not work)`
        },
        {
          name: 'spaces-before.md',
          content: `   ---
name: Spaces Before
_dollhouseMCPTest: true
   ---
# Spaces before markers (should not work)`
        },
        {
          name: 'mixed-markers.md',
          content: `---
name: Mixed
_dollhouseMCPTest: true
...
# Mixed markers (should not work)`
        }
      ];

      for (const testCase of testCases) {
        const filePath = path.join(tempDir, testCase.name);
        await fs.writeFile(filePath, testCase.content);

        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);

        if (testCase.name === 'standard-markers.md') {
          // Only standard format should work
          expect(metadata?.name).toBe('Standard');
          expect(isTest).toBe(true);
        } else {
          // Non-standard formats should return null/false
          expect(metadata).toBeNull();
          expect(isTest).toBe(false);
        }
      }
    });

    it('should handle frontmatter with complex YAML structures', async () => {
      const testFile = path.join(tempDir, 'complex-yaml.md');
      const content = `---
name: Complex YAML
_dollhouseMCPTest: true
_testMetadata:
  suite: complex-test
  purpose: Testing complex YAML structures
  array_field:
    - item1
    - item2
    - nested:
        subitem: value
  object_field:
    key1: value1
    key2: value2
    nested_object:
      deep_key: deep_value
  multiline_string: |
    This is a multiline
    string that spans
    several lines
  folded_string: >
    This is a folded
    string that should
    become one line
tags:
  - tag1
  - tag2
  - tag3
version: 1.0.0
---
# Complex YAML content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Complex YAML');
      expect(metadata?._dollhouseMCPTest).toBe(true);
      expect(isTest).toBe(true);
      
      // Verify complex structures are preserved
      expect(metadata?._testMetadata?.suite).toBe('complex-test');
      expect(Array.isArray(metadata?._testMetadata?.array_field)).toBe(true);
      expect(metadata?._testMetadata?.array_field).toHaveLength(3);
      expect(metadata?._testMetadata?.object_field?.key1).toBe('value1');
      expect(metadata?.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should handle files with only frontmatter and no content', async () => {
      const testFile = path.join(tempDir, 'only-frontmatter.md');
      const content = `---
name: Only Frontmatter
_dollhouseMCPTest: true
description: This file has no content after frontmatter
---`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Only Frontmatter');
      expect(isTest).toBe(true);
    });

    it('should handle empty files and whitespace-only files', async () => {
      const testCases = [
        { name: 'empty.md', content: '' },
        { name: 'only-spaces.md', content: '   ' },
        { name: 'only-newlines.md', content: '\n\n\n' },
        { name: 'mixed-whitespace.md', content: ' \t\n \r\n ' }
      ];

      for (const testCase of testCases) {
        const filePath = path.join(tempDir, testCase.name);
        await fs.writeFile(filePath, testCase.content);

        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);

        expect(metadata).toBeNull();
        expect(isTest).toBe(false);
      }
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle frontmatter at exact buffer sizes', async () => {
      const bufferSizes = [1024, 2048, 4095, 4096, 4097];
      
      for (const size of bufferSizes) {
        const testFile = path.join(tempDir, `buffer-${size}.md`);
        
        const baseContent = `---
name: Buffer Test ${size}
_dollhouseMCPTest: true
description: "`;
        
        const closingContent = `"
version: 1.0.0
---
# Content after frontmatter`;

        // Calculate padding to reach exact size
        const currentSize = Buffer.byteLength(baseContent + closingContent);
        const padding = Math.max(0, size - currentSize - 1); // -1 for safety
        const paddingStr = 'x'.repeat(padding);
        
        const content = baseContent + paddingStr + closingContent;
        await fs.writeFile(testFile, content);

        const metadata = await (provider as any).readMetadataOnly(testFile);
        const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

        if (size <= 4096) {
          // Should work for sizes within buffer limit
          expect(metadata?.name).toBe(`Buffer Test ${size}`);
          expect(isTest).toBe(true);
        } else {
          // May not work for sizes exceeding buffer limit
          // (depends on exact position of closing ---)
          expect(typeof isTest).toBe('boolean');
        }
      }
    });

    it('should handle very long lines in frontmatter', async () => {
      const testFile = path.join(tempDir, 'long-lines.md');
      
      const longLine = 'x'.repeat(1000);
      const content = `---
name: Long Lines Test
very_long_field: "${longLine}"
_dollhouseMCPTest: true
another_long_field: "${longLine}"
---
# Content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Long Lines Test');
      expect(metadata?.very_long_field).toBe(longLine);
      expect(isTest).toBe(true);
    });

    it('should handle frontmatter with many fields', async () => {
      const testFile = path.join(tempDir, 'many-fields.md');
      
      let frontmatter = '---\nname: Many Fields Test\n_dollhouseMCPTest: true\n';
      
      // Add 100 fields
      for (let i = 0; i < 100; i++) {
        frontmatter += `field${i}: value${i}\n`;
      }
      
      frontmatter += '---\n# Content';
      
      await fs.writeFile(testFile, frontmatter);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      if (metadata) {
        expect(metadata.name).toBe('Many Fields Test');
        expect(metadata._dollhouseMCPTest).toBe(true);
        expect(metadata.field0).toBe('value0');
        expect(metadata.field99).toBe('value99');
      }
      expect(typeof isTest).toBe('boolean');
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should handle corrupted file during read operation', async () => {
      const testFile = path.join(tempDir, 'corrupted.md');
      
      // Create a file with mixed content types
      const binaryData = Buffer.from([
        ...Buffer.from('---\nname: Corrupted\n_dollhouseMCPTest: true\n'),
        0x00, 0x01, 0xFF, 0xFE, // Binary data in middle of YAML
        ...Buffer.from('\n---\n# Content')
      ]);

      await fs.writeFile(testFile, binaryData);

      // Should handle corruption gracefully
      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // Should either work or fail gracefully
      expect(typeof isTest).toBe('boolean');
      
      if (metadata) {
        expect(typeof metadata.name).toBe('string');
      }
    });

    it('should handle file that changes during read', async () => {
      const testFile = path.join(tempDir, 'changing.md');
      
      const initialContent = `---
name: Changing File
_dollhouseMCPTest: true
---
# Initial content`;

      await fs.writeFile(testFile, initialContent);

      // Start reading metadata
      const metadataPromise = (provider as any).readMetadataOnly(testFile);
      
      // Quickly modify the file (simulating concurrent modification)
      setTimeout(async () => {
        try {
          const newContent = `---
name: Changed File
_dollhouseMCPTest: false
---
# Changed content`;
          await fs.writeFile(testFile, newContent);
        } catch {
          // Ignore write errors during concurrent access
        }
      }, 1);

      // Should complete without errors
      const metadata = await metadataPromise;
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // Results may vary depending on timing, but should not crash
      expect(typeof isTest).toBe('boolean');
      
      if (metadata) {
        expect(typeof metadata.name).toBe('string');
      }
    });

    it('should handle file deletion during processing', async () => {
      const testFile = path.join(tempDir, 'temporary.md');
      
      const content = `---
name: Temporary File
_dollhouseMCPTest: true
---
# Temporary content`;

      await fs.writeFile(testFile, content);

      // Start processing
      const metadataPromise = (provider as any).readMetadataOnly(testFile);
      
      // Delete file quickly
      setTimeout(async () => {
        try {
          await fs.unlink(testFile);
        } catch {
          // Ignore deletion errors
        }
      }, 1);

      // Should handle deletion gracefully
      const metadata = await metadataPromise;
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // File descriptor should be handled properly
      expect(typeof isTest).toBe('boolean');
      // May return data if file was read before deletion, or null if after
    });

    it('should handle filesystem errors gracefully', async () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.md');
      const invalidPath = path.join(tempDir, 'invalid\x00path.md');

      // Test non-existent file
      const metadata1 = await (provider as any).readMetadataOnly(nonExistentFile);
      const isTest1 = await (provider as any).isDollhouseMCPTestElement(nonExistentFile);

      expect(metadata1).toBeNull();
      expect(isTest1).toBe(false);

      // Test invalid path (null bytes)
      try {
        const metadata2 = await (provider as any).readMetadataOnly(invalidPath);
        const isTest2 = await (provider as any).isDollhouseMCPTestElement(invalidPath);

        expect(metadata2).toBeNull();
        expect(isTest2).toBe(false);
      } catch (error) {
        // Some systems may throw errors for invalid paths
        expect(error).toBeDefined();
      }
    });
  });

  describe('Unicode and Encoding Edge Cases', () => {
    it('should handle various Unicode edge cases', async () => {
      const unicodeTests = [
        {
          name: 'emoji-heavy.md',
          content: `---
name: "🚀 Emoji Test 🎯"
description: "Testing with 🔥 emojis 💯 everywhere 🌟"
_dollhouseMCPTest: true
tags: ["🏷️", "🎨", "🚧"]
---
# 🚀 Unicode Content 🌈`
        },
        {
          name: 'combining-chars.md',
          content: `---
name: "Combining Characters: é̂ñ̃ĩ̧ó̄"
description: "Testing Unicode combining characters"
_dollhouseMCPTest: true
---
# Combining characters test`
        },
        {
          name: 'rtl-text.md',
          content: `---
name: "RTL Test العربية עברית"
description: "Right-to-left text testing"
_dollhouseMCPTest: true
---
# RTL content test`
        },
        {
          name: 'cjk-text.md',
          content: `---
name: "CJK Test 中文 日本語 한국어"
description: "Chinese, Japanese, Korean text"
_dollhouseMCPTest: true
---
# CJK content test`
        },
        {
          name: 'zero-width.md',
          content: `---
name: "Zero\u200BWidth\u200CChars\u200D"
description: "Testing zero-width characters"
_dollhouseMCPTest: true
---
# Zero-width test`
        }
      ];

      for (const test of unicodeTests) {
        const filePath = path.join(tempDir, test.name);
        await fs.writeFile(filePath, test.content, 'utf8');

        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);

        if (test.name === 'zero-width.md') {
          // Zero-width characters are blocked by security validator - this is expected behavior
          expect(metadata).toBeNull();
          expect(isTest).toBe(false);
        } else {
          expect(metadata).toBeTruthy();
          expect(typeof metadata?.name).toBe('string');
          expect(metadata?._dollhouseMCPTest).toBe(true);
          expect(isTest).toBe(true);
        }
      }
    });

    it('should handle malformed UTF-8 sequences', async () => {
      const testFile = path.join(tempDir, 'malformed-utf8.md');
      
      // Create buffer with malformed UTF-8
      const malformedData = Buffer.from([
        ...Buffer.from('---\nname: Malformed UTF8\n_dollhouseMCPTest: true\ndescription: "'),
        0x80, 0x81, 0x82, // Invalid UTF-8 sequences
        ...Buffer.from('"\n---\n# Content')
      ]);

      await fs.writeFile(testFile, malformedData);

      // Should handle malformed UTF-8 gracefully
      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // May work with replacement characters or fail gracefully
      expect(typeof isTest).toBe('boolean');
      
      if (metadata) {
        expect(metadata.name).toBe('Malformed UTF8');
        expect(metadata._dollhouseMCPTest).toBe(true);
      }
    });

    it('should handle normalization differences', async () => {
      // Same character represented in different Unicode normalization forms
      const char1 = 'é'; // Precomposed
      const char2 = 'e\u0301'; // Decomposed (e + combining acute)
      
      const testFile1 = path.join(tempDir, 'nfc.md');
      const testFile2 = path.join(tempDir, 'nfd.md');
      
      const content1 = `---
name: "Test ${char1}"
_dollhouseMCPTest: true
---
# NFC test`;

      const content2 = `---
name: "Test ${char2}"
_dollhouseMCPTest: true
---
# NFD test`;

      await fs.writeFile(testFile1, content1);
      await fs.writeFile(testFile2, content2);

      const metadata1 = await (provider as any).readMetadataOnly(testFile1);
      const metadata2 = await (provider as any).readMetadataOnly(testFile2);
      
      const isTest1 = await (provider as any).isDollhouseMCPTestElement(testFile1);
      const isTest2 = await (provider as any).isDollhouseMCPTestElement(testFile2);

      expect(metadata1?.name).toContain('é');
      // Fix: normalize Unicode for comparison since char2 is decomposed form (e + combining acute)
      expect(metadata2?.name?.normalize('NFC')).toContain('é');
      expect(isTest1).toBe(true);
      expect(isTest2).toBe(true);
    });
  });

  describe('Performance Edge Cases', () => {
    it('should handle many files with different error conditions', async () => {
      const errorTypes = [
        { name: 'valid.md', content: '---\nname: Valid\n_dollhouseMCPTest: true\n---\n# Valid' },
        { name: 'no-frontmatter.md', content: '# No frontmatter' },
        { name: 'malformed.md', content: '---\nname: Bad\ninvalid: {yaml\n---\n# Bad' },
        { name: 'empty.md', content: '' },
        { name: 'binary.md', content: '\x00\x01\x02\x03' },
        { name: 'long.md', content: '---\ndesc: "' + 'x'.repeat(5000) + '"\n---\n# Long' }
      ];

      const fileCount = 50;
      const files = [];

      // Create many files with various error conditions
      for (let i = 0; i < fileCount; i++) {
        const errorType = errorTypes[i % errorTypes.length];
        const fileName = `error-${i}-${errorType.name}`;
        const filePath = path.join(tempDir, fileName);
        
        await fs.writeFile(filePath, errorType.content);
        files.push(filePath);
      }

      // Process all files and measure performance
      const startTime = Date.now();
      const results = [];

      for (const filePath of files) {
        try {
          const metadata = await (provider as any).readMetadataOnly(filePath);
          const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);
          results.push({ file: path.basename(filePath), metadata, isTest, error: null });
        } catch (error) {
          results.push({ file: path.basename(filePath), metadata: null, isTest: false, error: String(error) });
        }
      }

      const endTime = Date.now();
      const totalTime = endTime - startTime;
      const avgTime = totalTime / fileCount;

      console.log(`Processed ${fileCount} mixed files in ${totalTime}ms (avg: ${avgTime.toFixed(2)}ms/file)`);

      // Should handle all files without throwing unhandled errors
      expect(results).toHaveLength(fileCount);
      expect(avgTime).toBeLessThan(100); // Should be reasonable even with errors

      // Count valid detections
      const validTests = results.filter(r => r.isTest === true).length;
      const expectedValid = Math.ceil(fileCount / errorTypes.length); // Only 'valid.md' pattern
      expect(validTests).toBe(expectedValid);
    }, 30000);

    it('should maintain performance under memory pressure', async () => {
      const testFile = path.join(tempDir, 'memory-pressure.md');
      const content = `---
name: Memory Pressure Test
_dollhouseMCPTest: true
---
# Content`;

      await fs.writeFile(testFile, content);

      // Create memory pressure with large arrays
      const largeArrays: number[][] = [];
      for (let i = 0; i < 10; i++) {
        largeArrays.push(new Array(100000).fill(i));
      }

      // Force garbage collection if available
      if (global.gc) global.gc();

      const startMemory = process.memoryUsage().heapUsed;
      const startTime = Date.now();

      // Process file multiple times under memory pressure
      const iterations = 100;
      for (let i = 0; i < iterations; i++) {
        const metadata = await (provider as any).readMetadataOnly(testFile);
        const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
        
        expect(metadata?.name).toBe('Memory Pressure Test');
        expect(isTest).toBe(true);
      }

      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      const totalTime = endTime - startTime;
      const avgTime = totalTime / iterations;
      const memoryGrowth = endMemory - startMemory;

      console.log(`Memory pressure test: ${avgTime.toFixed(2)}ms/op, memory growth: ${(memoryGrowth/1024/1024).toFixed(2)}MB`);

      // Should maintain performance even under memory pressure
      expect(avgTime).toBeLessThan(50);
      
      // Memory growth should be reasonable (increased limit for test environment)
      expect(memoryGrowth).toBeLessThan(20 * 1024 * 1024); // 20MB limit

      // Clean up memory pressure
      largeArrays.length = 0;
      if (global.gc) global.gc();
    }, 30000);
  });

  describe('Integration with File System Edge Cases', () => {
    it('should handle files in deeply nested Unicode directories', async () => {
      const unicodeDir = path.join(tempDir, '测试', 'العربية', 'עברית', '🚀');
      await fs.mkdir(unicodeDir, { recursive: true });

      const testFile = path.join(unicodeDir, 'unicode-nested.md');
      const content = `---
name: Unicode Nested Test
_dollhouseMCPTest: true
---
# Unicode nested content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Unicode Nested Test');
      expect(isTest).toBe(true);
    });

    it('should handle files with very long paths', async () => {
      // Create a very long path (but within system limits)
      const longDirName = 'very-long-directory-name-that-tests-path-length-limits';
      let currentDir = tempDir;
      
      // Create nested directories to approach path length limits
      for (let i = 0; i < 5; i++) {
        currentDir = path.join(currentDir, `${longDirName}-${i}`);
        await fs.mkdir(currentDir, { recursive: true });
      }

      const testFile = path.join(currentDir, 'long-path-test.md');
      const content = `---
name: Long Path Test
_dollhouseMCPTest: true
---
# Long path content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Long Path Test');
      expect(isTest).toBe(true);
    });

    it('should handle case sensitivity variations', async () => {
      const variations = [
        { name: 'UPPERCASE.MD', content: '---\nname: UPPER\n_dollhouseMCPTest: true\n---\n# UPPER' },
        { name: 'lowercase.md', content: '---\nname: lower\n_dollhouseMCPTest: true\n---\n# lower' },
        { name: 'MixedCase.Md', content: '---\nname: Mixed\n_dollhouseMCPTest: true\n---\n# Mixed' }
      ];

      for (const variation of variations) {
        const filePath = path.join(tempDir, variation.name);
        await fs.writeFile(filePath, variation.content);

        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);

        expect(metadata?.name).toBeDefined();
        expect(isTest).toBe(true);
      }
    });
  });
});