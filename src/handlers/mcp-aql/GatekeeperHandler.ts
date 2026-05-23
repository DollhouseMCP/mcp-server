import { randomUUID } from 'node:crypto';
import { generateDisplayCode } from '@dollhousemcp/safety';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { getPermissionHookStatus } from '../../utils/permissionHooks.js';
import {
  PERMISSION_AUTHORITY_HOSTS,
  PERMISSION_AUTHORITY_MODES,
  readPermissionAuthorityState,
} from '../../utils/permissionAuthority.js';
import type { RateLimitStatus, RateLimiter } from '../../utils/RateLimiter.js';
import type { Gatekeeper } from './Gatekeeper.js';
import {
  PermissionLevel,
  GatekeeperErrorCode,
  type CliApprovalScope,
} from './GatekeeperTypes.js';
import type { ActiveElement } from './policies/index.js';
import {
  findConfirmAdvisoryElements,
  findConfirmDenyingElement,
  getGatekeeperDiagnostics,
} from './policies/ElementPolicies.js';
import {
  assessRisk,
  classifyTool,
  evaluateCliToolPolicy,
} from './policies/ToolClassification.js';
import type { CRUDEndpoint } from './OperationRouter.js';
import type { CorrelationIdProvider, HandlerRegistry } from './MCPAQLHandler.js';
import { normalizeMCPAQLElementType } from './types.js';
import { type ExecutingAgentEntry, validateRequiredString } from './shared.js';
import {
  buildInvalidPolicyAdvisory,
  buildOperationSummary,
  resolveCliApprovalPolicy,
} from './OperationSummary.js';

interface VerificationMetricsRecorder {
  recordAttempt(): void;
  recordSuccess(durationMs?: number): void;
  recordFailure(): void;
  recordExpired(): void;
  recordInvalidFormat(): void;
  recordRateLimited(): void;
}

interface VerificationLimiter {
  recordFailure(): boolean;
  isLimited(): boolean;
}

export interface GatekeeperHandlerDeps {
  handlers: HandlerRegistry;
  gatekeeper: Gatekeeper;
  contextTracker?: CorrelationIdProvider;
  executingAgents: Map<string, ExecutingAgentEntry>;
  verificationMetrics: VerificationMetricsRecorder;
  getActiveElements(sessionId?: string): Promise<ActiveElement[]>;
  getPolicyReportElements(sessionId?: string): Promise<ActiveElement[]>;
  getEndpointForOperation(operation: string): CRUDEndpoint;
  issueDeadlockReliefChallenge(): unknown;
  completeDeadlockRelief(challengeId: string, code: string): Promise<unknown>;
  resolveVerificationRateLimiter(): VerificationLimiter;
  resolvePermissionPromptLimiter(): RateLimiter;
  resolveCliApprovalLimiter(): RateLimiter;
  buildRateLimitDeny(
    limiterName: string,
    toolName: string,
    status: RateLimitStatus,
    riskLevel?: string,
    reason?: string,
  ): Record<string, unknown>;
}

const VERIFY_SOURCE = 'MCPAQLHandler.dispatchGatekeeper.verify';
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEADLOCK_RELIEF_REASON = 'Deadlock relief requested';

class VerificationError extends Error {
  constructor(
    public readonly errorCode: GatekeeperErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}

function validateChallengeIdFormat(challengeId: string): void {
  if (!UUID_V4_REGEX.test(challengeId)) {
    throw new VerificationError(
      GatekeeperErrorCode.VERIFICATION_FAILED,
      `Invalid challenge_id format. Expected UUID v4 (e.g., "550e8400-e29b-41d4-a716-446655440000").`
    );
  }
}

function challengeIsForDeadlockRelief(challenge: { reason: string } | undefined): boolean {
  return typeof challenge?.reason === 'string' && challenge.reason.startsWith(DEADLOCK_RELIEF_REASON);
}

function resolveFinalBehavior(
  policyBehavior: string | undefined,
  toolBehavior: string,
): 'deny' | 'allow' {
  if (policyBehavior === 'deny') return 'deny';
  if (toolBehavior === 'deny') return 'deny';
  return 'allow';
}

export class GatekeeperHandler {
  constructor(private readonly deps: GatekeeperHandlerDeps) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handlers: Record<string, () => unknown> = {
      confirm: () => this.confirm(params),
      verify: () => this.verify(params),
      releaseDeadlock: () => this.releaseDeadlock(params),
      beetlejuice: () => this.beetlejuice(params),
      permissionPrompt: () => this.permissionPrompt(params),
      evaluatePermission: () => this.evaluatePermission(params),
      getEffectiveCliPolicies: () => this.getEffectiveCliPolicies(params),
      getPermissionAuthority: () => this.getPermissionAuthority(params),
      approveCliPermission: () => this.approveCliPermission(params),
      getPendingCliApprovals: () => this.getPendingCliApprovals(),
    };
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown Gatekeeper method: ${method}`);
    }
    return handler();
  }

  private async confirm(params: Record<string, unknown>): Promise<unknown> {
    const operation = validateRequiredString(
      params,
      'operation',
      'the operation name to confirm (e.g. "create_element")'
    );
    const rawElementType = params.element_type as string | undefined;
    const elementType = rawElementType
      ? normalizeMCPAQLElementType(rawElementType) ?? rawElementType
      : undefined;
    const summary = buildOperationSummary(operation, elementType, params);
    const activeElements = await this.deps.getActiveElements();

    this.enforceConfirmationSandbox(operation, elementType, activeElements);
    const advisoryNote = this.buildConfirmationAdvisory(activeElements);
    const decision = this.deps.gatekeeper.enforce({
      operation,
      endpoint: this.deps.getEndpointForOperation(operation),
      elementType,
      activeElements,
    });

    if (decision.allowed) {
      return {
        confirmed: true,
        message: `Operation "${operation}" is already approved (${decision.policySource ?? 'auto_approve'}). No confirmation needed.`,
        summary,
      };
    }
    if (!decision.confirmationPending) {
      throw new Error(
        `Operation "${operation}" is denied by policy and cannot be confirmed. ${decision.reason}`
      );
    }

    const level = decision.permissionLevel === PermissionLevel.CONFIRM_SINGLE_USE
      ? PermissionLevel.CONFIRM_SINGLE_USE
      : PermissionLevel.CONFIRM_SESSION;
    this.deps.gatekeeper.recordConfirmation(operation, level, elementType);
    this.clearAgentBlocks(operation, elementType);

    return {
      confirmed: true,
      message: `Confirmed: ${summary}.${advisoryNote}`,
      rationale: decision.reason,
      scope: elementType ? `Scoped to element type: ${elementType}` : 'All element types',
      level: level === PermissionLevel.CONFIRM_SINGLE_USE ? 'single_use' : 'session',
      summary,
    };
  }

  private enforceConfirmationSandbox(
    operation: string,
    elementType: string | undefined,
    activeElements: ActiveElement[]
  ): void {
    const denyingElement = findConfirmDenyingElement(activeElements);
    if (!denyingElement) {
      return;
    }
    logger.info(`[Gatekeeper] Sandbox active: ${denyingElement.type} "${denyingElement.name}" denies confirm_operation`, {
      blockedOperation: operation,
      elementType,
    });
    throw new Error(
      `Operation cannot be confirmed — ${denyingElement.type} "${denyingElement.name}" has sandboxed this session. ` +
      `All confirmations are blocked while this element is active. ` +
      `Deactivate the element to restore confirmation capability.`
    );
  }

  private buildConfirmationAdvisory(activeElements: ActiveElement[]): string {
    const advisoryElements = findConfirmAdvisoryElements(activeElements);
    const advisoryList = advisoryElements.map(e => `${e.type} "${e.name}"`).join(', ');
    return advisoryElements.length > 0
      ? ` Note: ${advisoryList} request additional scrutiny for confirmations.`
      : '';
  }

  private clearAgentBlocks(operation: string, elementType: string | undefined): void {
    for (const [, agentEntry] of this.deps.executingAgents) {
      agentEntry.recentBlocks = agentEntry.recentBlocks.filter(
        b => b.operation !== operation || (elementType && b.elementType !== elementType)
      );
    }
  }

  private async verify(params: Record<string, unknown>): Promise<unknown> {
    this.deps.verificationMetrics.recordAttempt();
    const attemptTimestamp = Date.now();
    const challengeId = validateRequiredString(params, 'challenge_id', 'the verification challenge ID');
    const code = validateRequiredString(params, 'code', 'the verification code displayed on your screen');

    this.logVerificationAttempt(challengeId);
    this.checkVerificationRateLimit(challengeId);
    this.validateChallengeId(challengeId);

    const store = this.deps.handlers.verificationStore;
    if (!store) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_FAILED,
        'Verification system not available. Ensure the server is properly configured.'
      );
    }

    const challengePreCheck = this.getChallengePreCheck(store, challengeId);
    this.validateChallengeSessionOwner(challengeId);
    if (challengeIsForDeadlockRelief(challengePreCheck)) {
      throw new VerificationError(
        GatekeeperErrorCode.VERIFICATION_FAILED,
        'This verification code is reserved for deadlock relief. Use release_deadlock with challenge_id and code to complete the reset.'
      );
    }

    this.verifyCode(store, challengeId, code);
    const verifyDurationMs = attemptTimestamp - (challengePreCheck.expiresAt - 5 * 60 * 1000);
    this.deps.verificationMetrics.recordSuccess(verifyDurationMs > 0 ? verifyDurationMs : undefined);
    return this.unblockVerifiedAgent(challengeId);
  }

  private logVerificationAttempt(challengeId: string): void {
    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_ATTEMPTED',
      severity: 'MEDIUM',
      source: VERIFY_SOURCE,
      details: `Verification attempted for challenge ${challengeId}`,
      additionalData: { challengeId },
    });
  }

  private checkVerificationRateLimit(challengeId: string): void {
    if (!this.deps.resolveVerificationRateLimiter().isLimited()) {
      return;
    }
    this.deps.verificationMetrics.recordRateLimited();
    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_FAILED',
      severity: 'HIGH',
      source: VERIFY_SOURCE,
      details: `Verification rate-limited: too many failed attempts (challenge: ${challengeId})`,
      additionalData: { challengeId, reason: 'rate_limited' },
    });
    throw new VerificationError(
      GatekeeperErrorCode.VERIFICATION_FAILED,
      'Too many failed verification attempts. Please wait before trying again.'
    );
  }

  private validateChallengeId(challengeId: string): void {
    try {
      validateChallengeIdFormat(challengeId);
    } catch (error) {
      this.deps.verificationMetrics.recordInvalidFormat();
      this.deps.resolveVerificationRateLimiter().recordFailure();
      SecurityMonitor.logSecurityEvent({
        type: 'VERIFICATION_FAILED',
        severity: 'HIGH',
        source: VERIFY_SOURCE,
        details: `Verification rejected: invalid challenge_id format (${challengeId})`,
        additionalData: { challengeId, reason: 'invalid_format' },
      });
      throw error;
    }
  }

  private getChallengePreCheck(
    store: NonNullable<HandlerRegistry['verificationStore']>,
    challengeId: string
  ): { code: string; expiresAt: number; reason: string } {
    const challengePreCheck = store.get(challengeId);
    if (challengePreCheck) {
      return challengePreCheck;
    }
    this.deps.verificationMetrics.recordExpired();
    this.deps.resolveVerificationRateLimiter().recordFailure();
    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_EXPIRED',
      severity: 'HIGH',
      source: VERIFY_SOURCE,
      details: `Verification failed: challenge ${challengeId} not found (expired, already used, or invalid)`,
      additionalData: { challengeId, reason: 'expired_or_not_found' },
    });
    throw new VerificationError(
      GatekeeperErrorCode.VERIFICATION_TIMEOUT,
      'Verification failed: challenge not found. It may have expired or already been used. ' +
      'Retry the blocked operation to receive a new verification code.'
    );
  }

  private validateChallengeSessionOwner(challengeId: string): void {
    const preCheckSessionId = this.deps.contextTracker?.getSessionContext?.()?.sessionId;
    const enforcer = this.deps.handlers.dangerZoneEnforcer;
    if (!enforcer) {
      return;
    }
    for (const agentName of enforcer.getBlockedAgents()) {
      const blockInfo = enforcer.check(agentName);
      if (blockInfo.verificationId === challengeId && blockInfo.blocked && blockInfo.sessionId && blockInfo.sessionId !== preCheckSessionId) {
        this.deps.verificationMetrics.recordFailure();
        throw new VerificationError(
          GatekeeperErrorCode.VERIFICATION_FAILED,
          'Verification failed: this challenge belongs to a different session.'
        );
      }
    }
  }

  private verifyCode(
    store: NonNullable<HandlerRegistry['verificationStore']>,
    challengeId: string,
    code: string
  ): void {
    if (store.verify(challengeId, code)) {
      return;
    }
    this.deps.verificationMetrics.recordFailure();
    const rateLimitExceeded = this.deps.resolveVerificationRateLimiter().recordFailure();
    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_FAILED',
      severity: 'HIGH',
      source: VERIFY_SOURCE,
      details: `Verification failed for challenge ${challengeId}: incorrect code`,
      additionalData: { challengeId, reason: 'wrong_code', rateLimitExceeded },
    });
    throw new VerificationError(
      GatekeeperErrorCode.VERIFICATION_FAILED,
      'Verification failed: incorrect code. ' +
      'The code has been consumed (one-time use). ' +
      'Retry the blocked operation to receive a new verification code.'
    );
  }

  private unblockVerifiedAgent(challengeId: string): unknown {
    const enforcer = this.deps.handlers.dangerZoneEnforcer;
    const unblockedAgent = enforcer ? this.findAndUnblockAgent(enforcer, challengeId) : undefined;
    if (unblockedAgent) {
      SecurityMonitor.logSecurityEvent({
        type: 'VERIFICATION_SUCCEEDED',
        severity: 'MEDIUM',
        source: VERIFY_SOURCE,
        details: `Verification succeeded: agent '${unblockedAgent}' unblocked (challenge: ${challengeId})`,
        additionalData: { challengeId, unblockedAgent },
      });
      return {
        verified: true,
        unblockedAgent,
        message: `Verification successful. Agent '${unblockedAgent}' has been unblocked. You may now retry the operation.`,
      };
    }

    SecurityMonitor.logSecurityEvent({
      type: 'VERIFICATION_SUCCEEDED',
      severity: 'LOW',
      source: VERIFY_SOURCE,
      details: `Verification succeeded but no blocked agent found for challenge ${challengeId}`,
      additionalData: { challengeId },
    });
    return {
      verified: true,
      message: 'Verification successful. You may now retry the operation.',
    };
  }

  private findAndUnblockAgent(
    enforcer: NonNullable<HandlerRegistry['dangerZoneEnforcer']>,
    challengeId: string
  ): string | undefined {
    for (const agentName of enforcer.getBlockedAgents()) {
      const blockInfo = enforcer.check(agentName);
      if (blockInfo.verificationId !== challengeId) {
        continue;
      }
      const currentSessionId = this.deps.contextTracker?.getSessionContext?.()?.sessionId;
      return enforcer.unblock(agentName, challengeId, currentSessionId) ? agentName : undefined;
    }
    return undefined;
  }

  private releaseDeadlock(params: Record<string, unknown>): unknown {
    const challengeIdValue = typeof params.challenge_id === 'string' ? params.challenge_id.trim() : '';
    const codeValue = typeof params.code === 'string' ? params.code.trim() : '';

    if ((challengeIdValue && !codeValue) || (!challengeIdValue && codeValue)) {
      throw new Error(
        'release_deadlock requires both challenge_id and code together, or neither for the initial challenge request.'
      );
    }
    return challengeIdValue && codeValue
      ? this.deps.completeDeadlockRelief(challengeIdValue, codeValue)
      : this.deps.issueDeadlockReliefChallenge();
  }

  private beetlejuice(params: Record<string, unknown>): unknown {
    const agentName = typeof params.agent_name === 'string' && params.agent_name.length > 0
      ? params.agent_name
      : 'beetlejuice-test-agent';
    const store = this.deps.handlers.verificationStore;
    if (!store) {
      throw new Error('VerificationStore not available. Ensure the server is properly configured.');
    }
    const enforcer = this.deps.handlers.dangerZoneEnforcer;
    if (!enforcer) {
      throw new Error('DangerZoneEnforcer not available. Ensure the server is properly configured.');
    }

    const challengeId = randomUUID();
    const code = generateDisplayCode();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    store.set(challengeId, { code, expiresAt, reason: 'Beetlejuice test trigger (Issue #503)' });
    const beetlejuiceSessionId = this.deps.contextTracker?.getSessionContext?.()?.sessionId;
    enforcer.block(agentName, 'Beetlejuice test trigger', ['beetlejuice_beetlejuice_beetlejuice'], challengeId, undefined, beetlejuiceSessionId);
    this.deps.handlers.verificationNotifier?.showCode(code, `Agent '${agentName}' requires verification (Beetlejuice trigger)`);

    SecurityMonitor.logSecurityEvent({
      type: 'DANGER_ZONE_TRIGGERED',
      severity: 'LOW',
      source: 'MCPAQLHandler.dispatchGatekeeper.beetlejuice',
      details: `Beetlejuice test trigger: agent '${agentName}' blocked with challenge ${challengeId}`,
      additionalData: { challengeId, agentName, testTrigger: true },
    });

    return {
      triggered: true,
      challenge_id: challengeId,
      agent_name: agentName,
      message: `Agent '${agentName}' is now blocked. A verification code has been displayed to the user. They must type it to proceed via verify_challenge.`,
    };
  }

  private async permissionPrompt(params: Record<string, unknown>): Promise<unknown> {
    const toolName = validateRequiredString(params, 'tool_name', 'the tool requesting permission (e.g., "Bash", "Edit", "Write")');
    const toolInput = this.validateToolInput(toolName, params.input);
    if (!toolInput.valid) {
      return toolInput.response;
    }

    const agentIdentity = typeof params.agent_identity === 'string' ? params.agent_identity : undefined;
    const promptRateStatus = this.deps.resolvePermissionPromptLimiter().checkLimit();
    if (!promptRateStatus.allowed) {
      return this.deps.buildRateLimitDeny('permission_prompt', toolName, promptRateStatus);
    }
    this.deps.resolvePermissionPromptLimiter().consumeToken();
    if (!this.deps.gatekeeper.isPermissionPromptActive) {
      this.deps.gatekeeper.markPermissionPromptActive();
    }

    const classification = classifyTool(toolName, toolInput.input);
    const staticResponse = this.resolveStaticClassification(toolName, toolInput.input, classification, agentIdentity);
    if (staticResponse) {
      return staticResponse;
    }

    const activeElements = await this.deps.getActiveElements();
    const elementDecision = evaluateCliToolPolicy(toolName, toolInput.input, activeElements);
    const policyResponse = await this.resolveElementPolicyDecision(toolName, toolInput.input, classification, elementDecision, activeElements, agentIdentity);
    if (policyResponse) {
      return policyResponse;
    }

    return {
      behavior: 'allow',
      updatedInput: toolInput.input,
      classification: {
        riskLevel: classification.riskLevel,
        reason: classification.reason,
        stage: 'default',
      },
      policyContext: elementDecision.policyContext,
    };
  }

  private validateToolInput(
    toolName: string,
    toolInputRaw: unknown
  ): { valid: true; input: Record<string, unknown> } | { valid: false; response: Record<string, unknown> } {
    if (!toolInputRaw || typeof toolInputRaw !== 'object') {
      return {
        valid: false,
        response: {
          behavior: 'deny',
          message: `Missing required "input" parameter for ${toolName} tool evaluation.`,
          classification: {
            riskLevel: 'dangerous',
            reason: 'Cannot evaluate permission without tool input',
            stage: 'input_validation',
          },
        },
      };
    }
    const input = toolInputRaw as Record<string, unknown>;
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (toolName === 'Bash' && !command) {
      return {
        valid: false,
        response: {
          behavior: 'deny',
          message: `Missing required "command" in input for Bash tool. Cannot evaluate an empty command.`,
          classification: {
            riskLevel: 'dangerous',
            reason: 'Empty Bash command — denied by default for safety',
            stage: 'input_validation',
          },
        },
      };
    }
    return { valid: true, input };
  }

  private resolveStaticClassification(
    toolName: string,
    toolInput: Record<string, unknown>,
    classification: ReturnType<typeof classifyTool>,
    agentIdentity: string | undefined
  ): Record<string, unknown> | null {
    if (classification.behavior === 'allow') {
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        classification: {
          riskLevel: classification.riskLevel,
          reason: classification.reason,
          stage: 'static_classification',
        },
      };
    }
    if (classification.behavior !== 'deny') {
      return null;
    }
    SecurityMonitor.logSecurityEvent({
      type: 'PERMISSION_PROMPT_DENIED',
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
      details: `Permission denied for ${toolName}: ${classification.reason}`,
      additionalData: { toolName, riskLevel: classification.riskLevel, agentIdentity },
    });
    return {
      behavior: 'deny',
      message: classification.reason,
      ...(agentIdentity && { agent_identity: agentIdentity }),
      classification: {
        riskLevel: classification.riskLevel,
        reason: classification.reason,
        stage: 'static_classification',
      },
    };
  }

  private async resolveElementPolicyDecision(
    toolName: string,
    toolInput: Record<string, unknown>,
    classification: ReturnType<typeof classifyTool>,
    elementDecision: ReturnType<typeof evaluateCliToolPolicy>,
    activeElements: ActiveElement[],
    agentIdentity: string | undefined
  ): Promise<Record<string, unknown> | null> {
    if (elementDecision.behavior === 'deny') {
      return this.buildElementDeny(toolName, classification, elementDecision, agentIdentity);
    }
    if (elementDecision.behavior === 'confirm') {
      return this.createApprovalRequest(toolName, toolInput, classification, activeElements, {
        reason: elementDecision.message || 'Confirmation required by element policy',
        denyReason: elementDecision.message || `Confirmation required by element policy`,
        policySource: elementDecision.confirmSource || 'unknown',
        policyContext: elementDecision.policyContext,
      });
    }

    const existingApproval = this.deps.gatekeeper.checkCliApproval(toolName, toolInput);
    if (existingApproval) {
      return {
        behavior: 'allow',
        updatedInput: toolInput,
        classification: {
          riskLevel: classification.riskLevel,
          reason: classification.reason,
          stage: 'cli_approval',
        },
        approvalContext: {
          requestId: existingApproval.requestId,
          scope: existingApproval.scope,
        },
        policyContext: elementDecision.policyContext,
      };
    }

    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    if (!approvalPolicy.requireApproval?.includes(classification.riskLevel as 'moderate' | 'dangerous')) {
      return null;
    }
    const policySource = activeElements
      .filter(el => el.metadata?.gatekeeper?.externalRestrictions?.approvalPolicy?.requireApproval?.length)
      .map(el => `${el.type}:${el.name}`)
      .join(', ') || 'env:DOLLHOUSE_CLI_APPROVAL_POLICY';
    return this.createApprovalRequest(toolName, toolInput, classification, activeElements, {
      reason: classification.reason,
      denyReason: `Tool '${toolName}' classified as ${classification.riskLevel}: ${classification.reason}`,
      policySource,
      policyContext: elementDecision.policyContext,
    });
  }

  private buildElementDeny(
    toolName: string,
    classification: ReturnType<typeof classifyTool>,
    elementDecision: ReturnType<typeof evaluateCliToolPolicy>,
    agentIdentity: string | undefined
  ): Record<string, unknown> {
    SecurityMonitor.logSecurityEvent({
      type: 'PERMISSION_PROMPT_DENIED',
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.dispatchGatekeeper.permissionPrompt',
      details: `Permission denied by element policy for ${toolName}`,
      additionalData: { toolName, message: elementDecision.message, agentIdentity },
    });
    return {
      behavior: 'deny',
      message: elementDecision.message,
      ...(agentIdentity && { agent_identity: agentIdentity }),
      classification: {
        riskLevel: classification.riskLevel,
        reason: classification.reason,
        stage: 'element_policy',
      },
      policyContext: elementDecision.policyContext,
    };
  }

  private async createApprovalRequest(
    toolName: string,
    toolInput: Record<string, unknown>,
    classification: ReturnType<typeof classifyTool>,
    activeElements: ActiveElement[],
    request: {
      reason: string;
      denyReason: string;
      policySource: string;
      policyContext: unknown;
    }
  ): Promise<Record<string, unknown>> {
    const risk = assessRisk(toolName, toolInput, classification);
    const approvalRateStatus = this.deps.resolveCliApprovalLimiter().checkLimit();
    if (!approvalRateStatus.allowed) {
      return this.deps.buildRateLimitDeny(
        'cli_approval', toolName, approvalRateStatus,
        classification.riskLevel, classification.reason,
      );
    }
    this.deps.resolveCliApprovalLimiter().consumeToken();

    const approvalPolicy = resolveCliApprovalPolicy(activeElements);
    const ttlMs = approvalPolicy.ttlSeconds ? approvalPolicy.ttlSeconds * 1000 : undefined;
    const requestId = await this.deps.gatekeeper.createCliApprovalRequest({
      toolName,
      toolInput,
      riskLevel: classification.riskLevel,
      riskScore: risk.score,
      irreversible: risk.irreversible,
      denyReason: request.denyReason,
      policySource: request.policySource,
      ttlMs,
    });

    return {
      behavior: 'deny',
      message: `Requires human approval. Request ID: ${requestId}. Call approve_cli_permission to authorize.`,
      classification: {
        riskLevel: classification.riskLevel,
        reason: classification.reason,
        stage: 'approval_required',
        riskScore: risk.score,
        irreversible: risk.irreversible,
      },
      approvalRequest: {
        requestId,
        toolName,
        riskLevel: classification.riskLevel,
        riskScore: risk.score,
        irreversible: risk.irreversible,
        reason: request.reason,
      },
      policyContext: request.policyContext,
    };
  }

  private async evaluatePermission(params: Record<string, unknown>): Promise<unknown> {
    const { evaluatePermission } = await import('./evaluatePermission.js');
    return evaluatePermission(params, {
      permissionPromptLimiter: this.deps.resolvePermissionPromptLimiter(),
      classifyTool,
      evaluateCliToolPolicy,
      getActiveElements: (sessionId?: string) => this.deps.getActiveElements(sessionId),
    });
  }

  private async getEffectiveCliPolicies(params: Record<string, unknown>): Promise<unknown> {
    const toolName = params.tool_name as string | undefined;
    const toolInput = (params.tool_input as Record<string, unknown>) ?? {};
    const reportSessionId = typeof params.session_id === 'string' ? params.session_id : undefined;
    const reportingScope = params.reporting_scope === 'dashboard';
    const policyElements = reportingScope && !toolName
      ? await this.deps.getPolicyReportElements(reportSessionId)
      : await this.deps.getActiveElements();
    const elementPolicies = this.buildElementPolicyReport(policyElements);
    const combined = this.combineElementPolicies(elementPolicies);
    const evaluation = toolName ? this.evaluateToolAgainstPolicies(toolName, toolInput, policyElements) : undefined;
    const enforcement = this.buildEnforcementAdvisory(combined, elementPolicies);

    return {
      activeElementCount: policyElements.length,
      hasAllowlist: combined.allowPatterns.length > 0 || combined.allowOperations.length > 0,
      elements: elementPolicies,
      combinedAllowPatterns: combined.allowPatterns,
      combinedConfirmPatterns: combined.confirmPatterns,
      combinedDenyPatterns: combined.denyPatterns,
      combinedAllowOperations: combined.allowOperations,
      combinedConfirmOperations: combined.confirmOperations,
      combinedDenyOperations: combined.denyOperations,
      evaluation,
      permissionPromptActive: this.deps.gatekeeper.isPermissionPromptActive,
      hookInstalled: enforcement.hookInstalled,
      enforcementReady: enforcement.enforcementReady,
      hookHost: enforcement.hookHost,
      invalidPolicyElementCount: enforcement.invalidPolicyElementCount,
      advisory: enforcement.advisory,
    };
  }

  private buildElementPolicyReport(policyElements: ActiveElement[]): Array<Record<string, unknown>> {
    return policyElements.map(el => {
      const diagnostics = getGatekeeperDiagnostics(el.metadata);
      return {
        type: el.type,
        name: el.name,
        allowPatterns: el.metadata?.gatekeeper?.externalRestrictions?.allowPatterns ?? [],
        confirmPatterns: el.metadata?.gatekeeper?.externalRestrictions?.confirmPatterns ?? [],
        denyPatterns: el.metadata?.gatekeeper?.externalRestrictions?.denyPatterns ?? [],
        allowOperations: el.metadata?.gatekeeper?.allow ?? [],
        confirmOperations: el.metadata?.gatekeeper?.confirm ?? [],
        denyOperations: el.metadata?.gatekeeper?.deny ?? [],
        description: el.metadata?.gatekeeper?.externalRestrictions?.description ?? null,
        invalidGatekeeperPolicy: !!diagnostics,
        invalidGatekeeperMessage: diagnostics?.message,
        sessionIds: (el.metadata as Record<string, unknown>)?.sessionIds ?? undefined,
      };
    });
  }

  private combineElementPolicies(elementPolicies: Array<Record<string, unknown>>): {
    allowPatterns: unknown[];
    confirmPatterns: unknown[];
    denyPatterns: unknown[];
    allowOperations: unknown[];
    confirmOperations: unknown[];
    denyOperations: unknown[];
  } {
    return {
      allowPatterns: elementPolicies.flatMap(p => p.allowPatterns as unknown[]),
      confirmPatterns: elementPolicies.flatMap(p => p.confirmPatterns as unknown[]),
      denyPatterns: elementPolicies.flatMap(p => p.denyPatterns as unknown[]),
      allowOperations: elementPolicies.flatMap(p => p.allowOperations as unknown[]),
      confirmOperations: elementPolicies.flatMap(p => p.confirmOperations as unknown[]),
      denyOperations: elementPolicies.flatMap(p => p.denyOperations as unknown[]),
    };
  }

  private evaluateToolAgainstPolicies(
    toolName: string,
    toolInput: Record<string, unknown>,
    policyElements: ActiveElement[]
  ): Record<string, unknown> {
    const toolClassification = classifyTool(toolName, toolInput);
    const policyResult = toolClassification.behavior === 'evaluate'
      ? evaluateCliToolPolicy(toolName, toolInput, policyElements)
      : null;

    return {
      tool_name: toolName,
      tool_input: Object.keys(toolInput).length > 0 ? toolInput : undefined,
      staticClassification: {
        riskLevel: toolClassification.riskLevel,
        behavior: toolClassification.behavior,
        reason: toolClassification.reason,
      },
      elementPolicyResult: policyResult ? {
        behavior: policyResult.behavior,
        message: policyResult.message,
        policyContext: policyResult.policyContext,
      } : undefined,
      finalBehavior: resolveFinalBehavior(policyResult?.behavior, toolClassification.behavior),
    };
  }

  private buildEnforcementAdvisory(
    combined: ReturnType<GatekeeperHandler['combineElementPolicies']>,
    elementPolicies: Array<Record<string, unknown>>
  ): {
    hookInstalled: boolean;
    enforcementReady: boolean;
    hookHost: string | undefined;
    invalidPolicyElementCount: number;
    advisory?: string;
  } {
    const hookStatus = getPermissionHookStatus();
    const enforcementReady = this.deps.gatekeeper.isPermissionPromptActive || hookStatus.installed;
    const hasCliRestrictions = combined.allowPatterns.length > 0 || combined.denyPatterns.length > 0 || combined.confirmPatterns.length > 0;
    const hasOperationRestrictions = combined.allowOperations.length > 0 || combined.denyOperations.length > 0 || combined.confirmOperations.length > 0;
    const invalidPolicyElements = elementPolicies.filter(policy => policy.invalidGatekeeperPolicy);
    let advisory = this.buildRestrictionAdvisory(hasCliRestrictions, hasOperationRestrictions, enforcementReady, hookStatus);

    if (invalidPolicyElements.length > 0) {
      const invalidAdvisory = buildInvalidPolicyAdvisory(invalidPolicyElements.length);
      advisory = advisory ? `${advisory} ${invalidAdvisory}` : invalidAdvisory;
    }

    return {
      hookInstalled: hookStatus.installed,
      enforcementReady,
      hookHost: hookStatus.host,
      invalidPolicyElementCount: invalidPolicyElements.length,
      advisory,
    };
  }

  private buildRestrictionAdvisory(
    hasCliRestrictions: boolean,
    hasOperationRestrictions: boolean,
    enforcementReady: boolean,
    hookStatus: ReturnType<typeof getPermissionHookStatus>
  ): string | undefined {
    if (hasCliRestrictions && !enforcementReady) {
      return 'Policies are loaded but NOT enforced. No permission hook detected and permission_prompt has not been called. Run open_setup and reinstall, or launch the CLI client with --permission-prompt-tool.';
    }
    if (hasCliRestrictions && hookStatus.installed && !this.deps.gatekeeper.isPermissionPromptActive) {
      return `Policies are loaded. Permission hook detected for ${hookStatus.host ?? 'a supported client'}, so enforcement depends on using that client configuration.`;
    }
    if (hasOperationRestrictions) {
      return 'MCP-AQL operation policies are active for Dollhouse actions in this session.';
    }
    return undefined;
  }

  private async getPermissionAuthority(params: Record<string, unknown>): Promise<unknown> {
    const requestedHost = typeof params.host === 'string' ? params.host : undefined;
    const authorityState = await readPermissionAuthorityState();
    return {
      defaultMode: authorityState.defaultMode,
      updatedAt: authorityState.updatedAt,
      supportedHosts: [...PERMISSION_AUTHORITY_HOSTS],
      supportedModes: [...PERMISSION_AUTHORITY_MODES],
      aiMutable: false,
      hosts: authorityState.hosts,
      host: requestedHost,
      mode: requestedHost && requestedHost in authorityState.hosts
        ? authorityState.hosts[requestedHost as keyof typeof authorityState.hosts]?.mode ?? authorityState.defaultMode
        : authorityState.defaultMode,
    };
  }

  private approveCliPermission(params: Record<string, unknown>): unknown {
    const requestId = validateRequiredString(
      params,
      'request_id',
      'the approval request ID from permission_prompt deny response (format: cli-<UUID>)'
    );
    const scope = (params.scope as CliApprovalScope) ?? 'single';
    if (scope !== 'single' && scope !== 'tool_session') {
      throw new Error(`Invalid scope "${scope}". Must be "single" or "tool_session".`);
    }

    const record = this.deps.gatekeeper.approveCliRequest(requestId, scope);
    if (!record) {
      throw new Error(`No pending approval for "${requestId}". It may have expired or already been approved.`);
    }

    return {
      approved: true,
      requestId,
      toolName: record.toolName,
      scope,
      message: scope === 'tool_session'
        ? `Approved for all uses of '${record.toolName}' this session.`
        : `Approved single use of '${record.toolName}'. Retry the tool call now.`,
    };
  }

  private getPendingCliApprovals(): unknown {
    const pending = this.deps.gatekeeper.getPendingCliApprovals();
    return {
      pending,
      count: pending.length,
    };
  }
}
