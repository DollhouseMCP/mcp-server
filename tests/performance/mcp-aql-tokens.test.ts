/**
 * MCP-AQL Token Economics Performance Tests
 *
 * Validates that the MCP-AQL consolidated approach achieves target token savings
 * compared to discrete tools.
 *
 * Two savings metrics are tracked:
 * - **Baseline**: 5 CRUDE tools vs 42 historical discrete tools (~74% savings)
 * - **Projected**: 5 CRUDE tools vs all current operations (~85% savings)
 *   Uses the average token cost of the 42 known tools as a heuristic for
 *   operations that never had discrete tools.
 *
 * Issue: #189, #1822
 */

import { describe, it, expect } from '@jest/globals';
import {
  runTokenBenchmark,
  estimateTokens,
  discreteTools,
  mcpAqlTools
} from '../../scripts/benchmark-mcp-aql-tokens.js';

describe('MCP-AQL Token Economics', () => {
  describe('Token Estimation', () => {
    // Parameterized tests for string inputs
    it.each([
      ['short string', 'hello', 2],           // 5 chars → ceil(5/4) = 2
      ['medium string', 'hello world', 3],    // 11 chars → ceil(11/4) = 3
      ['longer string', 'hello world from claude code', 7], // 28 chars → ceil(28/4) = 7
      ['empty string', '', 0],                // 0 chars → ceil(0/4) = 0
      ['single char', 'x', 1],                // 1 char → ceil(1/4) = 1
    ])('should estimate tokens correctly for %s', (_desc, input, expected) => {
      expect(estimateTokens(input)).toBe(expected);
    });

    // Parameterized tests for object inputs
    it.each([
      ['empty object', {}, 1],                // "{}" = 2 chars → ceil(2/4) = 1
      ['simple object', { a: 1 }, 3],         // formatted JSON 12 chars → ceil(12/4) = 3
      ['nested object', { a: { b: 1 } }, 7],  // formatted JSON 26 chars → ceil(26/4) = 7
    ])('should estimate tokens correctly for %s', (_desc, input, expected) => {
      expect(estimateTokens(input)).toBe(expected);
    });

    it('should handle complex nested objects', () => {
      const complex = {
        name: 'test',
        type: 'persona',
        metadata: {
          author: 'claude',
          tags: ['ai', 'testing']
        }
      };
      const result = estimateTokens(complex);
      // Complex object should be reasonable size
      expect(result).toBeGreaterThan(20);
      expect(result).toBeLessThan(100);
    });
  });

  describe('Tool Schema Metrics', () => {
    it('should have correct discrete tool count', () => {
      // 42 discrete tools across 8 files
      expect(discreteTools.length).toBe(42);
    });

    it('should have correct MCP-AQL tool count', () => {
      // 5 unified MCP-AQL CRUDE endpoints (Create, Read, Update, Delete, Execute)
      expect(mcpAqlTools.length).toBe(5);
    });

    it('should have all required tool properties', () => {
      for (const tool of discreteTools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(typeof tool.inputSchema).toBe('object');
      }

      for (const tool of mcpAqlTools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool).toHaveProperty('annotations');
      }
    });

    it('should have unique tool names in discrete tools', () => {
      const names = discreteTools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have unique tool names in MCP-AQL tools', () => {
      const names = mcpAqlTools.map(t => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('Token Savings Targets', () => {
    it('should achieve minimum 70% baseline savings (vs 42 historical tools)', async () => {
      const results = await runTokenBenchmark();

      expect(results.savings.percent).toBeGreaterThanOrEqual(70);
    });

    it('should achieve minimum 80% projected savings (vs all current operations)', async () => {
      const results = await runTokenBenchmark();

      // Projected savings uses actual operation count × avg discrete tool cost.
      // This reflects the true value of MCP-AQL as operations grow while
      // CRUDE endpoint count stays fixed.
      expect(results.projectedSavings.percent).toBeGreaterThanOrEqual(80);
    });

    it('should achieve target 85% projected savings', async () => {
      const results = await runTokenBenchmark();

      // Target: 85% projected savings — operations have grown from 42 to 73+
      // while CRUDE endpoints remain at 5, improving the ratio over time.
      expect(results.projectedSavings.percent).toBeGreaterThanOrEqual(85);
    });

    it('should save at least 5000 tokens', async () => {
      const results = await runTokenBenchmark();

      // Absolute token savings target
      expect(results.savings.tokens).toBeGreaterThanOrEqual(5000);
    });
  });

  describe('Tool Consolidation Metrics', () => {
    it('should achieve 8x or better baseline consolidation ratio', async () => {
      const results = await runTokenBenchmark();

      const ratio = results.discreteTools.count / results.mcpAqlTools.count;
      expect(ratio).toBeGreaterThanOrEqual(8);
    });

    it('should achieve 14x or better projected consolidation ratio', async () => {
      const results = await runTokenBenchmark();

      // All current operations consolidated into 5 CRUDE endpoints
      expect(results.projectedSavings.consolidationRatio).toBeGreaterThanOrEqual(14);
    });

    it('should reduce total tools by at least 35', async () => {
      const results = await runTokenBenchmark();

      const reduction = results.discreteTools.count - results.mcpAqlTools.count;
      expect(reduction).toBeGreaterThanOrEqual(35);
    });
  });

  describe('MCP-AQL Tool Structure', () => {
    it('should have proper CRUDE semantics', () => {
      const toolNames = mcpAqlTools.map(t => t.name);

      expect(toolNames).toContain('mcp_aql_create');
      expect(toolNames).toContain('mcp_aql_read');
      expect(toolNames).toContain('mcp_aql_update');
      expect(toolNames).toContain('mcp_aql_delete');
      expect(toolNames).toContain('mcp_aql_execute');
    });

    it('should have correct annotations for read-only operations', () => {
      const readTool = mcpAqlTools.find(t => t.name === 'mcp_aql_read');

      expect(readTool?.annotations?.readOnlyHint).toBe(true);
      expect(readTool?.annotations?.destructiveHint).toBe(false);
    });

    it('should have correct annotations for destructive operations', () => {
      const updateTool = mcpAqlTools.find(t => t.name === 'mcp_aql_update');
      const deleteTool = mcpAqlTools.find(t => t.name === 'mcp_aql_delete');
      const executeTool = mcpAqlTools.find(t => t.name === 'mcp_aql_execute');

      expect(updateTool?.annotations?.destructiveHint).toBe(true);
      expect(deleteTool?.annotations?.destructiveHint).toBe(true);
      expect(executeTool?.annotations?.destructiveHint).toBe(true);
    });

    it('should have correct annotations for create operations', () => {
      const createTool = mcpAqlTools.find(t => t.name === 'mcp_aql_create');

      expect(createTool?.annotations?.readOnlyHint).toBe(false);
      expect(createTool?.annotations?.destructiveHint).toBe(false);
    });

    it('should have unified input schema structure', () => {
      for (const tool of mcpAqlTools) {
        const schema = tool.inputSchema as any;
        expect(schema.properties).toHaveProperty('operation');
        expect(schema.properties).toHaveProperty('params');
        expect(schema.required).toContain('operation');
      }
    });
  });

  describe('Per-Tool Token Analysis', () => {
    it('should have reasonable token count for MCP-AQL tools', async () => {
      const results = await runTokenBenchmark();

      // Average should be under 400 tokens per tool (adjusted for 5 CRUDE endpoints)
      expect(results.mcpAqlTools.avgPerTool).toBeLessThan(400);
    });

    it('should have list_elements as largest discrete tool', () => {
      const listTokens = estimateTokens(discreteTools.find(t => t.name === 'list_elements')!);

      // Should be one of the largest (top 3)
      const allTokens = discreteTools.map(t => estimateTokens(t));
      allTokens.sort((a, b) => b - a);

      const top3 = allTokens.slice(0, 3);
      expect(top3).toContain(listTokens);
    });
  });

  describe('Regression Prevention', () => {
    it('should not exceed 2000 tokens for MCP-AQL total', async () => {
      const results = await runTokenBenchmark();

      // Prevent schema bloat across 5 CRUDE endpoints
      expect(results.mcpAqlTools.totalTokens).toBeLessThan(2000);
    });

    it('should maintain minimum 70% baseline savings', async () => {
      const results = await runTokenBenchmark();

      // Alarm threshold for baseline (vs 42 historical tools)
      expect(results.savings.percent).toBeGreaterThanOrEqual(70);
    });

    it('should maintain minimum 80% projected savings', async () => {
      const results = await runTokenBenchmark();

      // Alarm threshold for projected (vs all current operations)
      expect(results.projectedSavings.percent).toBeGreaterThanOrEqual(80);
    });

    it('should not add tools beyond 5 MCP-AQL endpoints', () => {
      expect(mcpAqlTools.length).toBe(5);
    });
  });

  describe('Cross-Server Savings Model', () => {
    it('should project at least 80% total savings across all servers', async () => {
      const results = await runTokenBenchmark();

      expect(results.crossServer.totals.totalPercent).toBeGreaterThanOrEqual(80);
    });

    it('should include measured data from at least 2 adapters', async () => {
      const results = await runTokenBenchmark();

      const measuredCount = results.crossServer.servers.filter(
        (s: any) => s.measured
      ).length;
      expect(measuredCount).toBeGreaterThanOrEqual(2);
    });

    it('should reduce tool surface by at least 80%', async () => {
      const results = await runTokenBenchmark();
      const t = results.crossServer.totals;

      const toolReduction = 1 - t.totalCrudeTools / t.totalDiscreteTools;
      expect(toolReduction).toBeGreaterThanOrEqual(0.8);
    });
  });
});
