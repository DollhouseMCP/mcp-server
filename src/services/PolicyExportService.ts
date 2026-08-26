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
import { AsyncResource } from 'node:async_hooks';
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
  confirm_patterns: string[];
  deny_patterns: string[];
}

type PolicyDocument = Record<string, unknown>;

interface PendingPolicyExport {
  sequence: number;
  capture: () => Promise<PolicyDocument | undefined>;
}

export class PolicyExportService {
  private exportInFlight?: Promise<void>;
  private pendingExport?: PendingPolicyExport;
  private nextExportSequence = 0;

  constructor(
    private readonly deps: PolicyExportDeps,
    private readonly policyDir: string = POLICY_DIR,
  ) {}

  /**
   * Export current policy state to the bridge imports folder.
   *
   * Gathers static classification rules and active element policies,
   * writes a single JSON file conforming to bridge policy schema v1.0.
   *
   * Skips silently if the bridge imports directory doesn't exist.
   */
  exportPolicies(): Promise<void> {
    if (!env.DOLLHOUSE_POLICY_EXPORT_ENABLED) {
      return Promise.resolve();
    }

    // Bind a lazy capture to the caller's AsyncLocalStorage context. Bursts
    // replace pending captures before they do work, while a newer session can
    // never run through an older request's context.
    this.pendingExport = {
      sequence: ++this.nextExportSequence,
      capture: AsyncResource.bind(() => this.capturePolicySnapshot()),
    };
    this.exportInFlight ??= this.runExportLoop();
    return this.exportInFlight;
  }

  private async runExportLoop(): Promise<void> {
    try {
      while (this.pendingExport) {
        const exportJob = this.pendingExport;
        this.pendingExport = undefined;
        const policy = await exportJob.capture();

        // If a newer request arrived while this snapshot was being gathered,
        // skip the older write. The loop will publish the newest snapshot.
        const newerRequest = this.pendingExport as PendingPolicyExport | undefined;
        if (newerRequest && newerRequest.sequence > exportJob.sequence) {
          continue;
        }
        if (policy) await this.writePolicy(policy);
      }
    } finally {
      this.exportInFlight = undefined;

      // Close the settlement race: a request queued after the loop observed
      // empty state is included before the promise returned to callers settles.
      if (this.pendingExport) {
        const trailing = this.runExportLoop();
        this.exportInFlight = trailing;
        await trailing;
      }
    }
  }

  private async capturePolicySnapshot(): Promise<PolicyDocument | undefined> {
    try {
      try {
        await access(this.policyDir);
      } catch {
        // Bridge not installed or imports dir not created — skip silently.
        return undefined;
      }

      const staticRules = getStaticPolicyData();
      const activeElements = await this.deps.getActiveElementsForPolicy();
      const version = this.deps.getServerVersion();

      const elementPolicies = this.buildElementPolicies(activeElements);

      return {
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
    } catch (err) {
      logger.warn('[PolicyExportService] Failed to capture policies', { error: (err as Error).message });
      return undefined;
    }
  }

  private async writePolicy(policy: PolicyDocument): Promise<void> {
    try {
      const filePath = join(this.policyDir, POLICY_FILENAME);
      await writeFile(filePath, JSON.stringify(policy, null, 2), 'utf-8');
      const elementPolicies = policy['element_policies'] as { active_element_count?: number } | undefined;
      logger.info('[PolicyExportService] Policies exported', {
        filePath,
        elementCount: elementPolicies?.active_element_count ?? 0,
      });
    } catch (err) {
      // Non-fatal: policy export must never break element activation.
      logger.warn('[PolicyExportService] Failed to export policies', { error: (err as Error).message });
    }
  }

  private buildElementPolicies(activeElements: Array<{ type: string; name: string; metadata: Record<string, unknown> }>) {
    const elements: ElementPolicyEntry[] = [];
    const combinedAllow: string[] = [];
    const combinedConfirm: string[] = [];
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
      const confirmPatterns = Array.isArray(external?.confirmPatterns)
        ? (external.confirmPatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];
      const denyPatterns = Array.isArray(external?.denyPatterns)
        ? (external.denyPatterns as unknown[]).filter((p): p is string => typeof p === 'string')
        : [];

      elements.push({
        type: element.type,
        name: element.name,
        allow_patterns: allowPatterns,
        confirm_patterns: confirmPatterns,
        deny_patterns: denyPatterns,
      });

      combinedAllow.push(...allowPatterns);
      combinedConfirm.push(...confirmPatterns);
      combinedDeny.push(...denyPatterns);
    }

    return {
      active_element_count: elements.length,
      ...(ensembleName ? { ensemble_name: ensembleName } : {}),
      elements,
      combined_allow_patterns: [...new Set(combinedAllow)],
      combined_confirm_patterns: [...new Set(combinedConfirm)],
      combined_deny_patterns: [...new Set(combinedDeny)],
    };
  }
}
