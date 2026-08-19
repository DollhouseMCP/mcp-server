import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  type IntegrationRequestGateway,
  type IntegrationRequestInput,
  type IntegrationRequestResult,
} from './IntegrationRequestGateway.js';
import {
  IntegrationPolicyUnavailableError,
  type IntegrationRequestPolicyDecision,
  type IntegrationRequestPolicyEnforcer,
} from './IntegrationRequestPolicy.js';
import {
  type IntegrationOperationCatalog,
  type IntegrationGeneratedSkillInput,
  type IntegrationOpenApiIngestInput,
  type IntegrationOpenApiIngestResult,
  type IntegrationOperationCatalogResult,
  type IntegrationOperationDescribeInput,
  type IntegrationOperationDetails,
  type IntegrationOperationListInput,
  type IntegrationPromotedOperationListInput,
  type GeneratedIntegrationSkillWriteResult,
} from './IntegrationOperationCatalog.js';
import {
  type IntegrationRemoteMcpBridge,
  type RemoteMcpCallInput,
  type RemoteMcpCallResult,
  type RemoteMcpTool,
} from './IntegrationRemoteMcpBridge.js';
import { safeIntegrationAuditProvider } from './IntegrationSecurityAudit.js';

/**
 * Policy-authorized facades over the integration execution authorities.
 *
 * The raw gateway, remote-MCP bridge, and operation catalog execute without
 * consulting policy; historically every tool handler had to remember to call
 * the policy enforcer first, and any caller that forgot silently bypassed all
 * approval/gatekeeper gating (finding FO2). These facades fold the policy
 * check into the only invocation path: DI hands out the facades exclusively,
 * the raw authorities are not exported from the module barrel, and each
 * facade requires its enforcer at construction — an un-gated authority is
 * unrepresentable rather than merely discouraged.
 *
 * For `request()` the facade passes the SAME input object to `authorize()`
 * and to the downstream call, so the exact-input HMAC that approval
 * verification binds to always matches what is actually executed. The
 * management-write facades (ingestOpenApiSpec / regenerateSkill / remote-MCP
 * callTool) authorize on a synthetic `_internal:/...` sentinel target
 * carrying the behavior-changing content (the spec and regenerate flag, or
 * the tool arguments). Provenance-only `sourceUrl` remains outside the bound
 * scope, and the sentinel path is gateway-rejectable so a management approval
 * can never be replayed as a real integration_request.
 */

type PolicyErrorShape = NonNullable<IntegrationRequestPolicyDecision['error']>;

export interface IntegrationPolicyDenial {
  readonly ok: false;
  readonly error: PolicyErrorShape;
  readonly approvalRequest?: NonNullable<IntegrationRequestPolicyDecision['approvalRequest']>;
  readonly policyContext?: unknown;
}

export interface IntegrationAuthorizedSuccess<T> {
  readonly ok: true;
  readonly result: T;
  readonly approvalContext?: NonNullable<IntegrationRequestPolicyDecision['approvalContext']>;
}

export type IntegrationAuthorizedOutcome<T> = IntegrationAuthorizedSuccess<T> | IntegrationPolicyDenial;

const POLICY_UNAVAILABLE_ERROR: PolicyErrorShape = {
  code: 'integration_request_policy_unavailable',
  message: 'Integration request policy is temporarily unavailable.',
  status: 503,
};

const POLICY_DENIED_FALLBACK_ERROR: PolicyErrorShape = {
  code: 'integration_request_denied_by_policy',
  message: 'Integration request denied by policy.',
  status: 403,
};

export const INTEGRATION_OPENAPI_SPEC_POLICY_PATH = '_internal:/integration/openapi_spec';
export const INTEGRATION_GENERATED_SKILL_POLICY_PATH = '_internal:/integration/generated_skill';
export const INTEGRATION_REMOTE_MCP_POLICY_PATH_PREFIX = '_internal:/integration/remote_mcp/';

export class AuthorizedIntegrationGateway {
  constructor(private readonly options: {
    readonly gateway: IntegrationRequestGateway;
    readonly policyEnforcer: IntegrationRequestPolicyEnforcer;
  }) {}

  async request(input: IntegrationRequestInput): Promise<IntegrationAuthorizedOutcome<IntegrationRequestResult>> {
    const decision = await authorizeOrDeny(this.options.policyEnforcer, input);
    if (!decision.authorized) return decision.denial;
    const result = await this.options.gateway.request(input);
    return {
      ok: true,
      result,
      ...(decision.approvalContext ? { approvalContext: decision.approvalContext } : {}),
    };
  }
}

export class AuthorizedIntegrationOperationCatalog {
  constructor(private readonly options: {
    readonly catalog: IntegrationOperationCatalog;
    readonly policyEnforcer: IntegrationRequestPolicyEnforcer;
  }) {}

  async ingestOpenApiSpec(input: IntegrationOpenApiIngestInput): Promise<IntegrationAuthorizedOutcome<IntegrationOpenApiIngestResult>> {
    // `path` is a gateway-rejectable `_internal:/...` sentinel (not a real absolute path),
    // so a management-write approval can never be replayed as a real integration_request call.
    const decision = await authorizeOrDeny(this.options.policyEnforcer, {
      provider: input.provider,
      method: 'PUT',
      path: INTEGRATION_OPENAPI_SPEC_POLICY_PATH,
      body: {
        spec: input.spec,
        regenerateSkill: input.regenerateSkill === true,
      },
    });
    if (!decision.authorized) return decision.denial;
    const result = await this.options.catalog.ingestOpenApiSpec(input);
    return {
      ok: true,
      result,
      ...(decision.approvalContext ? { approvalContext: decision.approvalContext } : {}),
    };
  }

  async regenerateSkill(input: IntegrationGeneratedSkillInput): Promise<IntegrationAuthorizedOutcome<GeneratedIntegrationSkillWriteResult>> {
    const decision = await authorizeOrDeny(this.options.policyEnforcer, {
      provider: input.provider,
      method: 'PUT',
      path: INTEGRATION_GENERATED_SKILL_POLICY_PATH,
    });
    if (!decision.authorized) return decision.denial;
    const result = await this.options.catalog.regenerateSkill(input);
    return {
      ok: true,
      result,
      ...(decision.approvalContext ? { approvalContext: decision.approvalContext } : {}),
    };
  }

  listOperations(input: IntegrationOperationListInput): Promise<IntegrationOperationCatalogResult> {
    return this.options.catalog.listOperations(input);
  }

  describeOperation(input: IntegrationOperationDescribeInput): Promise<IntegrationOperationDetails> {
    return this.options.catalog.describeOperation(input);
  }

  listPromotedOperations(input: IntegrationPromotedOperationListInput = {}): Promise<readonly IntegrationOperationDetails[]> {
    return this.options.catalog.listPromotedOperations(input);
  }
}

export class AuthorizedIntegrationRemoteMcpBridge {
  constructor(private readonly options: {
    readonly bridge: IntegrationRemoteMcpBridge;
    readonly policyEnforcer: IntegrationRequestPolicyEnforcer;
  }) {}

  /**
   * Discovery is gated inside the raw bridge per descriptor (its required
   * `discoveryGate` option), because the descriptor set is only enumerable
   * there; this passthrough exists so callers never hold the raw bridge.
   */
  listAllowedTools(): Promise<readonly RemoteMcpTool[]> {
    return this.options.bridge.listAllowedTools();
  }

  async callTool(input: RemoteMcpCallInput): Promise<IntegrationAuthorizedOutcome<RemoteMcpCallResult>> {
    const decision = await authorizeOrDeny(this.options.policyEnforcer, {
      provider: input.provider,
      method: 'PUT',
      path: `${INTEGRATION_REMOTE_MCP_POLICY_PATH_PREFIX}${encodeURIComponent(input.remoteName)}`,
      body: policyArguments(input.arguments),
    });
    if (!decision.authorized) return decision.denial;
    const result = await this.options.bridge.callTool(input);
    return {
      ok: true,
      result,
      ...(decision.approvalContext ? { approvalContext: decision.approvalContext } : {}),
    };
  }
}

type AuthorizeDecision =
  | { readonly authorized: true; readonly approvalContext?: NonNullable<IntegrationRequestPolicyDecision['approvalContext']> }
  | { readonly authorized: false; readonly denial: IntegrationPolicyDenial };

async function authorizeOrDeny(
  policyEnforcer: IntegrationRequestPolicyEnforcer,
  input: Parameters<IntegrationRequestPolicyEnforcer['authorize']>[0],
): Promise<AuthorizeDecision> {
  let policy: IntegrationRequestPolicyDecision;
  try {
    policy = await policyEnforcer.authorize(input);
  } catch (error) {
    auditAuthorization('unavailable');
    if (error instanceof IntegrationPolicyUnavailableError) {
      return { authorized: false, denial: { ok: false, error: POLICY_UNAVAILABLE_ERROR } };
    }
    throw error;
  }
  if (policy.allowed) {
    auditAuthorization('allowed');
    return {
      authorized: true,
      ...(policy.approvalContext ? { approvalContext: policy.approvalContext } : {}),
    };
  }
  auditAuthorization(policy.approvalRequest ? 'approval_required' : 'denied');
  return {
    authorized: false,
    denial: {
      ok: false,
      error: policy.error ?? POLICY_DENIED_FALLBACK_ERROR,
      ...(policy.approvalRequest ? { approvalRequest: policy.approvalRequest } : {}),
      ...(policy.policyContext === undefined ? {} : { policyContext: policy.policyContext }),
    },
  };
}

function auditAuthorization(outcome: 'allowed' | 'denied' | 'approval_required' | 'unavailable'): void {
  SecurityMonitor.logSecurityEvent({
    type: 'INTEGRATION_SECURITY_DECISION',
    severity: outcome === 'allowed' ? 'LOW' : 'MEDIUM',
    source: 'AuthorizedIntegrationGateway',
    // This facade runs before descriptor resolution, so provider is still raw
    // caller input and must never be echoed into the audit event.
    details: `Authorized integration decision ${outcome} for provider ${safeIntegrationAuditProvider('<unresolved>')}`,
  });
}

function policyArguments(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
