import { DOLLHOUSE_MCP_SERVER_NAMES } from '../../../config/constants.js';
import { matchesPattern } from '../../../utils/patternMatcher.js';
import type { IntegrationInvocationContext } from '../../../security/IntegrationEntryPoint.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { BASE_OPERATION_REGISTRY, type OperationRegistry } from '../../../handlers/mcp-aql/OperationRegistry.js';
import { PermissionLevel, type CliApprovalScope } from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import { resolveElementPolicy } from '../../../handlers/mcp-aql/policies/ElementPolicies.js';
import type { IntegrationManagementOperation } from '../../../handlers/mcp-aql/IntegrationManagementOperations.js';

import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../handlers/mcp-aql/policies/index.js';
import { resolveCliApprovalPolicy } from '../../../handlers/mcp-aql/OperationSummary.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  assessRisk,
  classifyTool,
  evaluateCliToolPolicy,
} from '../../../handlers/mcp-aql/policies/ToolClassification.js';
import {
  canonicalizeIntegrationRequestPath,
  IntegrationRequestPathError,
  type CanonicalIntegrationRequestPath,
} from './IntegrationRequestPath.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

const INTEGRATION_TOOL_NAME = 'integration_request';
const INTERNAL_INTEGRATION_POLICY_PREFIX = '_internal:/integration/';
const REMOTE_MCP_DISCOVERY_POLICY_PATH = '_internal:/integration/remote_mcp_discovery';

export interface IntegrationManagementPolicyContext {
  readonly operation: IntegrationManagementOperation;
  readonly operations: OperationRegistry;
  readonly legacyPath: string;
}

export interface IntegrationRequestPolicyInput {
  readonly provider: string;
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export interface IntegrationRequestPolicyDecision {
  readonly allowed: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly status: number;
  };
  readonly approvalRequest?: {
    readonly requestId: string;
    readonly toolName: string;
    readonly riskLevel: string;
    readonly riskScore: number;
    readonly irreversible: boolean;
    readonly reason: string;
    readonly allowedScopes?: readonly CliApprovalScope[];
  };
  readonly approvalContext?: {
    readonly requestId: string;
    readonly scope: string;
  };
  readonly policyContext?: unknown;
}

export interface IntegrationRequestPolicyEnforcerOptions {
  readonly gatekeeper: Gatekeeper;
  readonly getActiveElements: () => Promise<ActiveElement[]>;
}

export class IntegrationRequestPolicyEnforcer {
  private readonly warnedLegacyPatterns = new Set<string>();
  constructor(private readonly options: IntegrationRequestPolicyEnforcerOptions) {}

  async authorize(input: IntegrationRequestPolicyInput, management?: IntegrationManagementPolicyContext, context?: IntegrationInvocationContext): Promise<IntegrationRequestPolicyDecision> {
    try {
      return await this.evaluateAuthorization(input, management, context);
    } catch (error) {
      if (error instanceof IntegrationPolicyUnavailableError) throw error;
      throw new IntegrationPolicyUnavailableError(error);
    }
  }

  private async evaluateAuthorization(input: IntegrationRequestPolicyInput, management?: IntegrationManagementPolicyContext, context?: IntegrationInvocationContext): Promise<IntegrationRequestPolicyDecision> {
    let toolInput: Record<string, unknown>;
    try {
      toolInput = integrationToolInput(input);
    } catch (error) {
      if (!(error instanceof IntegrationRequestPathError)) throw error;
      return {
        allowed: false,
        error: {
          code: error.code,
          message: error.message,
          status: error.status,
        },
      };
    }
    const readWriteClass = toolInput.read_write_class === 'read' ? 'read' : 'write';
    const activeElements = await this.options.getActiveElements();
    const classification = classifyTool(INTEGRATION_TOOL_NAME, toolInput);
    const elementDecision = this.evaluateManagementPolicy(toolInput, activeElements, management);
    if (elementDecision.behavior === 'deny') {
      return {
        allowed: false,
        error: {
          code: 'integration_request_denied_by_policy',
          message: elementDecision.message ?? 'Integration request denied by policy.',
          status: 403,
        },
        policyContext: elementDecision.policyContext,
      };
    }
    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    const requiresSingleUse = elementDecision.requiresSingleUse === true ||
      (!management && readWriteClass === 'read' && elementDecision.behavior === 'confirm') ||
      approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous') === true;
    const allowInputSession = !requiresSingleUse &&
      (management ? management.operation.startsWith('create_') : readWriteClass === 'read');
    const existingApproval = await this.checkExistingApproval(toolInput, allowInputSession, context);
    if (existingApproval) {
      return {
        allowed: true,
        approvalContext: {
          requestId: existingApproval.requestId,
          scope: existingApproval.scope,
        },
        policyContext: elementDecision.policyContext,
      };
    }
    const defaultWriteApproval = !management && readWriteClass === 'write' &&
      !input.path.startsWith(INTERNAL_INTEGRATION_POLICY_PREFIX) && env.DOLLHOUSE_INTEGRATION_WRITE_APPROVAL !== 'off';
    if (management || elementDecision.behavior === 'confirm' || defaultWriteApproval) {
      return this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: elementDecision.message ?? 'Integration request requires approval by policy.',
        denyReason: elementDecision.message ?? 'Integration request requires approval by policy.',
        policySource: elementDecision.confirmSource ?? (defaultWriteApproval ? 'default:integration_write' : 'unknown'),
        policyContext: elementDecision.policyContext,
        context,
        allowInputSession,
      });
    }

    if (approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous')) {
      const policySource = activeElements
        .filter(el => el.metadata.gatekeeper?.externalRestrictions?.approvalPolicy?.requireApproval?.length)
        .map(el => `${el.type}:${el.name}`)
        .join(', ') || 'env:DOLLHOUSE_CLI_APPROVAL_POLICY';
      return this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: classification.reason,
        denyReason: `Tool '${INTEGRATION_TOOL_NAME}' classified as ${classification.riskLevel}: ${classification.reason}`,
        policySource,
        context,
        policyContext: elementDecision.policyContext,
      });
    }

    return { allowed: true, policyContext: elementDecision.policyContext };
  }

  private evaluateManagementPolicy(
    toolInput: Record<string, unknown>, activeElements: ActiveElement[], management?: IntegrationManagementPolicyContext,
  ): ReturnType<typeof evaluateCliToolPolicy> & { readonly requiresSingleUse?: boolean } {
    this.warnLegacyPatterns(activeElements);
    if (!management) return this.evaluateRequestPolicy(toolInput, activeElements);
    // Only explicit legacy denies carry forward. Old allows/confirmations are
    // deliberately excluded from this compatibility projection.
    const legacyDenies = activeElements.map(element => ({ ...element, metadata: { ...element.metadata,
      gatekeeper: { externalRestrictions: { description: 'Legacy management denies', denyPatterns: element.metadata.gatekeeper?.externalRestrictions?.denyPatterns } },
    } }));
    const legacy = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, { ...toolInput, path: management.legacyPath }, legacyDenies);
    if (legacy.behavior === 'deny') return legacy;
    const external = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, toolInput, activeElements);
    if (external.behavior === 'deny') return external;
    const operation = resolveElementPolicy(management.operation,
      this.options.gatekeeper.allowsElementPolicyOverrides() ? activeElements : [], undefined, management.operations);
    if (operation.permissionLevel === PermissionLevel.DENY) {
      return { ...external, behavior: 'deny', message: 'Integration management operation denied by active element policy.' };
    }
    if (operation.matchedPolicy === 'confirm') {
      return { ...external, behavior: 'confirm', message: 'Integration management operation requires approval by active element policy.', confirmSource: operation.sourceElement };
    }
    return external;
  }

  private evaluateRequestPolicy(toolInput: Record<string, unknown>, activeElements: ActiveElement[]):
    ReturnType<typeof evaluateCliToolPolicy> & { readonly requiresSingleUse?: boolean } {
    const external = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, toolInput, activeElements);
    if (external.behavior === 'deny' || (typeof toolInput.path === 'string' && toolInput.path.startsWith(INTERNAL_INTEGRATION_POLICY_PREFIX))) return external;
    const operation = resolveElementPolicy(INTEGRATION_TOOL_NAME,
      this.options.gatekeeper.allowsElementPolicyOverrides() ? activeElements : [], undefined, BASE_OPERATION_REGISTRY);
    if (operation.permissionLevel === PermissionLevel.DENY) {
      return { ...external, behavior: 'deny', message: 'Integration request denied by active element policy.' };
    }
    if (operation.matchedPolicy === 'confirm') {
      return { ...external, behavior: 'confirm', requiresSingleUse: true,
        message: 'Integration request requires approval by active element policy.', confirmSource: operation.sourceElement };
    }
    return external;
  }

  private warnLegacyPatterns(activeElements: ActiveElement[]): void {
    if (env.MCP_INTERFACE_MODE !== 'mcpaql') return;
    for (const element of activeElements) {
      const policy = element.metadata.gatekeeper;
      for (const action of ['deny', 'confirm', 'allow'] as const) {
        const patterns = [...(policy?.[action] ?? []), ...(policy?.externalRestrictions?.[`${action}Patterns`] ?? [])];
        for (const pattern of patterns) {
          this.warnLegacyPattern(element, action, pattern);
        }
      }
    }
  }

  private warnLegacyPattern(element: ActiveElement, action: 'allow' | 'deny' | 'confirm', pattern: string): void {
    if (!targetsLegacyIntegrationTool(pattern)) return;
    const key = JSON.stringify([element.type, element.name, element.metadata.version, action, pattern]);
    if (this.warnedLegacyPatterns.has(key)) return;
    if (this.warnedLegacyPatterns.size >= 512) {
      const oldest = this.warnedLegacyPatterns.values().next().value;
      if (oldest !== undefined) this.warnedLegacyPatterns.delete(oldest);
    }
    this.warnedLegacyPatterns.add(key);
    logger.warn(`Integration policy on ${element.type}:${element.name} targets the old prefixed integration_request tool name. In MCP-AQL mode use gatekeeper.${action}: ['integration_request']; patterns are not rewritten.`);
  }

  /**
   * Side-effect-free policy check for remote-MCP tool discovery — the
   * session-start credentialed egress that decrypts a descriptor's bearer
   * token and connects outbound to list its tools. Unlike `authorize()`, this
   * NEVER creates an approval request (discovery runs at session
   * establishment where nobody is present to approve, and creating one per
   * session would flood the approval queue). A standing approval counts;
   * anything policy would deny or ask confirmation for — including policy
   * evaluation being unavailable — fails closed to `false`, and the caller
   * skips discovery for that provider.
   */
  async evaluateDiscovery(provider: string): Promise<boolean> {
    try {
      const toolInput = integrationToolInput({
        provider,
        method: 'GET',
        path: REMOTE_MCP_DISCOVERY_POLICY_PATH,
      });
      const activeElements = await this.options.getActiveElements();
      const elementDecision = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, toolInput, activeElements);
      if (elementDecision.behavior === 'deny') return this.auditDiscovery(provider, false);
      const existingApproval = await this.checkExistingApproval(toolInput, elementDecision.behavior !== 'confirm');
      if (existingApproval) return this.auditDiscovery(provider, true);
      if (elementDecision.behavior === 'confirm') return this.auditDiscovery(provider, false);
      const classification = classifyTool(INTEGRATION_TOOL_NAME, toolInput);
      const approvalPolicy = resolveCliApprovalPolicy(activeElements);
      return this.auditDiscovery(
        provider,
        !approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous'),
      );
    } catch {
      return this.auditDiscovery(provider, false);
    }
  }

  private auditDiscovery(provider: string, allowed: boolean): boolean {
    SecurityMonitor.logSecurityEvent({
      type: 'INTEGRATION_SECURITY_DECISION',
      severity: allowed ? 'LOW' : 'MEDIUM',
      source: 'IntegrationRequestPolicyEnforcer.evaluateDiscovery',
      details: `Integration discovery ${allowed ? 'allowed' : 'denied'} for provider ${safeIntegrationAuditProvider(provider)}`,
    });
    return allowed;
  }

  private async checkExistingApproval(toolInput: Record<string, unknown>, allowInputSession = false, context?: IntegrationInvocationContext) {
    try {
      return await this.options.gatekeeper.checkCliApprovalForInput(INTEGRATION_TOOL_NAME, toolInput, {
        entry_point: context?.entry_point,
        allowToolSession: false,
        allowInputSession,
      });
    } catch {
      throw new IntegrationPolicyUnavailableError();
    }
  }

  private async createApprovalRequest(
    toolInput: Record<string, unknown>,
    classification: ReturnType<typeof classifyTool>,
    activeElements: ActiveElement[],
    request: {
      readonly context?: IntegrationInvocationContext;
      readonly reason: string;
      readonly denyReason: string;
      readonly policySource: string;
      readonly policyContext: unknown;
      readonly allowInputSession?: boolean;
    },
  ): Promise<IntegrationRequestPolicyDecision> {
    const risk = assessRisk(INTEGRATION_TOOL_NAME, toolInput, classification);
    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    const allowedScopes: readonly CliApprovalScope[] = request.allowInputSession ? ['single', 'input_session'] : ['single'];
    const requestId = await this.options.gatekeeper.createCliApprovalRequest({
      entry_point: request.context?.entry_point,
      toolName: INTEGRATION_TOOL_NAME,
      toolInput,
      riskLevel: classification.riskLevel,
      riskScore: risk.score,
      irreversible: risk.irreversible,
      denyReason: request.denyReason,
      policySource: request.policySource,
      ttlMs: approvalPolicy.ttlSeconds ? approvalPolicy.ttlSeconds * 1000 : undefined,
      allowedScopes,
    });
    return {
      allowed: false,
      error: {
        code: 'integration_request_approval_required',
        message: `Integration request requires human approval. Request ID: ${requestId}.`,
        status: 403,
      },
      approvalRequest: {
        requestId,
        toolName: INTEGRATION_TOOL_NAME,
        riskLevel: classification.riskLevel,
        riskScore: risk.score,
        irreversible: risk.irreversible,
        reason: request.reason,
        allowedScopes,
      },
      policyContext: request.policyContext,
    };
  }
}

export class IntegrationPolicyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Integration request policy is temporarily unavailable.', cause === undefined ? undefined : { cause });
    this.name = 'IntegrationPolicyUnavailableError';
  }
}

function integrationToolInput(input: IntegrationRequestPolicyInput): Record<string, unknown> {
  const canonicalPath = canonicalizePolicyPath(input.path);
  const method = input.method.toUpperCase();
  return {
    provider: input.provider,
    method,
    path: canonicalPath.pathname,
    ...(canonicalPath.search ? { path_query: canonicalPath.search } : {}),
    read_write_class: method === 'GET' ? 'read' : 'write',
    ...(input.query ? { query: input.query } : {}),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

function canonicalizePolicyPath(path: string): CanonicalIntegrationRequestPath {
  if (!path.startsWith(INTERNAL_INTEGRATION_POLICY_PREFIX)) {
    return canonicalizeIntegrationRequestPath(path);
  }
  const canonical = canonicalizeIntegrationRequestPath(`/${path}`);
  return {
    pathname: canonical.pathname.slice(1),
    search: canonical.search,
  };
}


function targetsLegacyIntegrationTool(pattern: string): boolean {
  if (!pattern.startsWith('mcp__')) return false;
  const toolPattern = pattern.split(':', 1)[0];
  const separator = toolPattern.lastIndexOf('__');
  // Use the existing glob semantics for both a server-wide and global MCP wildcard.
  const target = separator === 3 ? `mcp__${DOLLHOUSE_MCP_SERVER_NAMES[0]}__integration_request`
    : toolPattern.slice(0, separator + 2) + 'integration_request';
  return matchesPattern(target, toolPattern);
}
