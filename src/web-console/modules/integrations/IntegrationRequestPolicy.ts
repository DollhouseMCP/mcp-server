import type { Gatekeeper } from '../../../handlers/mcp-aql/Gatekeeper.js';
import type { ActiveElement } from '../../../handlers/mcp-aql/policies/index.js';
import { resolveCliApprovalPolicy } from '../../../handlers/mcp-aql/OperationSummary.js';
import {
  assessRisk,
  classifyTool,
  evaluateCliToolPolicy,
} from '../../../handlers/mcp-aql/policies/ToolClassification.js';

const INTEGRATION_TOOL_NAME = 'integration_request';

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
      return this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: elementDecision.message ?? 'Integration request requires approval by policy.',
        denyReason: elementDecision.message ?? 'Integration request requires approval by policy.',
        policySource: elementDecision.confirmSource ?? 'unknown',
        policyContext: elementDecision.policyContext,
      });
    }

    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    if (approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous')) {
      const policySource = activeElements
        .filter(el => el.metadata.gatekeeper?.externalRestrictions?.approvalPolicy?.requireApproval?.length)
        .map(el => `${el.type}:${el.name}`)
        .join(', ') || 'env:DOLLHOUSE_CLI_APPROVAL_POLICY';
      return this.createApprovalRequest(toolInput, classification, activeElements, {
        reason: classification.reason,
        denyReason: `Tool '${INTEGRATION_TOOL_NAME}' classified as ${classification.riskLevel}: ${classification.reason}`,
        policySource,
        policyContext: elementDecision.policyContext,
      });
    }

    return { allowed: true, policyContext: elementDecision.policyContext };
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
  constructor() {
    super('Integration request policy is temporarily unavailable.');
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
