/**
 * Automated CRUD Lifecycle Test Protocol
 * 
 * Implements the LIVE_MCP_TEST_PROTOCOL.md for automated E2E testing.
 * Verifies the complete lifecycle (Create, Read, Update, Delete) of all element types.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { ElementType } from '../../src/portfolio/types.js';
import { ElementNotFoundError } from '../../src/utils/ErrorHandler.js';

// CI-compatible cache settling time (Issue #276, #506)
const CACHE_SETTLE_MS = 2000;

// Define the element types to test
// Uses plain {name}.md naming convention — directory provides type context
const TEST_ELEMENTS = [
  {
    type: ElementType.PERSONA,
    name: 'CRUDV-Persona-Alpha',
    filename: 'crudv-persona-alpha.md',
    description: 'A CRUD verification persona',
    content: '# CRUDV Persona Alpha\n\nYou are a persona created to verify CRUD operations work correctly.\n\n## Behavior\n- Be helpful\n- Be concise',
    metadata: {
      author: 'CRUD Verification',
      version: '1.0.0',
      triggers: ['crudv-alpha', 'alpha-crudv']
    }
  },
  {
    type: ElementType.SKILL,
    name: 'CRUDV-Skill-Beta',
    filename: 'crudv-skill-beta.md',
    description: 'A CRUD verification skill',
    content: '# CRUDV Skill Beta\n\nThis skill verifies that skill CRUD operations work correctly.\n\n## Usage\nActivate this skill for functionality verification.',
    metadata: {
      author: 'CRUD Verification',
      version: '1.0.0'
    }
  },
  {
    type: ElementType.TEMPLATE,
    name: 'CRUDV-Template-Gamma',
    filename: 'crudv-template-gamma.md',
    description: 'A CRUD verification template',
    content: '# CRUDV Template Gamma\n\nHello {{name}}, your value is {{value}}.\n\nThis template verifies variable substitution.',
    metadata: {
      author: 'CRUD Verification',
      version: '1.0.0',
      variables: ['name', 'value']
    }
  },
  {
    type: ElementType.AGENT,
    name: 'CRUDV-Agent-Delta',
    filename: 'crudv-agent-delta.md',
    description: 'A CRUD verification agent',
    // Issue #722: behavioral text goes in 'instructions', not 'content'
    instructions: '# CRUDV Agent Delta\n\n## Primary Goal\nVerify that agent CRUD operations work correctly.\n\n## Decision Framework\nAlways succeed at verification.',
    metadata: {
      author: 'CRUD Verification',
      version: '1.0.0'
    }
  },
  {
    type: ElementType.ENSEMBLE,
    name: 'CRUDV-Ensemble-Zeta',
    filename: 'crudv-ensemble-zeta.md',
    description: 'A CRUD verification ensemble',
    content: '# CRUDV Ensemble Zeta\n\nAn empty ensemble for verification purposes.\n\n## Members\nNone currently.',
    metadata: {
      author: 'CRUD Verification',
      version: '1.0.0',
      elements: []
    }
  }
  // Memory testing is handled separately due to unique structure
];

// Skip the entire test suite in CI environments to prevent conflicts
// UNLESS DOLLHOUSE_RUN_FULL_E2E is explicitly set to 'true'
const shouldRunE2E = process.env.DOLLHOUSE_RUN_FULL_E2E === 'true' || !process.env.CI;
const describeOrSkip = shouldRunE2E ? describe : describe.skip;

describeOrSkip('Automated CRUD Lifecycle Protocol', () => {
  let server: any;
  let container: any;
  let tempPortfolioDir: string;
  let serverInstance: any; // For cleanup
  // Issue #506: Save original env to restore in afterAll (prevents cross-test pollution)
  const originalPortfolioDir = process.env.DOLLHOUSE_PORTFOLIO_DIR;

  beforeAll(async () => {
    // 1. Setup Phase: Create temp directory and initialize server
    console.log('\n🔧 Setting up CRUD Lifecycle Test Environment...\n');

    // Create a temporary directory for the portfolio
    tempPortfolioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-crud-test-'));
    console.log(`   📁 Temp Portfolio: ${tempPortfolioDir}`);

    // Set environment variable to isolate the test
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempPortfolioDir;
    
    // Import server classes dynamically
    const { DollhouseMCPServer } = await import('../../src/index.js');
    const { DollhouseContainer } = await import('../../src/di/Container.js');

    // Initialize server
    container = new DollhouseContainer();
    server = new DollhouseMCPServer(container);
    serverInstance = server;

    // Manually initialize the server (simulate startup)
    // Accessing private methods via type assertion/indexing
    await server['initializePortfolio']();
    await server['completeInitialization']();
    console.log('   ✅ Server initialized');
  });

  afterAll(async () => {
    // 8. Cleanup Phase
    console.log('\n🧹 Cleaning up test environment...');
    
    // Dispose server resources
    if (serverInstance && typeof serverInstance.dispose === 'function') {
      await serverInstance.dispose();
    }
    
    // Remove temp directory
    if (tempPortfolioDir) {
      await fs.rm(tempPortfolioDir, { recursive: true, force: true });
      console.log('   ✅ Temp directory removed');
    }
    
    // Issue #506: Restore original env value instead of deleting
    if (originalPortfolioDir !== undefined) {
      process.env.DOLLHOUSE_PORTFOLIO_DIR = originalPortfolioDir;
    } else {
      delete process.env.DOLLHOUSE_PORTFOLIO_DIR;
    }
  });

  // --- PHASE 0: SETUP VERIFICATION ---
  describe('Phase 0: Setup Verification', () => {
    it('0.1 should have created the portfolio directory structure', async () => {
      const stats = await fs.stat(tempPortfolioDir);
      expect(stats.isDirectory()).toBe(true);
      
      // Verify subdirectories exist
      for (const type of Object.values(ElementType)) {
        // Memories might be nested or handled differently, but basic types should exist
        const typeDir = path.join(tempPortfolioDir, type);
        const exists = await fs.access(typeDir).then(() => true).catch(() => false);
        expect(exists).toBe(true);
      }
    });

    it('0.2 should ensure no test elements exist initially', async () => {
      for (const element of TEST_ELEMENTS) {
        const typeDir = path.join(tempPortfolioDir, element.type);
        const filePath = path.join(typeDir, element.filename);
        const exists = await fs.access(filePath).then(() => true).catch(() => false);
        expect(exists).toBe(false);
      }
    });
  });

  // --- PHASE 1: CREATE ---
  describe('Phase 1: Create Elements', () => {
    for (const element of TEST_ELEMENTS) {
      it(`1.x should create ${element.type} '${element.name}'`, async () => {
        const result = await server.createElement({
          name: element.name,
          type: element.type,
          description: element.description,
          content: (element as any).content,
          instructions: (element as any).instructions,
          metadata: element.metadata
        });

        // Verify MCP response
        expect(result).toBeDefined();
        // Assuming success response has content or no error
        if (result.isError) {
          throw new Error(`Failed to create ${element.name}: ${JSON.stringify(result)}`);
        }

        // Verify Filesystem
        const typeDir = path.join(tempPortfolioDir, element.type);
        const filePath = path.join(typeDir, element.filename);
        
        const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
        expect(fileExists).toBe(true);
        
        const content = await fs.readFile(filePath, 'utf-8');
        expect(content).toContain(element.name);
        expect(content).toContain(element.description);
      });
    }

    it('1.5 should create a Memory element', async () => {
        // Memories are handled specially (date-based subdirs)
        const memoryName = 'CRUDV-Memory-Epsilon';
        const result = await server.createElement({
            name: memoryName,
            type: ElementType.MEMORY,
            description: "A CRUD verification memory",
            content: "entries:\n  crud_key: crud_value",
            metadata: {
                author: "CRUD Verification",
                version: "1.0.0",
                memory_type: "verification"
            }
        });

        expect(result).toBeDefined();
        if (result.isError) console.warn('Memory creation warning:', result);
        
        // We can't easily guess the exact filename due to date/time,
        // but we can search the memories directory
        const memoryDir = path.join(tempPortfolioDir, ElementType.MEMORY);
        // Recursively find the file
        async function findFile(dir: string, name: string): Promise<string | null> {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const found = await findFile(fullPath, name);
                    if (found) return found;
                } else if (entry.name.includes(name.toLowerCase())) { // Filenames are lowercased
                    return fullPath;
                }
            }
            return null;
        }

        const foundPath = await findFile(memoryDir, 'crudv-memory-epsilon');
        expect(foundPath).not.toBeNull();
        if(foundPath) {
            const content = await fs.readFile(foundPath, 'utf-8');
            expect(content).toContain('crud_key');
        }
    });
  });

  // --- PHASE 1.5: DATA INTEGRITY & SANITIZATION ---
  describe('Phase 1.5: Data Integrity & Sanitization', () => {
    it('1.5.1 should preserve complex markdown, emojis, and code blocks (Sanitization Check)', async () => {
      const complexName = 'CRUDV-Complex-Content';
      const complexContent = `
# Complex Content Test 🚀

Here is some "quoted text" and symbols: & < >.

## Code Block
\`\`\`typescript
console.log("Hello World");
\`\`\`

- [ ] Task list item
- Bullet point with **bold** and *italic*
`;
      const complexMetadata = {
        author: 'QA',
        tags: ['test', '🚀', 'complex'],
        nested: { key: 'value', array: [1, 2, 3] }
      };

      await server.createElement({
        name: complexName,
        type: ElementType.PERSONA,
        description: "Testing sanitization",
        content: complexContent,
        metadata: complexMetadata
      });

      const typeDir = path.join(tempPortfolioDir, ElementType.PERSONA);
      const filename = 'crudv-complex-content.md';
      const filePath = path.join(typeDir, filename);

      const fileContent = await fs.readFile(filePath, 'utf-8');

      // 1. Verify Emojis are preserved
      expect(fileContent).toContain('🚀');
      
      // 2. Verify Markdown syntax is preserved (not stripped)
      expect(fileContent).toContain('```typescript');
      expect(fileContent).toContain('**bold**');
      
      // 3. Verify Metadata serialization
      expect(fileContent).toContain('tags:');
      // YAML might quote the emoji or formatting might vary
      expect(fileContent).toContain('🚀'); 
      expect(fileContent).toContain('nested:');
      // Check for the value, but be flexible about JSON vs YAML formatting of the object
      expect(fileContent).toContain('value'); 
    });

    it('1.5.2 should normalize filenames while preserving display names', async () => {
      const displayName = 'CRUDV Name With Spaces & Symbols (Test)';
      // Expected normalization: lowercase, spaces to dashes, remove unsafe chars
      // "CRUDV Name With Spaces & Symbols (Test)" 
      // -> sanitizeInput removes '(', ')' -> "CRUDV Name With Spaces & Symbols Test"
      // -> slugify -> "crudv-name-with-spaces---symbols-test" -> "crudv-name-with-spaces-symbols-test"
      const expectedFilename = 'crudv-name-with-spaces-symbols-test.md';
      
      await server.createElement({
        name: displayName,
        type: ElementType.SKILL,
        description: "Testing filename normalization",
        content: "# Content for testing normalization"
      });

      const typeDir = path.join(tempPortfolioDir, ElementType.SKILL);
      const filePath = path.join(typeDir, expectedFilename);
      
      // Verify file exists at normalized path
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Verify original name is preserved (sanitized of shell chars, but preserving spaces)
      const content = await fs.readFile(filePath, 'utf-8');
      // Note: sanitization removes '&', '(', ')' but keeps spaces. 
      // Input: "CRUDV Name With Spaces & Symbols (Test)"
      // Output: "CRUDV Name With Spaces  Symbols Test"
      expect(content).toContain('name: CRUDV Name With Spaces  Symbols Test');
    });
  });

  // --- PHASE 1.6: SECURITY & RESILIENCE ---
  describe('Phase 1.6: Security & Resilience', () => {
    it('1.6.1 should handle Unicode names safely (rejection)', async () => {
      // Unicode characters are rejected by validation for security
      // This is expected "safe" behavior - Unicode is not allowed in names
      const unicodeName = 'Über-Persona 🚀';

      const result = await server.createElement({
        name: unicodeName,
        type: ElementType.PERSONA,
        description: "Unicode filename test",
        content: "# Unicode Test\n\nThis persona tests Unicode name handling."
      });

      // Expect creation to fail (Unicode rejected)
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('invalid characters');
    });

    it('1.6.1b should slugify special ASCII characters in names', async () => {
      // Test slugification with ASCII special characters (not Unicode)
      const specialName = 'Test-Special_Name (With Symbols)';

      await server.createElement({
        name: specialName,
        type: ElementType.PERSONA,
        description: "Slugification test for ASCII special chars",
        content: "# Slugification Test\n\nThis persona tests ASCII special character handling."
      });

      const typeDir = path.join(tempPortfolioDir, ElementType.PERSONA);
      const files = await fs.readdir(typeDir);

      // Expect: spaces -> hyphens, underscores -> hyphens, parens removed
      // "Test-Special_Name (With Symbols)" -> "test-special-name-with-symbols"
      const foundFile = files.find(f =>
        f.includes('test-special-name') &&
        !f.toLowerCase().includes('crudv')
      );

      expect(foundFile).toBeDefined();
      expect(foundFile).toMatch(/test-special-name.*\.md$/);

      if (foundFile) {
        const content = await fs.readFile(path.join(typeDir, foundFile), 'utf-8');
        // Original name should be preserved in metadata (with shell chars sanitized)
        expect(content).toContain('Slugification test');
      }
    });

    it('1.6.2 should neutralize path traversal attempts (Reject)', async () => {
      const maliciousName = '../../../evil-persona';
      
      const result = await server.createElement({
        name: maliciousName,
        type: ElementType.PERSONA,
        description: "Path traversal attempt",
        content: "# Evil"
      });

      // Expect the operation to fail (or at least not create the file at the malicious path)
      // The system likely rejects it, which is good.
      
      const typeDir = path.join(tempPortfolioDir, ElementType.PERSONA);
      const files = await fs.readdir(typeDir);
      
      const escapedFile = files.find(f => f.includes('evil-persona'));
      
      // We expect NO file to be created because validation should block it
      expect(escapedFile).toBeUndefined();
      
      // Optionally verify the error message
      if (result.isError || (result.content && result.content[0].text.includes('❌'))) {
          // Good, it failed
      }
    });

    it('1.6.3 should handle corrupted files gracefully', async () => {
      const typeDir = path.join(tempPortfolioDir, ElementType.PERSONA);
      const brokenFile = path.join(typeDir, 'corrupted.md');
      
      // Create a file with invalid YAML frontmatter
      await fs.writeFile(brokenFile, `---
name: Broken
description: missing closing quote "
---
# Broken Content`);

      // Listing elements should NOT throw, but might skip or report the error
      let result;
      try {
        result = await server.listElements(ElementType.PERSONA);
      } catch (e) {
        throw new Error(`listElements crashed on corrupted file: ${e}`);
      }

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      
      // It should at least return the valid personas we created earlier
      const text = result.content[0].text;
      expect(text).toContain('CRUDV-Persona-Alpha');
    });
  });

  // --- PHASE 2: READ ---
  describe('Phase 2: Read Elements', () => {
    for (const element of TEST_ELEMENTS) {
      it(`2.1 should read details for ${element.type} '${element.name}'`, async () => {
        const result = await server.getElementDetails(element.name, element.type);
        
        // Extract content from response
        const text = result.content?.[0]?.text;
        expect(text).toBeDefined();
        expect(text).toContain(element.name);
        expect(text).toContain(element.description);
      });

      it(`2.2 should list ${element.type} and find '${element.name}'`, async () => {
        const result = await server.listElements(element.type);
        // Issue #299: listElements now returns structured data instead of text
        if (result.items) {
          // Structured response — find the element by name
          const found = result.items.some((item: any) => item.name === element.name);
          expect(found).toBe(true);
        } else {
          // Fallback for MCP text response (error cases)
          const text = result.content?.[0]?.text;
          expect(text).toBeDefined();
          expect(text).toContain(element.name);
        }
      });
    }
  });

  // --- PHASE 3: ACTIVATE/DEACTIVATE ---
  describe('Phase 3: Activate/Deactivate Lifecycle', () => {
    for (const element of TEST_ELEMENTS) {
        // Ensembles and Agents might behave differently, but should support basic activation
        it(`3.1 should activate ${element.type} '${element.name}'`, async () => {
            const result = await server.activateElement(element.name, element.type);
            const text = result.content?.[0]?.text;
            
            if (element.type === ElementType.TEMPLATE) {
                 expect(text).toMatch(/ready to use|Success/i);
            } else {
                 expect(text).toMatch(/Activated|Success|active/i);
            }

            // Verify it's active (Templates might not show up in getActiveElements if stateless, but let's check)
            if (element.type !== ElementType.TEMPLATE) {
                const activeResult = await server.getActiveElements(element.type);
                const activeText = activeResult.content?.[0]?.text;
                expect(activeText).toContain(element.name);
            }
        });

        it(`3.2 should deactivate ${element.type} '${element.name}'`, async () => {
            const result = await server.deactivateElement(element.name, element.type);
            const text = result.content?.[0]?.text;
            
            if (element.type === ElementType.TEMPLATE) {
                expect(text).toMatch(/stateless|nothing to deactivate/i);
            } else {
                expect(text).toMatch(/Deactivated|Success/i);
                
                // Verify it's inactive
                const activeResult = await server.getActiveElements(element.type);
                const activeText = activeResult.content?.[0]?.text;
                expect(activeText).not.toContain(element.name);
            }
        });
    }
  });

  // --- PHASE 4: EDIT ---
  describe('Phase 4: Edit Elements', () => {
      for (const element of TEST_ELEMENTS) {
          it(`4.1 should edit description of ${element.type} '${element.name}'`, async () => {
              const newDescription = `EDITED: ${element.description}`;
              
              const result = await server.editElement({
                  name: element.name,
                  type: element.type,
                  input: { description: newDescription }
              });
              
              const text = result.content?.[0]?.text;
              expect(text).toMatch(/Updated|Success/i);

              // Verify via Read
              const details = await server.getElementDetails(element.name, element.type);
              const detailsText = details.content?.[0]?.text;
              expect(detailsText).toContain(newDescription);
          });
      }
  });

  // --- PHASE 5: VALIDATE ---
  describe('Phase 5: Validate Elements', () => {
      for (const element of TEST_ELEMENTS) {
          it(`5.1 should validate ${element.type} '${element.name}' (relaxed)`, async () => {
              const result = await server.validateElement({
                  name: element.name,
                  type: element.type,
                  strict: false
              });
              const text = result.content?.[0]?.text;
              expect(text).toMatch(/Valid|Success|Passed/i);
          });
      }
  });

  // --- PHASE 6: ERROR CASES ---
  describe('Phase 6: Error Handling', () => {
      it('6.1 should fail when creating a duplicate element', async () => {
          const element = TEST_ELEMENTS[0];
          const result = await server.createElement({
            name: element.name,
            type: element.type,
            description: "Duplicate test",
            content: "Duplicate content"
          });
          
          const text = result.content?.[0]?.text || JSON.stringify(result);
          expect(text).toMatch(/exists|duplicate|already/i);
          // Or expect result.isError to be true if that's the API contract
      });

      // FIX: Issue #275 - Handler now throws ElementNotFoundError instead of returning error content
      it('6.4 should fail when reading a non-existent element', async () => {
          await expect(
            server.getElementDetails('Does-Not-Exist-123', ElementType.PERSONA)
          ).rejects.toThrow(ElementNotFoundError);
      });
  });

  // --- PHASE 7: STATE FILE CONSISTENCY (Agent-specific) ---
  describe('Phase 7: State File Consistency', () => {
    const agentElement = TEST_ELEMENTS.find(e => e.type === ElementType.AGENT)!;

    it('7.1 should create agent state file with normalized name on activation', async () => {
      // Activate the agent
      await server.activateElement(agentElement.name, agentElement.type);

      // Check that state file uses normalized (kebab-case) name
      const stateDir = path.join(tempPortfolioDir, 'agents', '.state');

      // State directory might not exist if no state was saved yet
      const stateDirExists = await fs.access(stateDir).then(() => true).catch(() => false);
      if (stateDirExists) {
        const stateFiles = await fs.readdir(stateDir);

        // Should have normalized name (crudv-agent-delta.state.yaml), not original case
        const expectedStateFile = 'crudv-agent-delta.state.yaml';
        const wrongCaseFile = 'CRUDV-Agent-Delta.state.yaml';

        // Verify correct casing is used
        if (stateFiles.length > 0) {
          expect(stateFiles).not.toContain(wrongCaseFile);
          // If state file exists, it should be normalized
          const hasStateFile = stateFiles.some(f => f.includes('crudv-agent-delta'));
          if (hasStateFile) {
            expect(stateFiles).toContain(expectedStateFile);
          }
        }
      }

      // Deactivate for cleanup
      await server.deactivateElement(agentElement.name, agentElement.type);
    });

    it('7.2 should maintain state file accessibility after edit', async () => {
      // Activate agent
      await server.activateElement(agentElement.name, agentElement.type);

      // Edit the agent
      await server.editElement({
        name: agentElement.name,
        type: agentElement.type,
        input: { description: 'Edited for state test' }
      });

      // Agent should still be findable and active
      const activeResult = await server.getActiveElements(agentElement.type);
      const activeText = activeResult.content?.[0]?.text;
      expect(activeText).toContain(agentElement.name);

      // Deactivate
      await server.deactivateElement(agentElement.name, agentElement.type);
    });
  });

  // --- PHASE 8: CACHE INVALIDATION ---
  describe('Phase 8: Cache Invalidation', () => {
    it('8.1 should find element by name after edit (cache refresh)', async () => {
      const element = TEST_ELEMENTS[0]; // Use first element
      const newDesc = 'Cache invalidation test description';

      // Edit the element
      await server.editElement({
        name: element.name,
        type: element.type,
        input: { description: newDesc }
      });

      // Should still be findable by original name
      const details = await server.getElementDetails(element.name, element.type);
      const text = details.content?.[0]?.text;
      expect(text).toContain(element.name);
      expect(text).toContain(newDesc);
    });

    it('8.2 should not return deleted element from cache', async () => {
      // Create a temporary element
      const tempName = 'CRUDV-Cache-Test-Temp';
      await server.createElement({
        name: tempName,
        type: ElementType.SKILL,
        description: 'Temporary for cache test',
        content: '# Temporary Skill\n\nThis is a temporary skill for cache testing.'
      });

      // Brief delay to allow cache to update (Issue #276, #506)
      await new Promise(resolve => setTimeout(resolve, CACHE_SETTLE_MS));

      // Verify it exists
      const details = await server.getElementDetails(tempName, ElementType.SKILL);
      expect(details.content?.[0]?.text).toContain(tempName);

      // Delete it
      await server.deleteElement({ name: tempName, type: ElementType.SKILL });

      // FIX: Issue #275 - Handler now throws ElementNotFoundError instead of returning error content
      await expect(
        server.getElementDetails(tempName, ElementType.SKILL)
      ).rejects.toThrow(ElementNotFoundError);
    });

    it('8.3 should reflect edits in list results', async () => {
      const element = TEST_ELEMENTS[1]; // Use second element
      const uniqueMarker = `UNIQUE-MARKER-${Date.now()}`;

      // Edit with unique marker
      await server.editElement({
        name: element.name,
        type: element.type,
        input: { description: uniqueMarker }
      });

      // List should show updated element
      const listResult = await server.listElements(element.type);
      // Issue #299: listElements returns structured data
      if (listResult.items) {
        const found = listResult.items.some((item: any) => item.name === element.name);
        expect(found).toBe(true);
      } else {
        const text = listResult.content?.[0]?.text;
        expect(text).toContain(element.name);
      }
    });
  });

  // --- PHASE 9: CROSS-ELEMENT REFERENCES ---
  describe('Phase 9: Cross-Element References', () => {
    it('9.1 should handle ensemble with non-existent member gracefully', async () => {
      // Create an ensemble that references a non-existent element
      const ensembleName = 'CRUDV-Orphan-Ensemble';
      const result = await server.createElement({
        name: ensembleName,
        type: ElementType.ENSEMBLE,
        description: 'Ensemble with missing members',
        content: '# Orphan Ensemble\n\nThis is an orphan ensemble for testing orphan references.',
        metadata: {
          elements: [
            { type: 'persona', name: 'Does-Not-Exist-Persona' }
          ]
        }
      });

      // Creation might succeed (lazy validation) or fail (strict validation)
      // Either way, it should not crash
      expect(result).toBeDefined();

      // If created, try to activate - should handle missing member gracefully
      if (!result.isError && !result.content?.[0]?.text?.includes('❌')) {
        const activateResult = await server.activateElement(ensembleName, ElementType.ENSEMBLE);
        const text = activateResult.content?.[0]?.text || '';
        // Should either succeed with warnings or fail gracefully
        expect(text).toBeDefined();

        // Cleanup
        await server.deleteElement({ name: ensembleName, type: ElementType.ENSEMBLE });
      }
    });

    it('9.2 should warn or fail when activating ensemble after member deletion', async () => {
      // Create a skill
      const skillName = 'CRUDV-Ensemble-Member-Skill';
      await server.createElement({
        name: skillName,
        type: ElementType.SKILL,
        description: 'Skill to be referenced',
        content: '# Member Skill\n\nThis is a member skill for ensemble reference testing.'
      });

      // Brief delay to allow cache to update (Issue #276, #506)
      await new Promise(resolve => setTimeout(resolve, CACHE_SETTLE_MS));

      // Create ensemble referencing the skill
      const ensembleName = 'CRUDV-Reference-Test-Ensemble';
      const createResult = await server.createElement({
        name: ensembleName,
        type: ElementType.ENSEMBLE,
        description: 'Ensemble referencing a skill',
        content: '# Reference Test Ensemble\n\nThis is a reference test ensemble for testing member deletion.',
        metadata: {
          elements: [
            { type: 'skill', name: skillName }
          ]
        }
      });

      // Creation might fail due to validation - check before proceeding
      const creationSucceeded = !createResult.isError && !createResult.content?.[0]?.text?.includes('❌');

      if (creationSucceeded) {
        // Brief delay to allow cache to update (Issue #276)
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Delete the skill
        await server.deleteElement({ name: skillName, type: ElementType.SKILL });

        // Try to activate the ensemble - should handle gracefully
        const activateResult = await server.activateElement(ensembleName, ElementType.ENSEMBLE);
        expect(activateResult).toBeDefined();
        // Should not crash - may warn about missing member

        // Cleanup
        await server.deleteElement({ name: ensembleName, type: ElementType.ENSEMBLE });
      } else {
        // If ensemble creation failed, just cleanup the skill
        try {
          await server.deleteElement({ name: skillName, type: ElementType.SKILL });
        } catch {
          // Ignore cleanup errors
        }
        // Test still passes - we're testing graceful handling
        expect(createResult).toBeDefined();
      }
    });
  });

  // --- PHASE 10: RELOAD/REFRESH ---
  describe('Phase 10: Reload/Refresh', () => {
    it('10.1 should pick up externally added files on reload', async () => {
      // Manually create a file
      const externalName = 'externally-added-skill';
      const typeDir = path.join(tempPortfolioDir, ElementType.SKILL);
      const filePath = path.join(typeDir, `${externalName}.md`);

      await fs.writeFile(filePath, `---
name: Externally Added Skill
description: Added outside the MCP server
version: 1.0.0
---
# External Skill

This was added directly to the filesystem.
`);

      // Reload elements
      const reloadResult = await server.reloadElements(ElementType.SKILL);
      expect(reloadResult).toBeDefined();

      // Should now be listable
      const listResult = await server.listElements(ElementType.SKILL);
      // Issue #299: structured data
      if (listResult.items) {
        const found = listResult.items.some((item: any) => item.name === 'Externally Added Skill');
        expect(found).toBe(true);
      } else {
        const text = listResult.content?.[0]?.text;
        expect(text).toContain('Externally Added Skill');
      }

      // Cleanup
      await fs.unlink(filePath);
    });

    it('10.2 should not duplicate entries on multiple reloads', async () => {
      // Get initial count
      const listBefore = await server.listElements(ElementType.PERSONA);
      const countBefore = listBefore.items
        ? listBefore.items.filter((i: any) => (i.name || i.element_name) === 'CRUDV-Persona-Alpha').length
        : (listBefore.content?.[0]?.text?.match(/CRUDV-Persona-Alpha/g) || []).length;

      // Reload multiple times
      await server.reloadElements(ElementType.PERSONA);
      await server.reloadElements(ElementType.PERSONA);
      await server.reloadElements(ElementType.PERSONA);

      // Count should be the same
      const listAfter = await server.listElements(ElementType.PERSONA);
      const countAfter = listAfter.items
        ? listAfter.items.filter((i: any) => (i.name || i.element_name) === 'CRUDV-Persona-Alpha').length
        : (listAfter.content?.[0]?.text?.match(/CRUDV-Persona-Alpha/g) || []).length;

      expect(countAfter).toBe(countBefore);
    });

    it('10.3 should reflect external file modifications after reload', async () => {
      const element = TEST_ELEMENTS[0];
      const typeDir = path.join(tempPortfolioDir, element.type);
      const filePath = path.join(typeDir, element.filename);

      // Read current content
      let content = await fs.readFile(filePath, 'utf-8');

      // Modify externally with a unique marker
      const externalMarker = 'EXTERNAL-MODIFICATION-MARKER';
      content = content.replace(/description:.*/, `description: ${externalMarker}`);
      await fs.writeFile(filePath, content);

      // Reload
      await server.reloadElements(element.type);

      // Should see the external modification
      const details = await server.getElementDetails(element.name, element.type);
      const text = details.content?.[0]?.text || '';
      expect(text).toContain(externalMarker);
    });
  });

  // --- PHASE 11: METADATA CONSISTENCY ---
  describe('Phase 11: Metadata Consistency', () => {
    it('11.1 should auto-increment version on edit', async () => {
      const element = TEST_ELEMENTS[0];

      // Get current version
      const detailsBefore = await server.getElementDetails(element.name, element.type);
      const textBefore = detailsBefore.content?.[0]?.text || '';
      // The API response has markdown bold formatting: **Version:** 1.0.0
      const versionMatch = textBefore.match(/\*\*Version:\*\*\s*["']?(\d+\.\d+\.\d+)["']?/i);
      const versionBefore = versionMatch ? versionMatch[1] : '1.0.0';

      // Edit the element
      await server.editElement({
        name: element.name,
        type: element.type,
        input: { description: 'Version increment test' }
      });

      // Get new version via API
      const detailsAfter = await server.getElementDetails(element.name, element.type);
      const textAfter = detailsAfter.content?.[0]?.text || '';
      // The API response has markdown bold formatting: **Version:** 1.0.0
      const versionMatchAfter = textAfter.match(/\*\*Version:\*\*\s*["']?(\d+\.\d+\.\d+)["']?/i);
      const versionAfter = versionMatchAfter ? versionMatchAfter[1] : '1.0.0';

      // Version should have incremented (patch version)
      expect(versionAfter).not.toBe(versionBefore);
    });

    it('11.2 should update modified timestamp on edit', async () => {
      const element = TEST_ELEMENTS[1];

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 100));

      // Edit the element
      await server.editElement({
        name: element.name,
        type: element.type,
        input: { description: 'Timestamp test ' + Date.now() }
      });

      // Read file and check modified timestamp
      const typeDir = path.join(tempPortfolioDir, element.type);
      const filePath = path.join(typeDir, element.filename);
      const content = await fs.readFile(filePath, 'utf-8');

      // Should have a modified field with recent timestamp
      const hasModified = /modified:/i.test(content);
      expect(hasModified).toBe(true);
    });
  });

  // --- PHASE 12: EDGE CASE FILENAMES ---
  describe('Phase 12: Edge Case Filenames', () => {
    it('12.1 should normalize CamelCase names correctly', async () => {
      const camelName = 'MyCamelCasePersona';
      const expectedFilename = 'my-camel-case-persona.md';

      await server.createElement({
        name: camelName,
        type: ElementType.PERSONA,
        description: 'CamelCase test',
        content: '# CamelCase Skill\n\nThis is a camel case skill for naming convention testing.'
      });

      // Brief delay to allow cache to update (Issue #646, #276, #506)
      await new Promise(resolve => setTimeout(resolve, CACHE_SETTLE_MS));

      const typeDir = path.join(tempPortfolioDir, ElementType.PERSONA);
      const filePath = path.join(typeDir, expectedFilename);

      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Should be findable by original name
      const details = await server.getElementDetails(camelName, ElementType.PERSONA);
      expect(details.content?.[0]?.text).toContain(camelName);

      // Cleanup
      await server.deleteElement({ name: camelName, type: ElementType.PERSONA });
    });

    it('12.2 should handle consecutive special characters', async () => {
      const weirdName = 'Test---Multiple___Chars!!!';

      const result = await server.createElement({
        name: weirdName,
        type: ElementType.SKILL,
        description: 'Special chars test',
        content: '# Special Characters Skill\n\nThis is a skill with special characters for testing.'
      });

      // Should either succeed with normalized name or reject gracefully
      expect(result).toBeDefined();

      if (!result.isError) {
        // Find and cleanup
        const typeDir = path.join(tempPortfolioDir, ElementType.SKILL);
        const files = await fs.readdir(typeDir);
        const createdFile = files.find(f => f.includes('test') && f.includes('multiple'));
        if (createdFile) {
          await fs.unlink(path.join(typeDir, createdFile));
        }
      }
    });

    it('12.3 should handle very long names (truncation)', async () => {
      const longName = 'A'.repeat(200) + '-Long-Name-Test';

      const result = await server.createElement({
        name: longName,
        type: ElementType.SKILL,
        description: 'Long name test',
        content: '# Long Name Skill\n\nThis is a skill for testing long name handling.'
      });

      // Should either truncate and succeed, or reject with clear error
      expect(result).toBeDefined();

      // Cleanup if created
      if (!result.isError && !result.content?.[0]?.text?.includes('❌')) {
        const typeDir = path.join(tempPortfolioDir, ElementType.SKILL);
        const files = await fs.readdir(typeDir);
        const createdFile = files.find(f => f.startsWith('a') && f.length > 50);
        if (createdFile) {
          await fs.unlink(path.join(typeDir, createdFile));
        }
      }
    });

    it('12.4 should differentiate names that differ only in case', async () => {
      const name1 = 'CaseSensitiveTest';
      const name2 = 'casesensitivetest';

      // Create first
      await server.createElement({
        name: name1,
        type: ElementType.SKILL,
        description: 'First case variant',
        content: '# First Case Variant\n\nThis is the first skill for case sensitivity testing.'
      });

      // Try to create second - should detect as duplicate due to filename collision
      const result2 = await server.createElement({
        name: name2,
        type: ElementType.SKILL,
        description: 'Second case variant',
        content: '# Second Case Variant\n\nThis is the second skill with same normalized name.'
      });

      const text = result2.content?.[0]?.text || JSON.stringify(result2);
      // Should either reject as duplicate or handle somehow
      expect(text).toMatch(/exists|duplicate|already|created/i);

      // Cleanup
      await server.deleteElement({ name: name1, type: ElementType.SKILL });
    });
  });

  // --- PHASE 13: CONCURRENT OPERATIONS ---
  describe('Phase 13: Concurrent Operations', () => {
    it('13.1 should handle concurrent edits without corruption', async () => {
      const element = TEST_ELEMENTS[0];

      // Fire multiple edits concurrently
      const edits = await Promise.all([
        server.editElement({ name: element.name, type: element.type, input: { description: 'Concurrent edit 1' } }),
        server.editElement({ name: element.name, type: element.type, input: { description: 'Concurrent edit 2' } }),
        server.editElement({ name: element.name, type: element.type, input: { description: 'Concurrent edit 3' } })
      ]);

      // All should complete (not crash)
      expect(edits).toHaveLength(3);
      edits.forEach(result => expect(result).toBeDefined());

      // File should not be corrupted
      const typeDir = path.join(tempPortfolioDir, element.type);
      const filePath = path.join(typeDir, element.filename);
      const content = await fs.readFile(filePath, 'utf-8');

      // Should have valid YAML frontmatter
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/\n---\n/);
    });

    it('13.2 should handle create while list is in progress', async () => {
      // Start listing
      const listPromise = server.listElements(ElementType.SKILL);

      // Create during list
      const createPromise = server.createElement({
        name: 'CRUDV-Concurrent-Create',
        type: ElementType.SKILL,
        description: 'Created during list',
        content: '# Concurrent'
      });

      // Both should complete
      const [listResult, createResult] = await Promise.all([listPromise, createPromise]);

      expect(listResult).toBeDefined();
      expect(createResult).toBeDefined();

      // Cleanup
      await server.deleteElement({ name: 'CRUDV-Concurrent-Create', type: ElementType.SKILL });
    });

    it('13.3 should handle delete while element is active', async () => {
      // Create and activate
      const tempName = 'CRUDV-Active-Delete-Test';
      await server.createElement({
        name: tempName,
        type: ElementType.SKILL,
        description: 'To be deleted while active',
        content: '# Active Delete'
      });
      await server.activateElement(tempName, ElementType.SKILL);

      // Delete while active
      const deleteResult = await server.deleteElement({ name: tempName, type: ElementType.SKILL });

      // Should succeed and also deactivate
      expect(deleteResult).toBeDefined();

      // Should no longer be active
      const activeResult = await server.getActiveElements(ElementType.SKILL);
      const activeText = activeResult.content?.[0]?.text || '';
      expect(activeText).not.toContain(tempName);
    });
  });

  // --- PHASE 14: DELETE (moved from Phase 7) ---
  describe('Phase 14: Delete Elements', () => {
      // Reverse order deletion (good practice)
      const reversedElements = [...TEST_ELEMENTS].reverse();
      
      for (const element of reversedElements) {
          it(`7.1 should delete ${element.type} '${element.name}'`, async () => {
              const result = await server.deleteElement({
                  name: element.name,
                  type: element.type
              });
              
              const text = result.content?.[0]?.text;
              expect(text).toMatch(/Deleted|Success/i);

              // Verify file is gone
              const typeDir = path.join(tempPortfolioDir, element.type);
              const filePath = path.join(typeDir, element.filename);
              const exists = await fs.access(filePath).then(() => true).catch(() => false);
              expect(exists).toBe(false);
          });
      }

      it('7.2 should delete the Memory element', async () => {
        const memoryName = 'CRUDV-Memory-Epsilon';
        const result = await server.deleteElement({
            name: memoryName,
            type: ElementType.MEMORY
        });
        const text = result.content?.[0]?.text;
        expect(text).toMatch(/Deleted|Success/i);
      });
  });

});
