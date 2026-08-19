import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../handlers/mcp-aql/policies/index.js';
import { resolveCliApprovalPolicy } from '../../../handlers/mcp-aql/OperationSummary.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  assessRisk,
  classifyTool,
  evaluateCliToolPolicy,
} from '../../../handlers/mcp-aql/policies/ToolClassification.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

const INTEGRATION_TOOL_NAME = 'integration_request';
const REMOTE_MCP_DISCOVERY_POLICY_PATH = '_internal:/integration/remote_mcp_discovery';

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
  constructor(private readonly options: IntegrationRequestPolicyEnforcerOptions) {}

  async authorize(input: IntegrationRequestPolicyInput): Promise<IntegrationRequestPolicyDecision> {
    try {
      return await this.evaluateAuthorization(input);
    } catch (error) {
      if (error instanceof IntegrationPolicyUnavailableError) throw error;
      throw new IntegrationPolicyUnavailableError(error);
    }
  }

  private async evaluateAuthorization(input: IntegrationRequestPolicyInput): Promise<IntegrationRequestPolicyDecision> {
    const toolInput = integrationToolInput(input);
    const readWriteClass = toolInput.read_write_class === 'read' ? 'read' : 'write';
    const existingApproval = await this.checkExistingApproval(toolInput, readWriteClass);
    if (existingApproval) {
      return {
        allowed: true,
        approvalContext: {
          requestId: existingApproval.requestId,
          scope: existingApproval.scope,
        },
      };
    }

    const activeElements = await this.options.getActiveElements();
    const classification = classifyTool(INTEGRATION_TOOL_NAME, toolInput);
    const elementDecision = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, toolInput, activeElements);
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
    if (elementDecision.behavior === 'confirm') {
      const decision = await this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: elementDecision.message ?? 'Integration request requires approval by policy.',
        denyReason: elementDecision.message ?? 'Integration request requires approval by policy.',
        policySource: elementDecision.confirmSource ?? 'unknown',
        policyContext: elementDecision.policyContext,
      });
      return decision;
    }

    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    if (approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous')) {
      const policySource = activeElements
        .filter(el => el.metadata.gatekeeper?.externalRestrictions?.approvalPolicy?.requireApproval?.length)
        .map(el => `${el.type}:${el.name}`)
        .join(', ') || 'env:DOLLHOUSE_CLI_APPROVAL_POLICY';
      const decision = await this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: classification.reason,
        denyReason: `Tool '${INTEGRATION_TOOL_NAME}' classified as ${classification.riskLevel}: ${classification.reason}`,
        policySource,
        policyContext: elementDecision.policyContext,
      });
      return decision;
    }

    return { allowed: true, policyContext: elementDecision.policyContext };
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
      const existingApproval = await this.checkExistingApproval(toolInput, 'read');
      if (existingApproval) return this.auditDiscovery(provider, true);
      const activeElements = await this.options.getActiveElements();
      const elementDecision = evaluateCliToolPolicy(INTEGRATION_TOOL_NAME, toolInput, activeElements);
      if (elementDecision.behavior === 'deny' || elementDecision.behavior === 'confirm') {
        return this.auditDiscovery(provider, false);
      }
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

  private async checkExistingApproval(toolInput: Record<string, unknown>, readWriteClass: 'read' | 'write') {
    try {
      return await this.options.gatekeeper.checkCliApprovalForInput(INTEGRATION_TOOL_NAME, toolInput, {
        allowToolSession: readWriteClass === 'read',
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
      readonly reason: string;
      readonly denyReason: string;
      readonly policySource: string;
      readonly policyContext: unknown;
    },
  ): Promise<IntegrationRequestPolicyDecision> {
    const risk = assessRisk(INTEGRATION_TOOL_NAME, toolInput, classification);
    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    const requestId = await this.options.gatekeeper.createCliApprovalRequest({
      toolName: INTEGRATION_TOOL_NAME,
      toolInput,
      riskLevel: classification.riskLevel,
      riskScore: risk.score,
      irreversible: risk.irreversible,
      denyReason: request.denyReason,
      policySource: request.policySource,
      ttlMs: approvalPolicy.ttlSeconds ? approvalPolicy.ttlSeconds * 1000 : undefined,
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
  const method = input.method.toUpperCase();
  return {
    provider: input.provider,
    method,
    path: input.path,
    read_write_class: method === 'GET' ? 'read' : 'write',
    ...(input.query ? { query: input.query } : {}),
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}
