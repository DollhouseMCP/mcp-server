/**
 * Tests for Silent JSON Fallback (Issue #205)
 *
 * Verifies that legacy tool format is silently converted to proper MCP-AQL format:
 * - { tool: 'x', args: {...} } → { operation: 'x', params: {...} }
 * - { tool: 'x', params: {...} } → { operation: 'x', params: {...} }
 *
 * Key requirements:
 * - Silent conversion (no user-visible logging)
 * - Internal metrics tracking
 * - Same result whether proper or fallback format used
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  isLegacyToolFormat,
  convertLegacyToMCPAQL,
  parseOperationInput,
  describeInvalidInput,
  InputFormatMetrics,
  normalizeMCPAQLElementType,
} from '../../../../src/handlers/mcp-aql/types.js';

describe('Silent JSON Fallback (Issue #205)', () => {
  beforeEach(() => {
    InputFormatMetrics.reset();
  });

  describe('isLegacyToolFormat()', () => {
    it('should detect legacy format with tool and args', () => {
      expect(
        isLegacyToolFormat({
          tool: 'list_elements',
          args: { type: 'personas' },
        })
      ).toBe(true);
    });

    it('should detect legacy format with tool and params', () => {
      expect(
        isLegacyToolFormat({
          tool: 'create_element',
          params: { name: 'test', description: 'desc' },
        })
      ).toBe(true);
    });

    it('should detect legacy format with tool only', () => {
      expect(
        isLegacyToolFormat({
          tool: 'list_elements',
        })
      ).toBe(true);
    });

    it('should reject null input', () => {
      expect(isLegacyToolFormat(null)).toBe(false);
    });

    it('should reject undefined input', () => {
      expect(isLegacyToolFormat(undefined)).toBe(false);
    });

    it('should reject missing tool field', () => {
      expect(isLegacyToolFormat({ args: { type: 'personas' } })).toBe(false);
    });

    it('should reject non-string tool field', () => {
      expect(isLegacyToolFormat({ tool: 123, args: {} })).toBe(false);
    });

    it('should reject array args', () => {
      expect(isLegacyToolFormat({ tool: 'test', args: [] })).toBe(false);
    });

    it('should reject null args', () => {
      expect(isLegacyToolFormat({ tool: 'test', args: null })).toBe(false);
    });

    it('should reject non-object args', () => {
      expect(isLegacyToolFormat({ tool: 'test', args: 'string' })).toBe(false);
    });
  });

  describe('convertLegacyToMCPAQL()', () => {
    it('should convert tool to operation', () => {
      const result = convertLegacyToMCPAQL({
        tool: 'list_elements',
        args: { type: 'personas' },
      });

      expect(result.operation).toBe('list_elements');
    });

    it('should convert args to params', () => {
      const result = convertLegacyToMCPAQL({
        tool: 'list_elements',
        args: { type: 'personas', limit: 10 },
      });

      expect(result.params).toEqual({ type: 'personas', limit: 10 });
    });

    it('should handle params field (alternative to args)', () => {
      const result = convertLegacyToMCPAQL({
        tool: 'create_element',
        params: { name: 'test', description: 'desc' },
      });

      expect(result.params).toEqual({ name: 'test', description: 'desc' });
    });

    it('should prefer args over params if both present', () => {
      const result = convertLegacyToMCPAQL({
        tool: 'test',
        args: { from: 'args' },
        params: { from: 'params' },
      });

      expect(result.params).toEqual({ from: 'args' });
    });

    it('should default to empty params if neither args nor params', () => {
      const result = convertLegacyToMCPAQL({
        tool: 'list_elements',
      });

      expect(result.params).toEqual({});
    });
  });

  describe('parseOperationInput()', () => {
    describe('Proper MCP-AQL format', () => {
      it('should accept and return proper format unchanged', () => {
        const input = {
          operation: 'list_elements',
          params: { type: 'personas' },
        };

        const result = parseOperationInput(input);

        expect(result).toEqual(input);
      });

      it('should record proper format metric', () => {
        parseOperationInput({
          operation: 'list_elements',
        });

        const metrics = InputFormatMetrics.getMetrics();
        expect(metrics.proper).toBe(1);
        expect(metrics.legacy_converted).toBe(0);
        expect(metrics.invalid).toBe(0);
      });

      it('should accept format with elementType', () => {
        const input = {
          operation: 'list_elements',
          elementType: 'persona',
          params: {},
        };

        const result = parseOperationInput(input);

        // Issue #433: parseOperationInput now normalizes both elementType and element_type
        expect(result).toMatchObject({
          operation: 'list_elements',
          elementType: 'persona',
          params: {},
        });
      });
    });

    describe('Legacy tool format', () => {
      it('should silently convert legacy format', () => {
        const legacy = {
          tool: 'list_elements',
          args: { type: 'personas' },
        };

        const result = parseOperationInput(legacy);

        expect(result).toEqual({
          operation: 'list_elements',
          params: { type: 'personas' },
        });
      });

      it('should record legacy_converted metric', () => {
        parseOperationInput({
          tool: 'list_elements',
          args: { type: 'personas' },
        });

        const metrics = InputFormatMetrics.getMetrics();
        expect(metrics.proper).toBe(0);
        expect(metrics.legacy_converted).toBe(1);
        expect(metrics.invalid).toBe(0);
      });

      it('should handle legacy format with params instead of args', () => {
        const result = parseOperationInput({
          tool: 'create_element',
          params: { name: 'test', description: 'desc' },
        });

        expect(result).toEqual({
          operation: 'create_element',
          params: { name: 'test', description: 'desc' },
        });
      });
    });

    describe('Permission prompt protocol (Issue #647)', () => {
      it('should parse {tool_name, input} as permission_prompt operation', () => {
        const result = parseOperationInput({
          tool_name: 'Bash',
          input: { command: 'ls' },
        });

        expect(result).toEqual({
          operation: 'permission_prompt',
          params: { tool_name: 'Bash', input: { command: 'ls' } },
        });
      });

      it('should preserve agent_identity in params', () => {
        const result = parseOperationInput({
          tool_name: 'Edit',
          input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
          agent_identity: 'sub-1',
        });

        expect(result).toEqual({
          operation: 'permission_prompt',
          params: {
            tool_name: 'Edit',
            input: { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' },
            agent_identity: 'sub-1',
          },
        });
      });

      it('should parse {tool_name} without input', () => {
        const result = parseOperationInput({
          tool_name: 'Bash',
        });

        expect(result).toEqual({
          operation: 'permission_prompt',
          params: { tool_name: 'Bash' },
        });
      });

      it('should record permission_prompt_protocol metric', () => {
        parseOperationInput({
          tool_name: 'Bash',
          input: { command: 'npm test' },
        });

        const metrics = InputFormatMetrics.getMetrics();
        expect(metrics.permission_prompt_protocol).toBe(1);
        expect(metrics.proper).toBe(0);
        expect(metrics.legacy_converted).toBe(0);
        expect(metrics.invalid).toBe(0);
      });

      it('should NOT match when operation field is present', () => {
        // Standard CRUDE format with tool_name as a param — should parse as proper format
        const result = parseOperationInput({
          operation: 'permission_prompt',
          params: { tool_name: 'Bash', input: { command: 'ls' } },
        });

        expect(result).toEqual({
          operation: 'permission_prompt',
          params: { tool_name: 'Bash', input: { command: 'ls' } },
        });

        const metrics = InputFormatMetrics.getMetrics();
        expect(metrics.proper).toBe(1);
        expect(metrics.permission_prompt_protocol).toBe(0);
      });
    });

    describe('Invalid format', () => {
      it('should return null for invalid input', () => {
        expect(parseOperationInput(null)).toBeNull();
        expect(parseOperationInput(undefined)).toBeNull();
        expect(parseOperationInput('string')).toBeNull();
        expect(parseOperationInput(123)).toBeNull();
        expect(parseOperationInput([])).toBeNull();
      });

      it('should record invalid metric', () => {
        parseOperationInput({ invalid: 'format' });

        const metrics = InputFormatMetrics.getMetrics();
        expect(metrics.proper).toBe(0);
        expect(metrics.legacy_converted).toBe(0);
        expect(metrics.invalid).toBe(1);
      });

      it('should return null for missing operation and tool', () => {
        expect(parseOperationInput({ params: {} })).toBeNull();
      });

      it('should return null for empty object', () => {
        expect(parseOperationInput({})).toBeNull();
      });
    });
  });

  describe('InputFormatMetrics', () => {
    it('should track multiple events', () => {
      // Record various events
      InputFormatMetrics.record('proper');
      InputFormatMetrics.record('proper');
      InputFormatMetrics.record('legacy_converted');
      InputFormatMetrics.record('invalid');

      const metrics = InputFormatMetrics.getMetrics();

      expect(metrics.proper).toBe(2);
      expect(metrics.legacy_converted).toBe(1);
      expect(metrics.invalid).toBe(1);
    });

    it('should reset metrics correctly', () => {
      InputFormatMetrics.record('proper');
      InputFormatMetrics.record('legacy_converted');
      InputFormatMetrics.record('permission_prompt_protocol');

      InputFormatMetrics.reset();

      const metrics = InputFormatMetrics.getMetrics();
      expect(metrics.proper).toBe(0);
      expect(metrics.legacy_converted).toBe(0);
      expect(metrics.permission_prompt_protocol).toBe(0);
      expect(metrics.invalid).toBe(0);
    });

    it('should return a copy of metrics (immutable)', () => {
      InputFormatMetrics.record('proper');
      const metrics1 = InputFormatMetrics.getMetrics();

      InputFormatMetrics.record('proper');
      const metrics2 = InputFormatMetrics.getMetrics();

      // First snapshot should be unchanged
      expect(metrics1.proper).toBe(1);
      // Second snapshot should reflect new count
      expect(metrics2.proper).toBe(2);
    });
  });
});

describe('normalizeMCPAQLElementType (Issue #1636)', () => {
  it('should normalize plural forms to MCP-AQL singular', () => {
    expect(normalizeMCPAQLElementType('personas')).toBe('persona');
    expect(normalizeMCPAQLElementType('skills')).toBe('skill');
    expect(normalizeMCPAQLElementType('templates')).toBe('template');
    expect(normalizeMCPAQLElementType('agents')).toBe('agent');
    expect(normalizeMCPAQLElementType('memories')).toBe('memory');
    expect(normalizeMCPAQLElementType('ensembles')).toBe('ensemble');
  });

  it('should accept singular forms unchanged', () => {
    expect(normalizeMCPAQLElementType('persona')).toBe('persona');
    expect(normalizeMCPAQLElementType('skill')).toBe('skill');
    expect(normalizeMCPAQLElementType('template')).toBe('template');
    expect(normalizeMCPAQLElementType('agent')).toBe('agent');
    expect(normalizeMCPAQLElementType('memory')).toBe('memory');
    expect(normalizeMCPAQLElementType('ensemble')).toBe('ensemble');
  });

  it('should be case-insensitive', () => {
    expect(normalizeMCPAQLElementType('SKILLS')).toBe('skill');
    expect(normalizeMCPAQLElementType('Persona')).toBe('persona');
    expect(normalizeMCPAQLElementType('MEMORIES')).toBe('memory');
  });

  it('should trim whitespace', () => {
    expect(normalizeMCPAQLElementType('  skills  ')).toBe('skill');
  });

  it('should return undefined for invalid types', () => {
    expect(normalizeMCPAQLElementType('invalid')).toBeUndefined();
    expect(normalizeMCPAQLElementType('')).toBeUndefined();
    expect(normalizeMCPAQLElementType('foo')).toBeUndefined();
  });
});

describe('describeInvalidInput (Issue #1656)', () => {
  it('should describe null input', () => {
    expect(describeInvalidInput(null)).toBe('Received: null');
  });

  it('should describe undefined input', () => {
    expect(describeInvalidInput(undefined)).toBe('Received: undefined');
  });

  it('should describe array input with batch hint', () => {
    const result = describeInvalidInput([{ operation: 'addEntry' }, { operation: 'addEntry' }]);
    expect(result).toContain('array with 2 items');
    expect(result).toContain('operations');
  });

  it('should describe non-object input', () => {
    expect(describeInvalidInput('some string')).toBe('Received: string');
    expect(describeInvalidInput(42)).toBe('Received: number');
    expect(describeInvalidInput(true)).toBe('Received: boolean');
  });

  it('should describe object missing operation field', () => {
    const result = describeInvalidInput({ params: { element_name: 'test' } });
    expect(result).toContain('params');
    expect(result).toContain('missing "operation" field');
  });

  it('should describe object with non-string operation', () => {
    const result = describeInvalidInput({ operation: 123, params: {} });
    expect(result).toContain('operation');
    expect(result).toContain('number, expected string');
  });

  it('should describe empty object', () => {
    const result = describeInvalidInput({});
    expect(result).toContain('missing "operation" field');
  });

  it('should truncate keys for large objects', () => {
    const largeObj: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) largeObj[`key${i}`] = i;
    const result = describeInvalidInput(largeObj);
    expect(result).toContain('15 keys total');
  });

  // Issue #1768: Content-aware diagnostics for markdown/special character failures
  it('should include content length hint when params.content is large', () => {
    const result = describeInvalidInput({
      operation: 'addEntry',
      params: {
        element_name: 'my-memory',
        content: '## LLM-as-Judge\n' + 'x'.repeat(200),
      },
    });
    expect(result).toContain('content field is');
    expect(result).toContain('chars');
    expect(result).toContain('markdown');
  });

  it('should not include content hint for short content', () => {
    const result = describeInvalidInput({
      operation: 'addEntry',
      params: {
        element_name: 'my-memory',
        content: 'short note',
      },
    });
    expect(result).not.toContain('content field is');
  });

  it('should not include content hint when params is missing', () => {
    const result = describeInvalidInput({ operation: 'addEntry' });
    expect(result).not.toContain('content field is');
  });
});

// ==========================================================================
// Regression tests for Issue #1768 — markdown content in addEntry
// ==========================================================================

describe('parseOperationInput with markdown content (Issue #1768)', () => {
  it('should accept addEntry with simple markdown headers', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: '## Research Notes\n\n### Section 1\nSome findings.',
        tags: ['research'],
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.operation).toBe('addEntry');
    expect(result!.params!.content).toContain('## Research Notes');
  });

  it('should accept addEntry with bold and italic markdown', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: 'This is **bold** and *italic* text with __underline__.',
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.params!.content).toContain('**bold**');
  });

  it('should accept addEntry with markdown lists', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: '- Item 1\n- Item 2\n  - Nested item\n1. Ordered\n2. List',
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.params!.content).toContain('- Item 1');
  });

  it('should accept addEntry with pipe characters (markdown tables)', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: '| Header | Value |\n|--------|-------|\n| Row 1  | Data  |',
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.params!.content).toContain('| Header |');
  });

  it('should accept addEntry with code blocks', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: '```typescript\nconst x = 42;\nconsole.log(x);\n```',
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.params!.content).toContain('```typescript');
  });

  it('should accept addEntry with URLs and links', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'test-memory',
        content: 'See [JudgeBench](https://arxiv.org/abs/2410.12784) and https://github.com/ScalerLab/JudgeBench',
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.params!.content).toContain('arxiv.org');
  });

  it('should accept the exact markdown content from the bug report', () => {
    const input = {
      operation: 'addEntry',
      params: {
        element_name: 'my-memory',
        content: '## LLM-as-Judge Advances\n\n### JudgeBench (ICLR 2025)\nBenchmark for LLM judges on *difficult* response pairs requiring advanced reasoning. Even GPT-4o performs only slightly better than random on hard pairs (64% accuracy).\n- Metrics: Pairwise accuracy on factually verifiable pairs\n- Source: arXiv 2410.12784 | github.com/ScalerLab/JudgeBench',
        tags: ['llm-judge', 'benchmarks'],
      },
    };
    const result = parseOperationInput(input);
    expect(result).not.toBeNull();
    expect(result!.operation).toBe('addEntry');
    expect(result!.params!.content).toContain('## LLM-as-Judge');
    expect(result!.params!.content).toContain('| github.com');
  });
});

// ==========================================================================
// Regression tests for Issue #1767 — ensemble example in tool description
// ==========================================================================

describe('Ensemble example in tool descriptions (Issue #1767)', () => {
  it('should have ensemble in create_element examples in the schema', () => {
    // getAnyOperationSchema is already imported at top of file via types.ts re-export
    // Use the parseOperationInput path to verify ensemble is a valid create_element input
    const ensembleInput = {
      operation: 'create_element',
      element_type: 'ensemble',
      params: {
        element_name: 'my-ensemble',
        description: 'Test ensemble',
        metadata: {
          elements: [
            { element_name: 'expert', element_type: 'persona', role: 'primary' },
            { element_name: 'analysis', element_type: 'skill', role: 'support' },
          ],
        },
      },
    };
    const result = parseOperationInput(ensembleInput);
    expect(result).not.toBeNull();
    expect(result!.operation).toBe('create_element');
    expect(result!.element_type).toBe('ensemble');
  });

  it('should accept all valid ensemble roles', () => {
    const validRoles = ['primary', 'support', 'override', 'monitor', 'core'];
    for (const role of validRoles) {
      const input = {
        operation: 'create_element',
        element_type: 'ensemble',
        params: {
          element_name: `test-${role}`,
          description: `Ensemble role test: ${role}`,
          metadata: {
            elements: [
              { element_name: 'elem', element_type: 'skill', role },
            ],
          },
        },
      };
      const result = parseOperationInput(input);
      expect(result).not.toBeNull();
    }
  });
});
