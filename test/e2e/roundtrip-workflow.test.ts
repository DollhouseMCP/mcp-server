/**
 * End-to-End Roundtrip Workflow Tests
 * 
 * This test suite validates the complete roundtrip workflow:
 * 1. Browse and install content from collection
 * 2. Modify content locally
 * 3. Submit to GitHub portfolio
 * 4. Create collection issue
 * 5. Validate the complete process
 * 
 * TEMPORARILY SKIPPED: See Issue #598 for test infrastructure improvements needed
 * - Mock/implementation response format mismatch
 * - Platform-specific test initialization issues
 * - Need atomic, granular tests to isolate issues
 */

import { describe, test, beforeAll, afterAll, beforeEach, afterEach, expect, jest } from '@jest/globals';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { TestServer } from '../__tests__/integration/helpers/test-server.js';
import { GitHubClient } from '../../src/collection/GitHubClient.js';
import { ConfigManager } from '../../src/config/ConfigManager.js';

interface TestContext {
  server: TestServer;
  portfolioDir: string;
  testRepoName: string;
  testSkillName: string;
  originalConfig: any;
}

describe('Roundtrip Workflow E2E Tests', () => {
  let ctx: TestContext;
  const TEST_TIMEOUT = 30000; // 30 seconds for each test

  beforeAll(async () => {
    // Initialize test context with UUID for better uniqueness guarantees than Date.now()
    ctx = {
      server: new TestServer(),
      portfolioDir: path.join(process.cwd(), 'test-portfolio'),
      testRepoName: `test-portfolio-${uuidv4()}`,
      testSkillName: 'roundtrip-test-skill',
      originalConfig: null
    };

    // Save original configuration
    ctx.originalConfig = await ConfigManager.getInstance().getConfig();

    // Start test server
    await ctx.server.start();
    
    // Create test portfolio directory
    await fs.mkdir(ctx.portfolioDir, { recursive: true });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Cleanup test server
    if (ctx.server) {
      await ctx.server.stop();
    }

    // Restore original configuration
    if (ctx.originalConfig) {
      await ConfigManager.getInstance().updateConfig(ctx.originalConfig);
    }

    // Cleanup test portfolio
    try {
      await fs.rm(ctx.portfolioDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to cleanup test portfolio:', error);
    }

    // Cleanup test repository would be implemented with GitHub API calls
    if (process.env.GITHUB_TOKEN && process.env.TEST_GITHUB_USERNAME) {
      console.log('Test repository cleanup would be performed here');
    }
  }, TEST_TIMEOUT);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe.skip('Phase 1: Collection Browsing and Installation', () => {
    test('should browse collection successfully', async () => {
      const result = await ctx.server.handleTool('browse_collection', {
        section: 'library',
        type: 'skills'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.items).toBeDefined();
      expect(Array.isArray(result.data.items)).toBe(true);
    });

    test('should search collection for test content', async () => {
      const result = await ctx.server.handleTool('search_collection', {
        query: 'roundtrip test'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.results).toBeDefined();
    });

    test('should install content from collection', async () => {
      const result = await ctx.server.handleTool('install_content', {
        path: 'library/skills/roundtrip-test-skill.md'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.installed).toBe(true);
      expect(result.data.elementName).toBe(ctx.testSkillName);
    });

    test('should verify installed content exists locally', async () => {
      const result = await ctx.server.handleTool('list_elements', {
        type: 'skills'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.skills).toBeDefined();
      
      const installedSkill = result.data.skills.find(
        (skill: any) => skill.name.toLowerCase().includes('roundtrip')
      );
      expect(installedSkill).toBeDefined();
      expect(installedSkill.version).toBeDefined();
    });
  });

  describe.skip('Phase 2: Local Content Modification', () => {
    test('should modify installed content locally', async () => {
      const newVersion = '1.0.2';
      const testNote = 'Modified via E2E test';

      const result = await ctx.server.handleTool('edit_element', {
        elementName: ctx.testSkillName,
        type: 'skills',
        updates: {
          version: newVersion,
          description: `Original description. ${testNote}`
        }
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.updated).toBe(true);
    });

    test('should verify local modifications were saved', async () => {
      const result = await ctx.server.handleTool('get_element', {
        elementName: ctx.testSkillName,
        type: 'skills'
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.version).toBe('1.0.2');
      expect(result.data.description).toContain('Modified via E2E test');
    });
  });

  describe.skip('Phase 3: Portfolio Management', () => {
    test('should check portfolio status', async () => {
      const result = await ctx.server.handleTool('portfolio_status', {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      // Portfolio might not exist yet, that's ok
    });

    test('should configure portfolio settings without auto-submit', async () => {
      const result = await ctx.server.handleTool('portfolio_config', {
        auto_submit: false,
        auto_sync: true
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.config.autoSubmit).toBe(false);
    });

    test('should submit content to portfolio without collection issue', async () => {
      const result = await ctx.server.handleTool('submit_content', {
        content: ctx.testSkillName
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.portfolioSubmitted).toBe(true);
      expect(result.data.collectionIssueCreated).toBe(false);
      expect(result.data.manualSubmissionUrl).toBeDefined();
    });
  });

  describe.skip('Phase 4: Collection Submission with Auto-Submit', () => {
    test('should configure portfolio with auto-submit enabled', async () => {
      const result = await ctx.server.handleTool('portfolio_config', {
        auto_submit: true
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.config.autoSubmit).toBe(true);
    });

    test('should submit content with collection issue creation', async () => {
      // Modify content again to create a new version
      await ctx.server.handleTool('edit_element', {
        elementName: ctx.testSkillName,
        type: 'skills',
        updates: {
          version: '1.0.3',
          description: 'Final test version'
        }
      });

      const result = await ctx.server.handleTool('submit_content', {
        content: ctx.testSkillName
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.portfolioSubmitted).toBe(true);
      
      // Collection issue should be created when auto-submit is enabled
      if (process.env.GITHUB_TOKEN) {
        expect(result.data.collectionIssueCreated).toBe(true);
        expect(result.data.issueUrl).toBeDefined();
      }
    });
  });

  describe.skip('Phase 5: Error Handling', () => {
    test('should handle non-existent content submission gracefully', async () => {
      const result = await ctx.server.handleTool('submit_content', {
        content: 'non-existent-skill'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error.message).toContain('not found');
    });

    test('should handle invalid collection paths gracefully', async () => {
      const result = await ctx.server.handleTool('install_content', {
        path: 'library/invalid/non-existent.md'
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test('should handle browse collection with invalid type', async () => {
      const result = await ctx.server.handleTool('browse_collection', {
        section: 'library',
        type: 'invalid-type'
      });

      // Should either succeed with empty results or fail gracefully
      if (!result.success) {
        expect(result.error).toBeDefined();
      } else {
        expect(result.data.items).toBeDefined();
      }
    });
  });

  describe.skip('Phase 6: Cache and Performance', () => {
    test('should check collection cache health', async () => {
      const result = await ctx.server.handleTool('get_collection_cache_health', {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.status).toBeDefined();
      expect(result.data.stats).toBeDefined();
    });

    test('should handle multiple rapid operations without race conditions', async () => {
      const operations = [
        ctx.server.handleTool('browse_collection', { section: 'library', type: 'skills' }),
        ctx.server.handleTool('search_collection', { query: 'test' }),
        ctx.server.handleTool('list_elements', { type: 'skills' })
      ];

      const results = await Promise.allSettled(operations);
      
      // At least some operations should succeed
      const successful = results.filter(r => r.status === 'fulfilled').length;
      expect(successful).toBeGreaterThan(0);
    });
  });

  describe.skip('Phase 7: Complete Workflow Validation', () => {
    test('should validate complete roundtrip workflow integrity', async () => {
      // 1. Install fresh content
      const installResult = await ctx.server.handleTool('install_content', {
        path: 'library/skills/roundtrip-test-skill.md'
      });

      if (installResult.success) {
        // 2. Modify it
        const editResult = await ctx.server.handleTool('edit_element', {
          elementName: ctx.testSkillName,
          type: 'skills',
          updates: {
            version: '1.0.4',
            description: 'Complete workflow test'
          }
        });

        expect(editResult.success).toBe(true);

        // 3. Submit to portfolio
        const submitResult = await ctx.server.handleTool('submit_content', {
          content: ctx.testSkillName
        });

        expect(submitResult.success).toBe(true);
        expect(submitResult.data.portfolioSubmitted).toBe(true);

        // 4. Verify the element still exists and has correct version
        const verifyResult = await ctx.server.handleTool('get_element', {
          elementName: ctx.testSkillName,
          type: 'skills'
        });

        expect(verifyResult.success).toBe(true);
        expect(verifyResult.data.version).toBe('1.0.4');
      }
    });
  });
});

// Skip tests if required environment variables are not set
const skipMessage = 'Skipping roundtrip tests - missing required environment variables or GitHub token';

if (!process.env.GITHUB_TOKEN && !process.env.CI) {
  describe.skip = describe;
  console.warn(skipMessage);
}