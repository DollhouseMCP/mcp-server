/**
 * Tests for metadata-based test detection in DefaultElementProvider
 */

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DefaultElementProvider } from '../../../../src/portfolio/DefaultElementProvider.js';

describe('DefaultElementProvider - Metadata-based Test Detection', () => {
  let tempDir: string;
  let provider: DefaultElementProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-metadata-test-'));
    provider = new DefaultElementProvider({
      loadTestData: true  // Enable test data loading for tests
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    // CRITICAL MEMORY LEAK FIX: Clean up static caches to prevent memory accumulation
    DefaultElementProvider.cleanup();
  });

  describe('readMetadataOnly', () => {
    it('should read metadata from file with frontmatter', async () => {
      const testFile = path.join(tempDir, 'test-with-metadata.md');
      const content = `---
name: Test Persona
_dollhouseMCPTest: true
version: 1.0.0
---
# Test Content
This is the content body.`;

      await fs.writeFile(testFile, content);

      // Use reflection to access private method for testing
      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toEqual({
        name: 'Test Persona',
        _dollhouseMCPTest: true,
        version: '1.0.0'
      });
    });

    it('should return null for file without frontmatter', async () => {
      const testFile = path.join(tempDir, 'no-metadata.md');
      const content = `# Regular Content
This file has no frontmatter.`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toBeNull();
    });

    it('should return null for file with invalid YAML', async () => {
      const testFile = path.join(tempDir, 'invalid-yaml.md');
      const content = `---
name: Test
invalid: yaml: content: here
---
Content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toBeNull();
    });

    it('should return null for non-existent file', async () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.md');

      const metadata = await (provider as any).readMetadataOnly(nonExistentFile);

      expect(metadata).toBeNull();
    });

    it('should only read first 4KB of file', async () => {
      const testFile = path.join(tempDir, 'large-file.md');
      const frontmatter = `---
name: Test
_dollhouseMCPTest: true
---`;
      const largeContent = 'A'.repeat(10000); // 10KB of content
      const content = frontmatter + '\n' + largeContent;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toEqual({
        name: 'Test',
        _dollhouseMCPTest: true
      });
    });

    it('should handle frontmatter that ends exactly at buffer boundary', async () => {
      const testFile = path.join(tempDir, 'boundary-test.md');
      // Create frontmatter that when combined with opening --- and newlines
      // gets close to the 4KB buffer limit
      const largeFrontmatter = 'A'.repeat(4000);
      const content = `---
description: ${largeFrontmatter}
_dollhouseMCPTest: true
---
Content here`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toEqual({
        description: largeFrontmatter,
        _dollhouseMCPTest: true
      });
    });
  });

  describe('isDollhouseMCPTestElement', () => {
    it('should return true for file with _dollhouseMCPTest: true', async () => {
      const testFile = path.join(tempDir, 'test-element.md');
      const content = `---
name: Test Element
_dollhouseMCPTest: true
---
Content`;

      await fs.writeFile(testFile, content);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(isTest).toBe(true);
    });

    it('should return false for file with _dollhouseMCPTest: false', async () => {
      const testFile = path.join(tempDir, 'non-test-element.md');
      const content = `---
name: Regular Element
_dollhouseMCPTest: false
---
Content`;

      await fs.writeFile(testFile, content);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(isTest).toBe(false);
    });

    it('should return false for file without _dollhouseMCPTest field', async () => {
      const testFile = path.join(tempDir, 'regular-element.md');
      const content = `---
name: Regular Element
version: 1.0.0
---
Content`;

      await fs.writeFile(testFile, content);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(isTest).toBe(false);
    });

    it('should return false for file without frontmatter', async () => {
      const testFile = path.join(tempDir, 'no-frontmatter.md');
      const content = `# Regular Content
No frontmatter here.`;

      await fs.writeFile(testFile, content);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(isTest).toBe(false);
    });

    it('should return false for non-existent file', async () => {
      const nonExistentFile = path.join(tempDir, 'does-not-exist.md');

      const isTest = await (provider as any).isDollhouseMCPTestElement(nonExistentFile);

      expect(isTest).toBe(false);
    });

    it('should handle string values correctly', async () => {
      const testFile = path.join(tempDir, 'string-test.md');
      const content = `---
name: Test Element
_dollhouseMCPTest: "true"
---
Content`;

      await fs.writeFile(testFile, content);

      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // String "true" should not be considered the same as boolean true
      expect(isTest).toBe(false);
    });
  });

  describe('integration with copyElementFiles', () => {
    it('should block test elements in production environment', async () => {
      // Force production environment using FORCE_PRODUCTION_MODE
      const originalForceMode = process.env.FORCE_PRODUCTION_MODE;
      process.env.FORCE_PRODUCTION_MODE = 'true';

      try {
        // Create a new provider AFTER setting the environment variable
        // This ensures the production detection override is applied
        const productionProvider = new DefaultElementProvider({
          loadTestData: false  // Must be false for production safety check to activate
        });

        // Create test data structure
        const sourceDir = path.join(tempDir, 'source');
        const destDir = path.join(tempDir, 'dest');
        await fs.mkdir(sourceDir, { recursive: true });
        await fs.mkdir(destDir, { recursive: true });

        // Create a test element
        const testElementContent = `---
name: Test Element
_dollhouseMCPTest: true
_testMetadata:
  suite: unit
  purpose: testing metadata detection
---
# Test Element
This is a test element.`;

        const regularElementContent = `---
name: Regular Element
version: 1.0.0
---
# Regular Element
This is a regular element.`;

        await fs.writeFile(path.join(sourceDir, 'test-element.md'), testElementContent);
        await fs.writeFile(path.join(sourceDir, 'regular-element.md'), regularElementContent);

        // Copy elements using the production provider
        const copiedCount = await (productionProvider as any).copyElementFiles(sourceDir, destDir, 'personas');

        // Should only copy the regular element (test element blocked)
        expect(copiedCount).toBe(1);

        // Verify only regular element was copied
        const destFiles = await fs.readdir(destDir);
        expect(destFiles).toEqual(['regular-element.md']);
      } finally {
        // Restore environment
        if (originalForceMode === undefined) {
          delete process.env.FORCE_PRODUCTION_MODE;
        } else {
          process.env.FORCE_PRODUCTION_MODE = originalForceMode;
        }
      }
    });

    it('should allow test elements in development environment', async () => {
      // Create test data structure
      const sourceDir = path.join(tempDir, 'source');
      const destDir = path.join(tempDir, 'dest');
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });

      // Create a test element
      const testElementContent = `---
name: Test Element
_dollhouseMCPTest: true
---
# Test Element
This is a test element.`;

      await fs.writeFile(path.join(sourceDir, 'test-element.md'), testElementContent);

      // Mock isProductionEnvironment to return false
      const originalMethod = (provider as any).isProductionEnvironment;
      (provider as any).isProductionEnvironment = jest.fn().mockReturnValue(false);

      try {
        // Copy elements
        const copiedCount = await (provider as any).copyElementFiles(sourceDir, destDir, 'personas');

        // Should copy the test element in dev mode
        expect(copiedCount).toBe(1);

        // Verify test element was copied
        const destFiles = await fs.readdir(destDir);
        expect(destFiles).toEqual(['test-element.md']);
      } finally {
        // Restore original method
        (provider as any).isProductionEnvironment = originalMethod;
      }
    });
  });

  describe('security considerations', () => {
    it('should never read beyond the frontmatter closing marker', async () => {
      const testFile = path.join(tempDir, 'potential-malicious.md');
      const content = `---
name: Safe Element
_dollhouseMCPTest: false
---
# Dangerous Content
rm -rf /
eval(maliciousCode())
<script>alert('xss')</script>`;

      await fs.writeFile(testFile, content);

      // Should only read the metadata, not the dangerous content
      const metadata = await (provider as any).readMetadataOnly(testFile);

      expect(metadata).toEqual({
        name: 'Safe Element',
        _dollhouseMCPTest: false
      });

      // Verify it correctly identifies as non-test
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(false);
    });

    it('should handle malformed frontmatter gracefully', async () => {
      const testFile = path.join(tempDir, 'malformed.md');
      const content = `---
name: Test
# This breaks YAML parsing
invalid: {broken yaml
---
Content`;

      await fs.writeFile(testFile, content);

      // Should return null for malformed YAML
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata).toBeNull();

      // Should return false for test detection
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(false);
    });
  });
});