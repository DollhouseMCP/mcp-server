/**
 * Integration tests for metadata-based test detection
 * Tests the complete flow from file creation to detection in production environment
 */

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DefaultElementProvider } from '../../../src/portfolio/DefaultElementProvider.js';

// Simplified test versions of migration functions
function addTestMetadata(content: string, filePath: string): string {
  const testMetadataBlock = [
    '_dollhouseMCPTest: true',
    '_testMetadata:',
    '  suite: "integration-test"',
    '  purpose: "Integration testing"',
    '  created: "2025-08-20"',
    '  version: "1.0.0"',
    `  migrated: "${new Date().toISOString()}"`,
    `  originalPath: "${filePath}"`
  ].join('\n');

  const lines = content.split('\n');
  if (lines[0] === '---') {
    const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
    if (endIndex > 0) {
      lines.splice(endIndex, 0, testMetadataBlock);
      return lines.join('\n');
    }
  }
  
  return `---\n${testMetadataBlock}\n---\n\n${content}`;
}

function removeTestMetadata(content: string): string {
  const lines = content.split('\n');
  return lines.filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('_dollhouseMCPTest:') &&
           !trimmed.startsWith('_testMetadata:') &&
           !trimmed.match(/^\s+(suite|purpose|created|version|migrated|originalPath):/);
  }).join('\n');
}

describe('Metadata Test Detection - Integration Tests', () => {
  let tempDir: string;
  let provider: DefaultElementProvider;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-integration-test-'));
    provider = new DefaultElementProvider({
      loadTestData: true  // Enable test data loading for tests
    });
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    // CRITICAL MEMORY LEAK FIX: Clean up static caches to prevent memory accumulation
    DefaultElementProvider.cleanup();
  });

  describe('Complete Migration Workflow', () => {
    it('should migrate test files and properly detect them in production', async () => {
      // Create a sample test file structure
      const testDataDir = path.join(tempDir, 'test-data');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(testDataDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });

      // Create test files without metadata
      const testFiles = [
        {
          name: 'test-persona.md',
          content: `---
name: Test Persona
type: persona
version: 1.0.0
description: A test persona for validation
---
# Test Persona
This is a test persona for system validation.`
        },
        {
          name: 'sample-skill.md', 
          content: `---
name: Sample Skill
type: skill
version: 1.0.0
---
# Sample Skill
This is a sample skill for testing.`
        },
        {
          name: 'regular-element.md',
          content: `---
name: Regular Element
type: persona
version: 1.0.0
---
# Regular Element
This is a regular element that should not be blocked.`
        }
      ];

      // Write test files
      for (const file of testFiles) {
        await fs.writeFile(path.join(testDataDir, file.name), file.content);
      }

      // Step 1: Verify files are not initially detected as test files
      for (const file of testFiles.slice(0, 2)) { // First two are test files
        const filePath = path.join(testDataDir, file.name);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);
        expect(isTest).toBe(false);
      }

      // Step 2: Add metadata to test files using migration logic
      const testFile1Path = path.join(testDataDir, 'test-persona.md');
      const testFile2Path = path.join(testDataDir, 'sample-skill.md');
      
      let content1 = await fs.readFile(testFile1Path, 'utf-8');
      let content2 = await fs.readFile(testFile2Path, 'utf-8');
      
      content1 = addTestMetadata(content1, testFile1Path);
      content2 = addTestMetadata(content2, testFile2Path);
      
      await fs.writeFile(testFile1Path, content1);
      await fs.writeFile(testFile2Path, content2);

      // Step 3: Verify files are now detected as test files
      expect(await (provider as any).isDollhouseMCPTestElement(testFile1Path)).toBe(true);
      expect(await (provider as any).isDollhouseMCPTestElement(testFile2Path)).toBe(true);
      
      // Regular file should still not be a test file
      const regularPath = path.join(testDataDir, 'regular-element.md');
      expect(await (provider as any).isDollhouseMCPTestElement(regularPath)).toBe(false);

      // Step 4: Test production environment blocking
      process.env.NODE_ENV = 'production';
      const mockIsProduction = jest.fn().mockReturnValue(true);
      (provider as any).isProductionEnvironment = mockIsProduction;

      const copiedCount = await (provider as any).copyElementFiles(testDataDir, destDir, 'personas');

      // Should only copy the regular element (test elements blocked)
      expect(copiedCount).toBe(1);

      const destFiles = await fs.readdir(destDir);
      expect(destFiles).toContain('regular-element.md');
      expect(destFiles).not.toContain('test-persona.md');
      expect(destFiles).not.toContain('sample-skill.md');
    });

    it('should handle rollback of metadata migration', async () => {
      const testFile = path.join(tempDir, 'test-element.md');
      const originalContent = `---
name: Test Element
type: persona
---
# Content`;

      await fs.writeFile(testFile, originalContent);

      // Add metadata
      let content = await fs.readFile(testFile, 'utf-8');
      const migratedContent = addTestMetadata(content, testFile);
      await fs.writeFile(testFile, migratedContent);

      // Verify metadata was added
      expect(await (provider as any).isDollhouseMCPTestElement(testFile)).toBe(true);

      // Remove metadata (rollback)
      content = await fs.readFile(testFile, 'utf-8');
      const rolledBackContent = removeTestMetadata(content);
      await fs.writeFile(testFile, rolledBackContent);

      // Verify metadata was removed
      expect(await (provider as any).isDollhouseMCPTestElement(testFile)).toBe(false);

      // Content should be close to original (may have formatting differences)
      const finalContent = await fs.readFile(testFile, 'utf-8');
      expect(finalContent).toContain('name: Test Element');
      expect(finalContent).toContain('type: persona');
      expect(finalContent).toContain('# Content');
      expect(finalContent).not.toContain('_dollhouseMCPTest');
      expect(finalContent).not.toContain('_testMetadata');
    });
  });

  describe('Large Scale Testing', () => {
    it('should handle migration of many files efficiently', async () => {
      const largeTestDir = path.join(tempDir, 'large-test');
      await fs.mkdir(largeTestDir, { recursive: true });

      // Create 100 test files
      const fileCount = 100;
      const startTime = Date.now();

      for (let i = 0; i < fileCount; i++) {
        const content = `---
name: Test Element ${i}
type: persona
version: 1.0.0
---
# Test Element ${i}
This is test element number ${i}.`;
        
        await fs.writeFile(path.join(largeTestDir, `test-element-${i}.md`), content);
      }

      // Add metadata to all files
      const files = await fs.readdir(largeTestDir);
      for (const file of files) {
        const filePath = path.join(largeTestDir, file);
        let content = await fs.readFile(filePath, 'utf-8');
        content = addTestMetadata(content, filePath);
        await fs.writeFile(filePath, content);
      }

      // Test detection performance
      const detectionStartTime = Date.now();
      let detectedCount = 0;

      for (const file of files) {
        const filePath = path.join(largeTestDir, file);
        if (await (provider as any).isDollhouseMCPTestElement(filePath)) {
          detectedCount++;
        }
      }

      const detectionTime = Date.now() - detectionStartTime;
      const averageTimePerFile = detectionTime / fileCount;

      expect(detectedCount).toBe(fileCount);
      expect(averageTimePerFile).toBeLessThan(50); // 50ms per file requirement
      
      console.log(`Detection Performance: ${averageTimePerFile.toFixed(2)}ms per file (${fileCount} files)`);
    }, 30000); // 30 second timeout for this test
  });

  describe('Production Environment Detection', () => {
    it('should correctly identify production environments', async () => {
      const originalHome = process.env.HOME;
      const originalUserProfile = process.env.USERPROFILE;

      try {
        // Test development environment
        process.env.NODE_ENV = 'development';
        delete process.env.HOME;
        delete process.env.USERPROFILE;
        
        expect((provider as any).isProductionEnvironment()).toBe(false);

        // Test production environment with indicators
        process.env.NODE_ENV = 'production';
        process.env.HOME = '/Users/testuser';
        
        expect((provider as any).isProductionEnvironment()).toBe(true);

        // Test production environment with Windows user
        delete process.env.HOME;
        process.env.USERPROFILE = 'C:\\Users\\testuser';
        
        expect((provider as any).isProductionEnvironment()).toBe(true);
      } finally {
        // Restore environment
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
        else delete process.env.USERPROFILE;
      }
    });

    it('should provide consistent blocking across different element types', async () => {
      process.env.NODE_ENV = 'production';
      const mockIsProduction = jest.fn().mockReturnValue(true);
      (provider as any).isProductionEnvironment = mockIsProduction;

      const elementTypes = ['personas', 'skills', 'templates', 'agents'];
      
      for (const elementType of elementTypes) {
        const sourceDir = path.join(tempDir, `source-${elementType}`);
        const destDir = path.join(tempDir, `dest-${elementType}`);
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.mkdir(destDir, { recursive: true });

        // Create test and regular elements
        const testContent = `---
name: Test ${elementType.slice(0, -1)}
_dollhouseMCPTest: true
_testMetadata:
  suite: integration-test
  purpose: Testing ${elementType} blocking
---
# Test Content`;

        const regularContent = `---
name: Regular ${elementType.slice(0, -1)}
version: 1.0.0
---
# Regular Content`;

        await fs.writeFile(path.join(sourceDir, `test-${elementType}.md`), testContent);
        await fs.writeFile(path.join(sourceDir, `regular-${elementType}.md`), regularContent);

        // Test copying
        const copiedCount = await (provider as any).copyElementFiles(sourceDir, destDir, elementType);
        
        expect(copiedCount).toBe(1);
        
        const destFiles = await fs.readdir(destDir);
        expect(destFiles).toContain(`regular-${elementType}.md`);
        expect(destFiles).not.toContain(`test-${elementType}.md`);
      }
    });
  });

  describe('Error Recovery and Edge Cases', () => {
    it('should handle corrupted files gracefully during mass detection', async () => {
      const mixedDir = path.join(tempDir, 'mixed');
      await fs.mkdir(mixedDir, { recursive: true });

      // Create a mix of valid, invalid, and corrupted files
      const files = [
        {
          name: 'valid-test.md',
          content: `---
name: Valid Test
_dollhouseMCPTest: true
---
# Valid content`
        },
        {
          name: 'invalid-yaml.md',
          content: `---
name: Invalid
invalid: {broken yaml
---
# Content`
        },
        {
          name: 'no-frontmatter.md',
          content: '# Just content, no frontmatter'
        },
        {
          name: 'empty-file.md',
          content: ''
        },
        {
          name: 'binary-like.md',
          content: '\x00\x01\x02\x03\x04\x05'
        }
      ];

      for (const file of files) {
        await fs.writeFile(path.join(mixedDir, file.name), file.content);
      }

      // Should detect only the valid test file
      let detectedCount = 0;
      let errorCount = 0;

      for (const file of files) {
        try {
          const filePath = path.join(mixedDir, file.name);
          if (await (provider as any).isDollhouseMCPTestElement(filePath)) {
            detectedCount++;
          }
        } catch (error) {
          errorCount++;
        }
      }

      expect(detectedCount).toBe(1); // Only valid-test.md should be detected
      expect(errorCount).toBe(0); // Should handle all files gracefully
    });

    it('should handle concurrent metadata detection requests', async () => {
      const concurrentDir = path.join(tempDir, 'concurrent');
      await fs.mkdir(concurrentDir, { recursive: true });

      // Create multiple test files
      const fileCount = 20;
      const promises = [];

      for (let i = 0; i < fileCount; i++) {
        const content = `---
name: Concurrent Test ${i}
_dollhouseMCPTest: true
_testMetadata:
  suite: concurrent-test
  purpose: Testing concurrent detection
---
# Concurrent test ${i}`;
        
        const filePath = path.join(concurrentDir, `concurrent-${i}.md`);
        promises.push(fs.writeFile(filePath, content));
      }

      await Promise.all(promises);

      // Test concurrent detection
      const files = await fs.readdir(concurrentDir);
      const detectionPromises = files.map(file => {
        const filePath = path.join(concurrentDir, file);
        return (provider as any).isDollhouseMCPTestElement(filePath);
      });

      const results = await Promise.all(detectionPromises);
      
      // All should be detected as test files
      expect(results.every(result => result === true)).toBe(true);
      expect(results.length).toBe(fileCount);
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should handle different line ending styles', async () => {
      const lineEndingTests = [
        {
          name: 'unix-line-endings.md',
          content: "---\nname: Unix Test\n_dollhouseMCPTest: true\n---\n# Unix content\n",
          expected: true
        },
        {
          name: 'windows-line-endings.md', 
          content: "---\r\nname: Windows Test\r\n_dollhouseMCPTest: true\r\n---\r\n# Windows content\r\n",
          expected: true
        },
        {
          name: 'mixed-line-endings.md',
          content: "---\r\nname: Mixed Test\n_dollhouseMCPTest: true\r\n---\n# Mixed content\r\n",
          expected: true
        }
      ];

      for (const test of lineEndingTests) {
        const filePath = path.join(tempDir, test.name);
        await fs.writeFile(filePath, test.content);
        
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);
        expect(isTest).toBe(test.expected);
      }
    });

    it('should handle Unicode and special characters in metadata', async () => {
      const unicodeFile = path.join(tempDir, 'unicode-test.md');
      const content = `---
name: "Unicode Test 🚀"
description: "Test with émojis and spëcial chäracteṛs"
_dollhouseMCPTest: true
_testMetadata:
  suite: "unicode-test"
  purpose: "Testing Ünîcödé support 中文 العربية"
---
# Unicode Content 🎯
This contains various Unicode characters: αβγδε Ω ∑ ∞`;

      await fs.writeFile(unicodeFile, content, 'utf-8');
      
      const isTest = await (provider as any).isDollhouseMCPTestElement(unicodeFile);
      expect(isTest).toBe(true);
      
      const metadata = await (provider as any).readMetadataOnly(unicodeFile);
      expect(metadata.name).toBe('Unicode Test 🚀');
      expect(metadata.description).toContain('émojis');
      expect(metadata._testMetadata.purpose).toContain('Ünîcödé');
    });
  });
});