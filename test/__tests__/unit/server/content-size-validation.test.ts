import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../../src/index.js';
import { SECURITY_LIMITS } from '../../../../src/security/constants.js';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

describe('Content Size Validation', () => {
  let server: DollhouseMCPServer;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(os.tmpdir(), `content-size-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    // Initialize server with test directory
    server = new DollhouseMCPServer();
    (server as any).personasDir = testDir;
    (server as any).portfolioDir = testDir;
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('createElement with large content', () => {
    it('should reject content exceeding MAX_CONTENT_LENGTH', async () => {
      // Create content that exceeds the limit
      const largeContent = 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills',
        description: 'Test skill',
        content: largeContent
      });

      expect(result.content[0].text).toContain('❌ Content too large');
      expect(result.content[0].text).toContain(`${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters`);
      expect(result.content[0].text).toContain(`${Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 1024)}KB`);
    });

    it('should accept content at exactly MAX_CONTENT_LENGTH', async () => {
      // Create content at exactly the limit
      const maxContent = 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills',
        description: 'Test skill',
        content: maxContent
      });

      // Should not contain error message
      expect(result.content[0].text).not.toContain('❌ Content too large');
      // Should successfully create
      expect(result.content[0].text).toContain('✅ Created skill');
    });

    it('should accept content below MAX_CONTENT_LENGTH', async () => {
      // Create normal sized content
      const normalContent = 'This is a normal sized skill content';
      
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills', 
        description: 'Test skill',
        content: normalContent
      });

      expect(result.content[0].text).toContain('✅ Created skill');
      expect(result.content[0].text).toContain('test-skill');
    });

    it('should handle missing content gracefully', async () => {
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills',
        description: 'Test skill'
        // No content provided
      });

      expect(result.content[0].text).toContain('✅ Created skill');
    });

    it('should prevent memory exhaustion with extremely large content', async () => {
      // This is the test case that would have caused Claude to hang
      const hugeContent = 'x'.repeat(1000000); // 1 million characters
      
      const result = await server.createElement({
        name: 'test-skill',
        type: 'skills',
        description: 'Test skill',
        content: hugeContent
      });

      expect(result.content[0].text).toContain('❌ Content too large');
      // Should complete quickly without hanging
    });
  });
});