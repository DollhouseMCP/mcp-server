/**
 * Integration tests for create_element with varying content lengths (#1726)
 *
 * Reproduces the bug where create_element fails with longer content strings.
 * Tests ramp up content size to find the exact threshold where parsing breaks.
 *
 * Test layers:
 * 1. parseOperationInput() — pure validation logic
 * 2. MCPAQLHandler.handleCreate() — full handler with gatekeeper
 * 3. Malformed input patterns — simulates LLM mis-structuring with long content
 *
 * @see https://github.com/DollhouseMCP/mcp-server/issues/1726
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DollhouseMCPServer } from '../../../src/index.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { MCPAQLHandler } from '../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import { parseOperationInput, isOperationInput } from '../../../src/handlers/mcp-aql/types.js';
import { createPortfolioTestEnvironment, preConfirmAllOperations, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';
import path from 'path';
import fs from 'fs/promises';

// Content generators for different test scenarios
function generatePlainContent(charCount: number): string {
  return 'x'.repeat(charCount);
}

function generateMarkdownContent(approximateLength: number): string {
  const block = `# Section Title

## Subsection

This is a paragraph with **bold**, *italic*, and \`inline code\`. It includes
[links](https://example.com) and various markdown formatting.

- List item one with details
- List item two with more details
- List item three

\`\`\`typescript
function example(): void {
  const data = { key: "value", nested: { deep: true } };
  console.log(JSON.stringify(data, null, 2));
}
\`\`\`

> A blockquote with some wisdom about templates and their usage patterns.

| Column A | Column B | Column C |
|----------|----------|----------|
| Data 1   | Data 2   | Data 3   |

---

`;
  const repeats = Math.ceil(approximateLength / block.length);
  return block.repeat(repeats).slice(0, approximateLength);
}

function generateContentWithSpecialChars(approximateLength: number): string {
  const block = `Content with "quotes", 'apostrophes', <angles>, &ampersands,
backslash\\paths, newlines\n\ttabs, unicode: em—dash, curly "quotes",
braces {obj: [arr]}, dollar $var, backtick \`code\`, pipe |col|,
hash #heading, asterisk *bold*, underscore _italic_, tilde ~strike~\n\n`;
  const repeats = Math.ceil(approximateLength / block.length);
  return block.repeat(repeats).slice(0, approximateLength);
}

// ============================================================================
// Layer 1: parseOperationInput() — Pure Validation
// ============================================================================

describe('Issue #1726: create_element with long content', () => {
  describe('Layer 1: parseOperationInput validation', () => {
    const contentSizes = [50, 100, 200, 300, 400, 500, 750, 1000, 2000, 5000, 10000, 50000];

    describe.each(contentSizes)('plain content at %i chars', (size) => {
      it('should parse successfully', () => {
        const input = {
          operation: 'create_element',
          element_type: 'template',
          params: {
            element_name: `test-${size}`,
            description: 'Test template',
            content: generatePlainContent(size),
          },
        };
        const result = parseOperationInput(input);
        expect(result).not.toBeNull();
        expect(result!.operation).toBe('create_element');
      });
    });

    describe.each(contentSizes)('markdown content at ~%i chars', (size) => {
      it('should parse successfully', () => {
        const input = {
          operation: 'create_element',
          element_type: 'template',
          params: {
            element_name: `test-md-${size}`,
            description: 'Test template with markdown',
            content: generateMarkdownContent(size),
          },
        };
        const result = parseOperationInput(input);
        expect(result).not.toBeNull();
        expect(result!.operation).toBe('create_element');
      });
    });

    describe.each(contentSizes)('special char content at ~%i chars', (size) => {
      it('should parse successfully', () => {
        const input = {
          operation: 'create_element',
          element_type: 'template',
          params: {
            element_name: `test-special-${size}`,
            description: 'Test with special characters',
            content: generateContentWithSpecialChars(size),
          },
        };
        const result = parseOperationInput(input);
        expect(result).not.toBeNull();
        expect(result!.operation).toBe('create_element');
      });
    });

    it('should parse all 6 element types with 5000-char content', () => {
      const types = ['persona', 'skill', 'template', 'agent', 'memory', 'ensemble'];
      const content = generateMarkdownContent(5000);

      for (const type of types) {
        const input = {
          operation: 'create_element',
          element_type: type,
          params: {
            element_name: `long-${type}`,
            description: `Long content ${type}`,
            content,
          },
        };
        const result = parseOperationInput(input);
        expect(result).not.toBeNull();
      }
    });

    it('should parse plural element_type forms with long content', () => {
      const types = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
      const content = generateMarkdownContent(5000);

      for (const type of types) {
        const input = {
          operation: 'create_element',
          element_type: type,
          params: {
            element_name: `plural-${type}`,
            description: `Plural type ${type}`,
            content,
          },
        };
        const result = parseOperationInput(input);
        expect(result).not.toBeNull();
      }
    });
  });

  // ============================================================================
  // Layer 2: MCPAQLHandler.handleCreate() — Full Handler
  // ============================================================================

  describe('Layer 2: handleCreate full handler', () => {
    let env: PortfolioTestEnvironment;
    let container: DollhouseContainer;
    let server: DollhouseMCPServer;
    let mcpAqlHandler: MCPAQLHandler;

    beforeEach(async () => {
      env = await createPortfolioTestEnvironment('create-long-content');
      container = new DollhouseContainer();
      server = new DollhouseMCPServer(container);
      await server.listPersonas();
      preConfirmAllOperations(container);
      mcpAqlHandler = container.resolve<MCPAQLHandler>('mcpAqlHandler');
    });

    afterEach(async () => {
      await server.dispose();
      await env.cleanup();
    });

    const handlerSizes = [100, 500, 1000, 2000, 5000];

    describe.each(handlerSizes)('create template with %i char content', (size) => {
      it('should succeed through the full handler', async () => {
        const content = generateMarkdownContent(size);
        const result = await mcpAqlHandler.handleCreate({
          operation: 'create_element',
          element_type: 'template',
          params: {
            element_name: `handler-test-${size}`,
            description: `Template with ${size} chars`,
            content,
          },
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toBeDefined();
        }

        // Verify the file was written with full content
        const filePath = path.join(env.testDir, 'templates', `handler-test-${size}.md`);
        const fileContent = await fs.readFile(filePath, 'utf-8');
        // Content should contain at least a significant portion of what we sent
        expect(fileContent.length).toBeGreaterThan(size / 2);
      });
    });

    it('should create a skill with 5000-char content', async () => {
      const content = generateMarkdownContent(5000);
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'skill',
        params: {
          element_name: 'long-skill',
          description: 'A skill with substantial content',
          content,
        },
      });

      expect(result.success).toBe(true);
    });

    it('should create a persona with 5000-char content', async () => {
      const content = generateMarkdownContent(5000);
      const result = await mcpAqlHandler.handleCreate({
        operation: 'create_element',
        element_type: 'persona',
        params: {
          element_name: 'long-persona',
          description: 'A persona with substantial content',
          content,
        },
      });

      expect(result.success).toBe(true);
    });
  });

  // ============================================================================
  // Layer 3: Malformed Input Patterns — Simulates LLM Mis-structuring
  // ============================================================================

  describe('Layer 3: LLM malformed input patterns with long content', () => {
    const longContent = generateMarkdownContent(2000);

    it('should handle content at top level instead of inside params', () => {
      // LLM might flatten the structure when content is long
      const input = {
        operation: 'create_element',
        element_type: 'template',
        element_name: 'misplaced',
        description: 'Misplaced fields',
        content: longContent,
        params: {},
      };
      const result = parseOperationInput(input);
      // This should parse (it has operation + element_type + params as object)
      // but the handler should still handle it gracefully
      expect(result).not.toBeNull();
    });

    it('should handle params as a JSON string instead of object', () => {
      // LLM might stringify params when content is very long
      const input = {
        operation: 'create_element',
        element_type: 'template',
        params: JSON.stringify({
          element_name: 'stringified',
          description: 'Stringified params',
          content: longContent,
        }),
      };
      // params is a string, not an object — isOperationInput should reject
      const result = parseOperationInput(input);
      // This SHOULD fail because params is a string
      expect(result).toBeNull();
    });

    it('should handle double-wrapped params', () => {
      // LLM might double-wrap params
      const input = {
        operation: 'create_element',
        element_type: 'template',
        params: {
          params: {
            element_name: 'double-wrapped',
            description: 'Double wrapped params',
            content: longContent,
          },
        },
      };
      const result = parseOperationInput(input);
      // Structure is valid (params is an object) even though semantics are wrong
      expect(result).not.toBeNull();
    });

    it('should handle content with unescaped JSON characters', () => {
      const trickyContent = '{"key": "value"}\n' +
        'Line with "quotes" and \\backslashes\\\n'.repeat(50) +
        'Content: {nested: {deep: [1,2,3]}}\n'.repeat(50);

      const input = {
        operation: 'create_element',
        element_type: 'template',
        params: {
          element_name: 'tricky-json',
          description: 'Content that looks like JSON',
          content: trickyContent,
        },
      };
      const result = parseOperationInput(input);
      expect(result).not.toBeNull();
    });

    it('should handle content with newlines and control characters', () => {
      const content = 'Line 1\nLine 2\rLine 3\r\nLine 4\tTabbed\n'.repeat(100);
      const input = {
        operation: 'create_element',
        element_type: 'template',
        params: {
          element_name: 'control-chars',
          description: 'Content with control characters',
          content,
        },
      };
      const result = parseOperationInput(input);
      expect(result).not.toBeNull();
    });

    it('should handle element_type in params instead of top level with long content', () => {
      // LLM might put element_type inside params instead of at top level
      const input = {
        operation: 'create_element',
        params: {
          element_type: 'template',
          element_name: 'type-in-params',
          description: 'Type moved inside params',
          content: longContent,
        },
      };
      const result = parseOperationInput(input);
      // Should still parse — operation is present, no invalid element_type at top level
      expect(result).not.toBeNull();
    });

    it('should handle missing operation with long content', () => {
      const input = {
        element_type: 'template',
        params: {
          element_name: 'no-operation',
          description: 'Missing operation field',
          content: longContent,
        },
      };
      const result = parseOperationInput(input);
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Layer 4: JSON round-trip stress test
  // ============================================================================

  describe('Layer 4: JSON serialization round-trip', () => {
    const sizes = [100, 500, 1000, 5000, 10000, 50000, 100000];

    describe.each(sizes)('round-trip at %i chars', (size) => {
      it('should survive JSON.stringify -> JSON.parse', () => {
        const input = {
          operation: 'create_element',
          element_type: 'template',
          params: {
            element_name: `roundtrip-${size}`,
            description: 'Round-trip test',
            content: generateMarkdownContent(size),
          },
        };

        // Simulate MCP protocol: serialize and deserialize
        const serialized = JSON.stringify(input);
        const deserialized = JSON.parse(serialized);

        expect(isOperationInput(deserialized)).toBe(true);
        const parsed = parseOperationInput(deserialized);
        expect(parsed).not.toBeNull();
        expect(parsed!.operation).toBe('create_element');
      });
    });

    it('should handle content that contains the MCP JSON-RPC framing', () => {
      // Content that might confuse a naive parser looking for JSON boundaries
      const content = '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"mcp_aql_create","arguments":{"operation":"create_element"}}}\n'.repeat(20);

      const input = {
        operation: 'create_element',
        element_type: 'template',
        params: {
          element_name: 'jsonrpc-content',
          description: 'Content mimicking MCP protocol',
          content,
        },
      };

      const serialized = JSON.stringify(input);
      const deserialized = JSON.parse(serialized);
      const parsed = parseOperationInput(deserialized);
      expect(parsed).not.toBeNull();
    });
  });
});
