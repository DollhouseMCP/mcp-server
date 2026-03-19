/**
 * Integration tests for Prescriptive Digest (Issue #492)
 *
 * Tests the full chain: element activation → active element tracking →
 * digest generation. Verifies that:
 * 1. Active elements are correctly tracked after activation/deactivation
 * 2. The digest generator produces correct output for active elements
 * 3. The ServerSetup injection point works (digest in responses)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { generatePrescriptiveDigest } from '../../../src/server/PrescriptiveDigest.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Prescriptive Digest Integration (Issue #492)', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('prescriptive-digest');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');

    // Create test elements
    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'digest-test-persona',
        element_type: 'persona',
        description: 'Test persona for digest integration',
        content: 'You are a test persona for prescriptive digest testing.',
      },
    });

    await mcpAqlHandler.handleCreate({
      operation: 'create_element',
      params: {
        element_name: 'digest-test-skill',
        element_type: 'skill',
        description: 'Test skill for digest integration',
        content: 'Test skill content for prescriptive digest testing.',
      },
    });

    // Allow cache to settle
    await new Promise(r => setTimeout(r, 2000));
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('activation tracking', () => {
    it('should report no active elements initially', async () => {
      const result = await server.getActiveElements('persona');
      const text = result?.content?.[0]?.text ?? '';
      // Should indicate no active elements
      expect(text.toLowerCase()).toMatch(/no active|none|empty|no .* active/);
    });

    it('should activate a persona successfully', async () => {
      const result = await server.activateElement('digest-test-persona', 'persona');
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Failed');
      expect(text).not.toContain('❌');

      // Verify it shows as active
      const activeResult = await server.getActiveElements('persona');
      const activeText = activeResult?.content?.[0]?.text ?? '';
      expect(activeText).toContain('digest-test-persona');
    });

    it('should activate a skill successfully', async () => {
      const result = await server.activateElement('digest-test-skill', 'skill');
      const text = result?.content?.[0]?.text ?? '';
      expect(text).not.toContain('Failed');
      expect(text).not.toContain('❌');

      // Verify it shows as active
      const activeResult = await server.getActiveElements('skill');
      const activeText = activeResult?.content?.[0]?.text ?? '';
      expect(activeText).toContain('digest-test-skill');
    });

    it('should remove element from active list after deactivation', async () => {
      await server.activateElement('digest-test-skill', 'skill');
      await server.deactivateElement('digest-test-skill', 'skill');

      const activeResult = await server.getActiveElements('skill');
      const activeText = activeResult?.content?.[0]?.text ?? '';
      expect(activeText).not.toContain('digest-test-skill');
    });
  });

  describe('digest generation with activated elements', () => {
    it('should generate empty digest when no elements are active', () => {
      const digest = generatePrescriptiveDigest([]);
      expect(digest).toBe('');
    });

    it('should generate correct digest for an active persona', () => {
      const digest = generatePrescriptiveDigest([
        { type: 'persona', name: 'digest-test-persona' }
      ]);
      expect(digest).toContain('[Active elements:');
      expect(digest).toContain('persona: digest-test-persona');
      expect(digest).toContain('get_active_elements');
      expect(digest.endsWith(']')).toBe(true);
    });

    it('should group multiple element types in digest', () => {
      const digest = generatePrescriptiveDigest([
        { type: 'persona', name: 'digest-test-persona' },
        { type: 'skill', name: 'digest-test-skill' },
      ]);
      expect(digest).toContain('persona: digest-test-persona');
      expect(digest).toContain('skill: digest-test-skill');
    });

    it('should combine multiple elements of same type', () => {
      const digest = generatePrescriptiveDigest([
        { type: 'skill', name: 'skill-a' },
        { type: 'skill', name: 'skill-b' },
      ]);
      expect(digest).toContain('skill: skill-a, skill-b');
    });
  });

  describe('ServerSetup injection via MCP-AQL', () => {
    // These tests verify that when elements are active, tool responses
    // from the MCP-AQL handler include the prescriptive digest appended
    // by ServerSetup. MCP-AQL handler responses go through the full
    // ServerSetup pipeline when called via MCP protocol.
    //
    // Note: Direct mcpAqlHandler calls bypass ServerSetup. These tests
    // verify the components work together; the actual injection is tested
    // end-to-end via behavior tests.

    it('should have digest generator available for ServerSetup', () => {
      // Verify the module exports are correct
      expect(typeof generatePrescriptiveDigest).toBe('function');
    });

    it('should produce a digest under 100 tokens for typical active set', () => {
      // Verify the digest stays compact (critical for token efficiency)
      const digest = generatePrescriptiveDigest([
        { type: 'persona', name: 'agentic-loop-architect' },
        { type: 'skill', name: 'code-reviewer' },
        { type: 'skill', name: 'conversation-audio-summarizer' },
        { type: 'ensemble', name: 'development-suite' },
      ]);

      // Rough token estimate: ~1.3 tokens per word, count words
      const wordCount = digest.split(/\s+/).length;
      expect(wordCount).toBeLessThan(50); // Well under 100 tokens
    });

    it('should not produce digest for empty active set', () => {
      const digest = generatePrescriptiveDigest([]);
      expect(digest).toBe('');
      // Zero overhead when no elements active
    });
  });
});
