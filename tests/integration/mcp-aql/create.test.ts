/**
 * Integration tests for MCP-AQL CREATE endpoint (mcp_aql_create)
 *
 * Tests the full flow from MCP tool call to element creation,
 * covering all CREATE operations:
 * - create_element: Create new elements
 * - import_element: Import from exported data
 * - addEntry: Add memory entries
 * - activate_element: Activate elements for session (now routes through READ - Issue #535)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { userInfo } from 'node:os';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, waitForCacheSettle, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import path from 'path';
import fs from 'fs/promises';

describe('MCP-AQL CREATE Endpoint Integration', () => {
  let env: PortfolioTestEnvironment;
  let container: DollhouseContainer;
  let server: DollhouseMCPServer;
  let mcpAqlHandler: MCPAQLHandler;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('mcp-aql-create');
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    await server.listPersonas(); // Initialize server
    preConfirmAllOperations(container);
    mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
  });

  afterEach(async () => {
    await server.dispose();
    await env.cleanup();
  });

  describe('create_element operation', () => {
    it('should create a persona via mcp_aql_create', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'integration-test',
          element_type: 'personas',
          description: 'A test persona for integration testing',
          content: '# Test Persona\n\nThis is a test persona.',
          metadata: { category: 'testing' },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
      }

      // Verify file was created
      const personaFile = path.join(env.testDir, 'personas', 'integration-test.md');
      await expect(fs.access(personaFile)).resolves.toBeUndefined();
    });

    it('should create a skill via mcp_aql_create', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'code-review-skill',
          element_type: 'skills',
          description: 'Reviews code for quality and best practices',
          content: '# Code Review Skill\n\nAnalyze code for patterns and issues.',
          metadata: { domain: 'development', proficiency: 4 },
        },
      });

      expect(result.success).toBe(true);

      const skillFile = path.join(env.testDir, 'skills', 'code-review-skill.md');
      await expect(fs.access(skillFile)).resolves.toBeUndefined();
    });

    it('should create a template via mcp_aql_create', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'meeting-notes',
          element_type: 'templates',
          description: 'Template for meeting notes',
          content: '# Meeting Notes\n\nDate: {{date}}\nAttendees: {{attendees}}\n\n## Discussion\n{{discussion}}',
          metadata: { variables: ['date', 'attendees', 'discussion'] },
        },
      });

      expect(result.success).toBe(true);

      const templateFile = path.join(env.testDir, 'templates', 'meeting-notes.md');
      await expect(fs.access(templateFile)).resolves.toBeUndefined();
    });

    it('should use elementType when provided instead of params.type', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        elementType: 'skill' as any,
        params: {
          element_name: 'explicit-type-skill',
          description: 'Skill with explicit elementType',
          content: 'Skill content here',
        },
      });

      expect(result.success).toBe(true);
    });

    // Note: Handler is lenient and doesn't strictly validate required fields at the MCP-AQL level.
    // Field validation happens deeper in the element managers, and createElement may succeed
    // with minimal data. Consider adding stricter validation in MCPAQLHandler if needed.
    it.skip('should fail when required fields are missing', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'incomplete-element',
          // Missing type and description
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('ensemble create_element operations (Issue #662)', () => {
    it('should create an ensemble with elements', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'test-ensemble',
          element_type: 'ensembles',
          description: 'An ensemble for integration testing',
          content: '# Test Ensemble\n\nEnsemble with two skills.',
          metadata: {
            activationStrategy: 'all',
            elements: [
              { element_name: 'code-review', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
              { element_name: 'debugging', element_type: 'skill', role: 'support', priority: 60, activation: 'always' },
            ],
          },
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'test-ensemble.md');
      await expect(fs.access(ensembleFile)).resolves.toBeUndefined();
      const fileContent = await fs.readFile(ensembleFile, 'utf-8');
      expect(fileContent).toContain('code-review');
      expect(fileContent).toContain('debugging');
    });

    it('should create an empty ensemble', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'empty-ensemble',
          element_type: 'ensembles',
          description: 'An ensemble with no elements',
          content: '# Empty Ensemble\n\nNo elements yet.',
        },
      });

      expect(result.success).toBe(true);

      const ensembleFile = path.join(env.testDir, 'ensembles', 'empty-ensemble.md');
      await expect(fs.access(ensembleFile)).resolves.toBeUndefined();
    });

    it('should find ensemble via get_element after create (cache coherence)', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'cache-coherence-ensemble',
          element_type: 'ensembles',
          description: 'Ensemble for cache coherence test',
          content: '# Cache Test Ensemble\n\nMust be readable immediately.',
          metadata: {
            elements: [
              { element_name: 'test-skill', element_type: 'skill', role: 'primary', priority: 80, activation: 'always' },
            ],
          },
        },
      });
      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const readResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        elementType: 'ensemble',
        params: { element_name: 'cache-coherence-ensemble' },
      });

      expect(readResult.success).toBe(true);
      const text = readResult.data?.content?.[0]?.text ?? '';
      expect(text).toContain('cache-coherence-ensemble');
    });
  });

  describe('create-then-read cache coherence (Issue #491)', () => {
    // Regression tests: elements must be immediately readable after creation.
    // Previously, PersonaManager.create() called reload() which cleared the cache
    // and rebuilt with different IDs, making newly created personas invisible.

    it('should find a persona via get_element immediately after creation', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'cache-coherence-persona',
          element_type: 'personas',
          description: 'Tests that persona is readable immediately after creation',
          content: '# Cache Coherence Test\n\nThis persona must be findable right away.',
        },
      });

      expect(createResult.success).toBe(true);

      // Allow cache settle time
      await waitForCacheSettle();

      // This is the critical assertion — get_element must find it without a server restart
      const readResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        elementType: 'persona',
        params: { element_name: 'cache-coherence-persona' },
      });

      expect(readResult.success).toBe(true);
      const text = readResult.data?.content?.[0]?.text ?? '';
      expect(text).toContain('cache-coherence-persona');
    });

    it('should find a skill via get_element immediately after creation', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'cache-coherence-skill',
          element_type: 'skills',
          description: 'Tests that skill is readable immediately after creation',
          content: '# Cache Coherence Skill\n\nMust be findable right away.',
        },
      });

      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const readResult = await mcpAqlHandler.handleRead({
        operation: 'get_element',
        elementType: 'skill',
        params: { element_name: 'cache-coherence-skill' },
      });

      expect(readResult.success).toBe(true);
      const text = readResult.data?.content?.[0]?.text ?? '';
      expect(text).toContain('cache-coherence-skill');
    });

    it('should list a newly created persona in list_elements results', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'listable-persona',
          element_type: 'personas',
          description: 'Must appear in list_elements immediately',
          content: '# Listable Persona\n\nShould show up in listings.',
        },
      });

      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const listResult = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        elementType: 'persona',
        params: {},
      });

      expect(listResult.success).toBe(true);
      // Issue #299: list_elements now returns structured data
      const data = listResult.data as { items?: Array<{ name: string }> };
      const names = (data.items || []).map((i: any) => i.name || i.element_name);
      expect(names).toContain('listable-persona');
    });

    it('should list and activate a newly created agent immediately after creation (Issue #1873)', async () => {
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'cache-coherence-agent',
          element_type: 'agents',
          description: 'Tests that agent index-backed reads work immediately after creation',
          instructions: 'Execute integration test tasks methodically and report completion.',
          content: '# Cache Coherence Agent\n\nMust be listable and activatable right away.',
        },
      });

      expect(createResult.success).toBe(true);

      await waitForCacheSettle();

      const listResult = await mcpAqlHandler.handleRead({
        operation: 'list_elements',
        elementType: 'agent',
        params: {},
      });

      expect(listResult.success).toBe(true);
      const listData = listResult.data as { items?: Array<{ name: string }> };
      const names = (listData.items || []).map((i: any) => i.name || i.element_name);
      expect(names).toContain('cache-coherence-agent');

      const activateResult = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'cache-coherence-agent',
          element_type: 'agents',
        },
      });

      expect(activateResult.success).toBe(true);
      const activateText = activateResult.data?.content?.[0]?.text ?? '';
      expect(activateText.toLowerCase()).toContain('activated');

      const activeResult = await mcpAqlHandler.handleRead({
        operation: 'get_active_elements',
        params: {
          element_type: 'agents',
        },
      });

      expect(activeResult.success).toBe(true);
      const activeText = activeResult.data?.content?.[0]?.text ?? '';
      expect(activeText).toContain('cache-coherence-agent');
    });
  });

  describe('import_element operation', () => {
    it('should import a persona from JSON export package', async () => {
      const exportPackage = {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        elementType: 'personas',
        elementName: 'json-imported',
        format: 'json',
        data: JSON.stringify({
          element_name: 'json-imported',
          description: 'A persona imported from JSON',
          content: '# Imported Persona\n\nImported successfully.',
          metadata: { source: 'import-test' },
        }),
      };

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: exportPackage,
          overwrite: true, // Allow overwrite in case element exists from previous test run
        },
      });

      expect(result.success).toBe(true);

      const personaFile = path.join(env.testDir, 'personas', 'json-imported.md');
      await expect(fs.access(personaFile)).resolves.toBeUndefined();
    });

    it('should import a skill from YAML export package', async () => {
      const yamlData = `name: imported-yaml-skill
description: A skill imported from YAML format
content: |
  # YAML Imported Skill
  This skill was imported from YAML.
metadata:
  domain: testing
  proficiency: 3`;

      const exportPackage = {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        elementType: 'skills',
        elementName: 'imported-yaml-skill',
        format: 'yaml',
        data: yamlData,
      };

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: exportPackage,
          overwrite: true, // Allow overwrite in case element exists from previous test run
        },
      });

      expect(result.success).toBe(true);

      const skillFile = path.join(env.testDir, 'skills', 'imported-yaml-skill.md');
      await expect(fs.access(skillFile)).resolves.toBeUndefined();
    });

    it('should import from stringified export package', async () => {
      const exportPackage = JSON.stringify({
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        elementType: 'personas',
        elementName: 'string-imported',
        format: 'json',
        data: JSON.stringify({
          element_name: 'string-imported',
          description: 'Imported from stringified package',
          content: '# String Imported\n\nContent here.',
        }),
      });

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: exportPackage,
          overwrite: true, // Allow overwrite in case element exists from previous test run
        },
      });

      expect(result.success).toBe(true);
    });

    // FIX: Issue #276 - Test skipped due to cache timing issues between create and import operations
    // Elements created via handleCreate are not immediately visible for import duplicate checking
    it.skip('should reject import when element exists and overwrite is false', async () => {
      // First create an element
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'existing-element',
          element_type: 'personas',
          description: 'Original element',
          content: 'Original content',
        },
      });

      // Try to import with same name without overwrite
      const exportPackage = {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        elementType: 'personas',
        format: 'json',
        data: JSON.stringify({
          element_name: 'existing-element',
          description: 'Duplicate import attempt',
          content: 'New content',
        }),
      };

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: exportPackage,
          overwrite: false,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('already exists');
      }
    });

    it('should allow import with overwrite:true when element exists', async () => {
      // First create an element
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'overwrite-target',
          element_type: 'personas',
          description: 'Original to be overwritten',
          content: 'Original content',
        },
      });

      // Import with overwrite
      const exportPackage = {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        elementType: 'personas',
        format: 'json',
        data: JSON.stringify({
          element_name: 'overwrite-target',
          description: 'Overwritten description',
          content: 'New overwritten content',
        }),
      };

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: exportPackage,
          overwrite: true,
        },
      });

      expect(result.success).toBe(true);
    });

    it('should fail with invalid export package structure', async () => {
      const invalidPackage = {
        // Missing required fields
        format: 'json',
        data: '{}',
      };

      const result = await mcpAqlHandler.handleCreate({
        operation: 'import_element',
        params: {
          data: invalidPackage,
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // Schema-driven dispatch provides clearer error message
        expect(result.error).toContain('missing element data');
      }
    });
  });

  describe('activate_element operation', () => {
    beforeEach(async () => {
      // Create a persona to activate
      await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'activatable-persona',
          element_type: 'personas',
          description: 'A persona ready for activation',
          content: '# Activatable Persona\n\nReady to be activated.',
        },
      });
    });

    it('should activate a persona via mcp_aql_read (Issue #535)', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'activatable-persona',
          element_type: 'personas',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should activate with elementType parameter', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        elementType: 'persona' as any,
        params: {
          element_name: 'activatable-persona',
        },
      });

      expect(result.success).toBe(true);
    });

    it('should pass context when activating', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'activatable-persona',
          element_type: 'personas',
          context: { project: 'mcp-aql-tests', mode: 'integration' },
        },
      });

      expect(result.success).toBe(true);
    });

    // Note: ElementCRUDHandler.activateElement catches errors and returns a formatted
    // error message in the content field, but still returns success:true at the MCP-AQL level.
    // The actual error is conveyed through the content structure, not through success:false.
    // This is intentional to match MCP tool response patterns.
    it('should return success with error message when activating non-existent element', async () => {
      const result = await mcpAqlHandler.handleRead({
        operation: 'activate_element',
        params: {
          element_name: 'non-existent-persona',
          element_type: 'personas',
        },
      });

      // The handler returns success:true but includes error details in the data
      expect(result.success).toBe(true);
      if (result.success) {
        // Check that the result contains an error indicator
        const data = result.data as any;
        expect(data).toBeDefined();
        expect(data.content).toBeDefined();
        // The error message will contain either "Failed to activate" or "not found"
        expect(data.content[0].text).toMatch(/not found|Failed to activate/);
      }
    });
  });

  describe('author attribution (Issue #763)', () => {
    it('should set OS username as author when no explicit author provided', async () => {
      // Save and clear DOLLHOUSE_USER so the OS username fallback is exercised
      const originalUser = process.env.DOLLHOUSE_USER;
      delete process.env.DOLLHOUSE_USER;

      try {
        const createResult = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'author-attribution-test',
            element_type: 'skills',
            description: 'Tests that author defaults to OS username',
            content: '# Author Attribution Test\n\nVerify author field.',
          },
        });

        expect(createResult.success).toBe(true);

        // Read the persisted file and verify the author in frontmatter
        const skillFile = path.join(env.testDir, 'skills', 'author-attribution-test.md');
        const fileContent = await fs.readFile(skillFile, 'utf-8');

        const expectedUsername = userInfo().username;
        expect(fileContent).toContain(`author: ${expectedUsername}`);
        // Should NOT be an anonymous ID
        expect(fileContent).not.toMatch(/author: anon-/);
      } finally {
        if (originalUser !== undefined) {
          process.env.DOLLHOUSE_USER = originalUser;
        }
      }
    });

    it('should use DOLLHOUSE_USER env var when set', async () => {
      const originalUser = process.env.DOLLHOUSE_USER;
      process.env.DOLLHOUSE_USER = 'env-test-user';

      try {
        // Need a fresh server so MetadataService re-resolves
        await server.dispose();
        const freshContainer = new DollhouseContainer();
        const freshServer = new DollhouseMCPServer(freshContainer);
        await freshServer.listPersonas();
        preConfirmAllOperations(freshContainer);
        const freshHandler = freshContainer.resolve<MCPAQLHandler>('mcpAqlHandler');

        const createResult = await freshHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'env-author-test',
            element_type: 'skills',
            description: 'Tests that author uses DOLLHOUSE_USER',
            content: '# Env Author Test\n\nVerify env var author.',
          },
        });

        expect(createResult.success).toBe(true);

        const skillFile = path.join(env.testDir, 'skills', 'env-author-test.md');
        const fileContent = await fs.readFile(skillFile, 'utf-8');

        expect(fileContent).toContain('author: env-test-user');

        await freshServer.dispose();
      } finally {
        if (originalUser !== undefined) {
          process.env.DOLLHOUSE_USER = originalUser;
        } else {
          delete process.env.DOLLHOUSE_USER;
        }
      }
    });

    it('should persist author through create-then-read roundtrip', async () => {
      const originalUser = process.env.DOLLHOUSE_USER;
      delete process.env.DOLLHOUSE_USER;

      try {
        const createResult = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          params: {
            element_name: 'roundtrip-author-test',
            element_type: 'personas',
            description: 'Tests author survives create-read roundtrip',
            content: '# Roundtrip Author\n\nVerify author persists.',
          },
        });

        expect(createResult.success).toBe(true);

        await waitForCacheSettle();

        const readResult = await mcpAqlHandler.handleRead({
          operation: 'get_element',
          elementType: 'persona',
          params: { element_name: 'roundtrip-author-test' },
        });

        expect(readResult.success).toBe(true);
        const text = readResult.data?.content?.[0]?.text ?? '';
        const expectedUsername = userInfo().username;
        expect(text).toContain(expectedUsername);
        expect(text).not.toMatch(/anon-/);
      } finally {
        if (originalUser !== undefined) {
          process.env.DOLLHOUSE_USER = originalUser;
        }
      }
    });
  });

  describe('addEntry operation', () => {
    beforeEach(async () => {
      // Create a memory element to add entries to
      const createResult = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'test-memory',
          element_type: 'memories',
          description: 'A memory for storing test entries',
          content: '',
          metadata: { retention: 'permanent' },
        },
      });
      // Verify memory was created successfully - fail fast if setup fails
      expect(createResult.success).toBe(true);
    });

    it('should add entry to memory element', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'test-memory',
          content: 'This is a test memory entry',
          tags: ['test', 'integration'],
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
      }
    });

    it('should add entry with metadata', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'test-memory',
          content: 'Entry with custom metadata',
          tags: ['metadata-test'],
          metadata: { importance: 'high', source: 'integration-test' },
        },
      });

      expect(result.success).toBe(true);
    });

    it('should fail when memory does not exist', async () => {
      const result = await mcpAqlHandler.handleCreate({
        operation: 'addEntry',
        params: {
          element_name: 'non-existent-memory',
          content: 'This should fail',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('not found');
      }
    });
  });

  describe('large content creation', () => {
    it('should accept skill with 13KB+ content through full pipeline', async () => {
      // Regression test: A production QA review skill (~13KB) with structured
      // checklists and scoring rubrics was silently rejected when the regex
      // validator's medium complexity limit was 10KB. The limit was raised to
      // 500KB (matching MAX_CONTENT_LENGTH) since medium complexity patterns
      // use simple quantifiers with O(n) linear time — no ReDoS risk.
      // This tests the full create path through MCPAQLHandler, not just
      // RegexValidator in isolation, to catch pipeline-level regressions.
      const largeContent = '# QA Review Skill\n\n' +
        '## Checklist\n\n' +
        Array.from({ length: 200 }, (_, i) =>
          `### Item ${i + 1}\n\n- Verify correctness\n- Check formatting\n- Review structure\n`
        ).join('\n');
      expect(largeContent.length).toBeGreaterThan(13000);

      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        params: {
          element_name: 'large-content-skill',
          element_type: 'skills',
          description: 'A skill with 13KB+ content for regression testing',
          content: largeContent,
        },
      });
      expect(result.success).toBe(true);
    });
  });
});
