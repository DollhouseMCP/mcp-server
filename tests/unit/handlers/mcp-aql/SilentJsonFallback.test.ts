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
  InputFormatMetrics,
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
