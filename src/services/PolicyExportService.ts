/**
 * PolicyExportService - Exports tool classification policies for bridge consumption
 *
 * Writes a JSON policy file to ~/.dollhouse/bridge/imports/policies/ so the
 * DollhouseBridge permission-prompt server can evaluate permissions locally.
 *
 * Write-only: publishes and forgets. Skips silently if the bridge folder
 * doesn't exist (bridge may not be installed).
 *
 * @see https://github.com/DollhouseMCP/mcp-server-v2-refactor/issues/762
 */

import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getStaticPolicyData } from '../handlers/mcp-aql/policies/ToolClassification.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

const POLICY_DIR = join(homedir(), '.dollhouse', 'bridge', 'imports', 'policies');
const POLICY_FILENAME = 'dollhousemcp-crude-policies.json';

export interface PolicyExportDeps {
  getActiveElementsForPolicy: () => Promise<Array<{ type: string; name: string; metadata: Record<string, unknown> }>>;
  getServerVersion: () => string;
}

interface ElementPolicyEntry {
  type: string;
  name: string;
  allow_patterns: string[];
  deny_patterns: string[];
}

export class PolicyExportService {
  private deps: PolicyExportDeps;

  constructor(deps: PolicyExportDeps) {
    this.deps = deps;
  }

  /**
   * Export current policy state to the bridge imports folder.
   *
   * Gathers static classification rules and active element policies,
   * writes a single JSON file conforming to bridge policy schema v1.0.
   *
   * Skips silently if the bridge imports directory doesn't exist.
   */
  async exportPolicies(): Promise<void> {
    if (!env.DOLLHOUSE_POLICY_EXPORT_ENABLED) {
      return;
    }

    try {
      // Check if bridge imports directory exists — skip if not
      await access(POLICY_DIR);
    } catch {
      // Bridge not installed or imports dir not created — skip silently
      return;
    }

    try {
      const staticRules = getStaticPolicyData();
      const activeElements = await this.deps.getActiveElementsForPolicy();
      const version = this.deps.getServerVersion();

      const elementPolicies = this.buildElementPolicies(activeElements);

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

      const filePath = join(POLICY_DIR, POLICY_FILENAME);
      await writeFile(filePath, JSON.stringify(policy, null, 2), 'utf-8');
      logger.info('[PolicyExportService] Policies exported', { filePath, elementCount: elementPolicies.active_element_count });
    } catch (err) {
      // Non-fatal: log and continue
      logger.warn('[PolicyExportService] Failed to export policies', { error: (err as Error).message });
    }
  }

  private buildElementPolicies(activeElements: Array<{ type: string; name: string; metadata: Record<string, unknown> }>) {
    const elements: ElementPolicyEntry[] = [];
    const combinedAllow: string[] = [];
    const combinedDeny: string[] = [];
    let ensembleName: string | undefined;

    for (const element of activeElements) {
      if (element.type === 'ensemble') {
        ensembleName = element.name;
      }

      const gatekeeper = element.metadata?.gatekeeper as Record<string, unknown> | undefined;
      const external = gatekeeper?.externalRestrictions as Record<string, unknown> | undefined;

      const allowPatterns = Array.isArray(external?.allowPatterns)
        ? (external.allowPatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      const denyPatterns = Array.isArray(external?.denyPatterns)
        ? (external.denyPatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];

      elements.push({
        type: element.type,
        name: element.name,
        allow_patterns: allowPatterns,
        deny_patterns: denyPatterns,
      });

      combinedAllow.push(...allowPatterns);
      combinedDeny.push(...denyPatterns);
    }

    return {
      active_element_count: elements.length,
      ...(ensembleName ? { ensemble_name: ensembleName } : {}),
      elements,
      combined_allow_patterns: [...new Set(combinedAllow)],
      combined_deny_patterns: [...new Set(combinedDeny)],
    };
  }
}
