import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { SECURITY_LIMITS } from '../../../src/security/constants.js';
import { ElementType } from '../../../src/portfolio/PortfolioManager.js';
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

    process.env.DOLLHOUSE_PORTFOLIO_DIR = testDir;

    const container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    // Warm up initialization so handlers are ready for each test
    await server.listPersonas();
  });

  afterEach(async () => {
    // Dispose server FIRST to release file handles (critical for Windows)
    await server.dispose();
    delete process.env.DOLLHOUSE_PORTFOLIO_DIR;

    // Then clean up directory with retry for Windows file locking delays
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.rm(testDir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Ignore final cleanup errors
      }
    }
  });

  describe('createElement with large content', () => {
    it('should reject content exceeding MAX_CONTENT_LENGTH', async () => {
      // Create content that exceeds the limit
      const largeContent = 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH + 1);
      
      const result = await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        content: largeContent
      });

      expect(result.content[0].text).toContain('❌ Content too large');
      expect(result.content[0].text).toContain(`${SECURITY_LIMITS.MAX_CONTENT_LENGTH} characters`);
      expect(result.content[0].text).toContain(`${Math.floor(SECURITY_LIMITS.MAX_CONTENT_LENGTH / 1024)}KB`);
    });

    it('should reject content that exceeds the serialized YAML size limit', async () => {
      // Raw content can pass the pre-validation length check and still fail later
      // once it is embedded into serialized YAML/frontmatter on save.
      const maxContent = 'x'.repeat(SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      
      const result = await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        content: maxContent
      });

      // The raw input is accepted by the request-size guard first.
      expect(result.content[0].text).not.toContain('❌ Content too large');
      // The save path then rejects it because the serialized YAML is too large.
      expect(result.content[0].text).toContain('YAML content exceeds maximum allowed size');
    });

    it('should accept content below MAX_CONTENT_LENGTH', async () => {
      // Create normal sized content
      const normalContent = 'This is a normal sized skill content';
      
      const result = await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL, 
        description: 'Test skill',
        content: normalContent
      });

      expect(result.content[0].text).toContain('✅ Created skill');
      expect(result.content[0].text).toContain('test-skill');
    });

    it('should reject missing content with validation error', async () => {
      const result = await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill'
        // No content provided - ValidationService should reject this
      });

      // ValidationService correctly rejects empty content
      expect(result.content[0].text).toContain('Failed to create skill');
      expect(result.content[0].text).toMatch(/Invalid skill content|Content is required/);
    });

    it('should prevent memory exhaustion with extremely large content', async () => {
      // This is the test case that would have caused Claude to hang
      const hugeContent = 'x'.repeat(1000000); // 1 million characters
      
      const result = await server.createElement({
        name: 'test-skill',
        type: ElementType.SKILL,
        description: 'Test skill',
        content: hugeContent
      });

      expect(result.content[0].text).toContain('❌ Content too large');
      // Should complete quickly without hanging
    });
  });
});
