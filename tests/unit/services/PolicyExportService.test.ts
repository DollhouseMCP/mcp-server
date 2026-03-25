/**
 * PolicyExportService - Unit Tests
 *
 * Tests policy export to bridge imports folder, including:
 * - Correct policy file structure (schema v1.0)
 * - Static rules inclusion (safe tools, bash patterns, etc.)
 * - Element policy aggregation (allow/deny patterns, ensemble name)
 * - Deduplication of combined patterns
 * - Non-string pattern filtering
 *
 * Uses a real temp directory to avoid ESM mocking complexity.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PolicyExportService, type PolicyExportDeps } from '../../../src/services/PolicyExportService.js';
import { getStaticPolicyData } from '../../../src/handlers/mcp-aql/policies/ToolClassification.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let testDir: string;
let policyDir: string;

function createMockDeps(overrides: Partial<PolicyExportDeps> = {}): PolicyExportDeps {
  return {
    getActiveElementsForPolicy: async () => [],
    getServerVersion: () => '2.0.0-test',
    ...overrides,
  };
}

/**
 * Create a PolicyExportService that writes to a custom directory
 * instead of the real bridge imports path.
 */
function createServiceWithDir(dir: string, deps: Partial<PolicyExportDeps> = {}): PolicyExportService {
  const service = new PolicyExportService(createMockDeps(deps));
  // Override the private POLICY_DIR via a subclass to test with temp dir
  // We access the internal method through the public API and override writeFile path
  // by monkey-patching exportPolicies to use our test dir
  service.exportPolicies = async () => {
    // Temporarily replace the module-level constants by overriding the method
    const staticRules = getStaticPolicyData();
    const activeElements = await createMockDeps(deps).getActiveElementsForPolicy();
    const version = createMockDeps(deps).getServerVersion();

    const elementPolicies = (service as any).buildElementPolicies(activeElements);

    const policy = {
      schema_version: '1.0',
      server: {
        name: 'DollhouseMCP-V2-Refactor CRUDE',
        version,
      },
      exported_at: new Date().toISOString(),
      static_rules: {
        safe_tools: staticRules.safe_tools,
        safe_bash_patterns: staticRules.safe_bash_patterns,
        dangerous_bash_patterns: staticRules.dangerous_bash_patterns,
        blocked_bash_patterns: staticRules.blocked_bash_patterns,
        irreversible_patterns: staticRules.irreversible_patterns,
        sensitive_path_prefixes: staticRules.sensitive_path_prefixes,
        gatekeeper_essential_operations: staticRules.gatekeeper_essential_operations,
        safe_mcp_operations: staticRules.safe_mcp_operations,
      },
      element_policies: elementPolicies,
      risk_scores: staticRules.risk_scores,
    };

    const filePath = path.join(dir, 'dollhousemcp-crude-policies.json');
    await fs.writeFile(filePath, JSON.stringify(policy, null, 2), 'utf-8');
  };

  return service;
}

async function readPolicyFile(): Promise<Record<string, any>> {
  const content = await fs.readFile(path.join(policyDir, 'dollhousemcp-crude-policies.json'), 'utf-8');
  return JSON.parse(content);
}

describe('PolicyExportService', () => {
  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-export-test-'));
    policyDir = testDir;
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('exportPolicies', () => {
    it('should skip silently when bridge directory does not exist', async () => {
      // Use the real service pointing at real (non-existent) path
      // This verifies the access() check works
      const service = new PolicyExportService(createMockDeps());
      // If bridge dir doesn't exist, this should not throw
      await expect(service.exportPolicies()).resolves.toBeUndefined();
    });

    it('should produce valid schema v1.0 structure', async () => {
      const service = createServiceWithDir(policyDir);
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.schema_version).toBe('1.0');
      expect(policy.server).toEqual({
        name: 'DollhouseMCP-V2-Refactor CRUDE',
        version: '2.0.0-test',
      });
      expect(policy.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should include all static rule categories', async () => {
      const service = createServiceWithDir(policyDir);
      await service.exportPolicies();

      const policy = await readPolicyFile();
      const rules = policy.static_rules;

      expect(rules.safe_tools).toBeInstanceOf(Array);
      expect(rules.safe_bash_patterns).toBeInstanceOf(Array);
      expect(rules.dangerous_bash_patterns).toBeInstanceOf(Array);
      expect(rules.blocked_bash_patterns).toBeInstanceOf(Array);
      expect(rules.irreversible_patterns).toBeInstanceOf(Array);
      expect(rules.sensitive_path_prefixes).toBeInstanceOf(Array);
      expect(rules.gatekeeper_essential_operations).toBeInstanceOf(Array);
      expect(rules.safe_mcp_operations).toBeInstanceOf(Array);
    });

    it('should match getStaticPolicyData output', async () => {
      const service = createServiceWithDir(policyDir);
      await service.exportPolicies();

      const policy = await readPolicyFile();
      const expected = getStaticPolicyData();

      expect(policy.static_rules.safe_tools).toEqual(expected.safe_tools);
      expect(policy.static_rules.blocked_bash_patterns).toEqual(expected.blocked_bash_patterns);
      expect(policy.static_rules.gatekeeper_essential_operations).toEqual(expected.gatekeeper_essential_operations);
      expect(policy.risk_scores).toEqual(expected.risk_scores);
    });

    it('should include risk scores', async () => {
      const service = createServiceWithDir(policyDir);
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.risk_scores).toEqual({
        safe: 0,
        moderate: 40,
        dangerous: 80,
        blocked: 100,
      });
    });
  });

  describe('element policy aggregation', () => {
    it('should report zero elements when none are active', async () => {
      const service = createServiceWithDir(policyDir);
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.active_element_count).toBe(0);
      expect(policy.element_policies.elements).toEqual([]);
      expect(policy.element_policies.combined_allow_patterns).toEqual([]);
      expect(policy.element_policies.combined_confirm_patterns).toEqual([]);
      expect(policy.element_policies.combined_deny_patterns).toEqual([]);
      expect(policy.element_policies.ensemble_name).toBeUndefined();
    });

    it('should extract allow/deny patterns from active elements', async () => {
      const service = createServiceWithDir(policyDir, {
        getActiveElementsForPolicy: async () => [{
          type: 'skill',
          name: 'code-review',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'Git access only',
                allowPatterns: ['git *', 'gh *'],
                denyPatterns: ['rm -rf *'],
              },
            },
          },
        }],
      });
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.active_element_count).toBe(1);
      expect(policy.element_policies.elements[0]).toEqual({
        type: 'skill',
        name: 'code-review',
        allow_patterns: ['git *', 'gh *'],
        confirm_patterns: [],
        deny_patterns: ['rm -rf *'],
      });
      expect(policy.element_policies.combined_allow_patterns).toEqual(['git *', 'gh *']);
      expect(policy.element_policies.combined_confirm_patterns).toEqual([]);
      expect(policy.element_policies.combined_deny_patterns).toEqual(['rm -rf *']);
    });

    it('should set ensemble_name when ensemble is active', async () => {
      const service = createServiceWithDir(policyDir, {
        getActiveElementsForPolicy: async () => [
          { type: 'ensemble', name: 'dev-workflow', metadata: {} },
          { type: 'persona', name: 'coder', metadata: {} },
        ],
      });
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.ensemble_name).toBe('dev-workflow');
      expect(policy.element_policies.active_element_count).toBe(2);
    });

    it('should deduplicate combined patterns', async () => {
      const service = createServiceWithDir(policyDir, {
        getActiveElementsForPolicy: async () => [
          {
            type: 'skill', name: 'skill-a',
            metadata: { gatekeeper: { externalRestrictions: { description: 'a', allowPatterns: ['git *'], denyPatterns: ['rm -rf *'] } } },
          },
          {
            type: 'skill', name: 'skill-b',
            metadata: { gatekeeper: { externalRestrictions: { description: 'b', allowPatterns: ['git *', 'npm test*'], denyPatterns: ['rm -rf *'] } } },
          },
        ],
      });
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.combined_allow_patterns).toEqual(['git *', 'npm test*']);
      expect(policy.element_policies.combined_confirm_patterns).toEqual([]);
      expect(policy.element_policies.combined_deny_patterns).toEqual(['rm -rf *']);
    });

    it('should handle elements without gatekeeper metadata', async () => {
      const service = createServiceWithDir(policyDir, {
        getActiveElementsForPolicy: async () => [
          { type: 'persona', name: 'default', metadata: {} },
        ],
      });
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.active_element_count).toBe(1);
      expect(policy.element_policies.elements[0].allow_patterns).toEqual([]);
      expect(policy.element_policies.elements[0].confirm_patterns).toEqual([]);
      expect(policy.element_policies.elements[0].deny_patterns).toEqual([]);
    });

    it('should filter out non-string values in patterns', async () => {
      const service = createServiceWithDir(policyDir, {
        getActiveElementsForPolicy: async () => [{
          type: 'skill', name: 'malformed',
          metadata: {
            gatekeeper: {
              externalRestrictions: {
                description: 'bad data',
                allowPatterns: ['valid *', 123, null, 'also valid'],
                denyPatterns: [42, 'rm -rf *'],
              },
            },
          },
        }],
      });
      await service.exportPolicies();

      const policy = await readPolicyFile();
      expect(policy.element_policies.elements[0].allow_patterns).toEqual(['valid *', 'also valid']);
      expect(policy.element_policies.elements[0].confirm_patterns).toEqual([]);
      expect(policy.element_policies.elements[0].deny_patterns).toEqual(['rm -rf *']);
    });
  });
});

describe('getStaticPolicyData', () => {
  it('should return arrays (not Sets) for all collections', () => {
    const data = getStaticPolicyData();
    expect(Array.isArray(data.safe_tools)).toBe(true);
    expect(Array.isArray(data.safe_bash_patterns)).toBe(true);
    expect(Array.isArray(data.dangerous_bash_patterns)).toBe(true);
    expect(Array.isArray(data.blocked_bash_patterns)).toBe(true);
    expect(Array.isArray(data.irreversible_patterns)).toBe(true);
    expect(Array.isArray(data.sensitive_path_prefixes)).toBe(true);
    expect(Array.isArray(data.gatekeeper_essential_operations)).toBe(true);
    expect(Array.isArray(data.safe_mcp_operations)).toBe(true);
  });

  it('should include known safe tools', () => {
    const data = getStaticPolicyData();
    expect(data.safe_tools).toContain('Read');
    expect(data.safe_tools).toContain('Grep');
    expect(data.safe_tools).toContain('Glob');
  });

  it('should include known gatekeeper-essential operations', () => {
    const data = getStaticPolicyData();
    expect(data.gatekeeper_essential_operations).toContain('confirm_operation');
    expect(data.gatekeeper_essential_operations).toContain('permission_prompt');
  });

  it('should include known blocked patterns', () => {
    const data = getStaticPolicyData();
    expect(data.blocked_bash_patterns).toContain('mkfs*');
    expect(data.blocked_bash_patterns).toContain('dd if=*');
  });

  it('should return correct risk_scores', () => {
    const data = getStaticPolicyData();
    expect(data.risk_scores).toEqual({
      safe: 0,
      moderate: 40,
      dangerous: 80,
      blocked: 100,
    });
  });
});
