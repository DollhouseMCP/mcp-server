import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import type { AgentManager } from '../../elements/agents/AgentManager.js';
import type { AgentMetadataV2, AgentNotification } from '../../elements/agents/types.js';
import { evaluateResiliencePolicy, type ResilienceContext } from '../../elements/agents/resilienceEvaluator.js';
import { prepareHandoffState, parseHandoffBlock, generateHandoffBlock } from '../../elements/agents/handoff.js';
import { translateToolConfigToPolicy } from './policies/index.js';
import type { HandlerRegistry, CorrelationIdProvider } from './MCPAQLHandler.js';
import {
  type ExecutingAgentEntry,
  validateExecutionElementName,
} from './shared.js';

type StepOutcome = 'success' | 'failure' | 'partial';

export class AgentExecutionHandler {
  private static readonly MAX_RECENT_BLOCKS = 50;

  constructor(
    private readonly handlers: HandlerRegistry,
    private readonly executingAgents: Map<string, ExecutingAgentEntry>,
    private readonly abortedGoals: Set<string>,
    private readonly sessionKey: (name: string) => string,
    private readonly contextTracker?: CorrelationIdProvider,
  ) {}

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const manager = this.handlers.agentManager;
    const elementName = validateExecutionElementName(method, params);
    await this.ensureAgentCanExecute(method, manager, elementName);

    const handlers: Record<string, () => Promise<unknown>> = {
      execute: () => this.executeAgent(manager, elementName, params),
      getState: () => this.getState(manager, elementName, params),
      updateState: () => this.updateState(manager, elementName, params),
      complete: () => this.complete(manager, elementName, params),
      continue: () => this.continueExecution(manager, elementName, params),
      abort: () => this.abort(manager, elementName, params),
      getGatheredData: () => this.getGatheredData(manager, elementName, params),
      prepareHandoff: () => this.prepareHandoff(manager, elementName, params),
      resumeFromHandoff: () => this.resumeFromHandoff(manager, elementName, params),
    };
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown Execute method: ${method}`);
    }
    return handler();
  }

  recordGatekeeperBlock(
    operation: string,
    elementType: string | undefined,
    reason: string,
    level: string
  ): void {
    if (this.executingAgents.size === 0) return;

    const block = {
      operation,
      elementType,
      reason,
      level,
      timestamp: new Date().toISOString(),
      reported: false,
    };

    for (const [, agentEntry] of this.executingAgents) {
      agentEntry.recentBlocks.push(block);
      this.trimRecentBlocks(agentEntry);
    }
  }

  private trimRecentBlocks(agentEntry: ExecutingAgentEntry): void {
    while (agentEntry.recentBlocks.length > AgentExecutionHandler.MAX_RECENT_BLOCKS) {
      const reportedIdx = agentEntry.recentBlocks.findIndex(b => b.reported);
      if (reportedIdx >= 0) {
        agentEntry.recentBlocks.splice(reportedIdx, 1);
      } else {
        agentEntry.recentBlocks.shift();
      }
    }
  }

  private async ensureAgentCanExecute(
    method: string,
    manager: AgentManager,
    elementName: string
  ): Promise<void> {
    this.ensureNotDangerZoneBlocked(method, elementName);
    if (method === 'execute' || method === 'getState' || method === 'abort') {
      return;
    }
    await this.ensureNoAbortedGoals(manager, elementName);
  }

  private ensureNotDangerZoneBlocked(method: string, elementName: string): void {
    if (method === 'getState' || !this.handlers.dangerZoneEnforcer) {
      return;
    }
    const blockCheck = this.handlers.dangerZoneEnforcer.check(elementName);
    if (!blockCheck.blocked) {
      return;
    }
    logger.warn(`Agent '${elementName}' blocked from executing '${method}': ${blockCheck.reason}`, {
      agentName: elementName,
      method,
      reason: blockCheck.reason,
    });
    throw new Error(
      `Agent '${elementName}' is blocked due to danger zone trigger: ${blockCheck.reason}. ` +
      `${blockCheck.resolution}` +
      (blockCheck.verificationId
        ? ' Ask the human operator to read the verification code from the dialog on their screen.'
        : '')
    );
  }

  private async ensureNoAbortedGoals(manager: AgentManager, elementName: string): Promise<void> {
    const agentGoalIds = await this.getActiveGoalIds(manager, elementName);
    for (const goalId of agentGoalIds) {
      if (this.abortedGoals.has(this.sessionKey(goalId))) {
        throw new Error(
          `Agent '${elementName}' execution was aborted (goalId: ${goalId}). ` +
          `Further execution operations are rejected. Use execute_agent to start a new execution.`
        );
      }
    }
  }

  private async executeAgent(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const executeResult = await manager.executeAgent(
      elementName,
      params.parameters as Record<string, unknown>
    );
    const runtimeMaxSteps = this.validateRuntimeMaxSteps(params.maxAutonomousSteps);
    await this.trackExecutingAgent(manager, elementName, params, runtimeMaxSteps);
    return { _type: 'ExecuteAgentResult', ...executeResult };
  }

  private validateRuntimeMaxSteps(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('maxAutonomousSteps must be a non-negative integer');
    }
    return value;
  }

  private async trackExecutingAgent(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>,
    runtimeMaxSteps: number | undefined
  ): Promise<void> {
    try {
      const agentElement = await manager.read(elementName);
      const agentMeta = agentElement?.metadata as AgentMetadataV2 | undefined;
      const gatekeeperPolicy = agentMeta?.gatekeeper ??
        (agentMeta?.tools ? translateToolConfigToPolicy(agentMeta.tools) ?? undefined : undefined);
      const resiliencePolicy = agentMeta?.resilience;

      if (gatekeeperPolicy || runtimeMaxSteps !== undefined || resiliencePolicy) {
        this.executingAgents.set(this.sessionKey(elementName), {
          name: elementName,
          metadata: {
            ...(gatekeeperPolicy ? { gatekeeper: gatekeeperPolicy } : {}),
            ...(runtimeMaxSteps === undefined ? {} : { maxAutonomousSteps: runtimeMaxSteps }),
          },
          startedAt: Date.now(),
          continuationCount: 0,
          retryCount: 0,
          originalParameters: params.parameters as Record<string, unknown> | undefined,
          resiliencePolicy,
          recentBlocks: [],
        });
      }
    } catch {
      logger.warn('Failed to track executing agent for Gatekeeper policy', { agentName: elementName });
    }
  }

  private async getState(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const stateResult = await manager.getAgentState({
      agentName: elementName,
      includeDecisionHistory: params.includeDecisionHistory as boolean | undefined,
      includeContext: params.includeContext as boolean | undefined,
    });
    return { _type: 'ExecutionState', ...stateResult };
  }

  private async updateState(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const nextActionHint = this.validateNextActionHint(params.nextActionHint);
    const riskScore = this.validateRiskScore(params.riskScore);
    const executingAgent = this.executingAgents.get(this.sessionKey(elementName));

    const updateResult = await manager.recordAgentStep({
      agentName: elementName,
      stepDescription: params.stepDescription as string,
      outcome: params.outcome as StepOutcome,
      findings: params.findings as string,
      confidence: params.confidence as number,
      nextActionHint,
      riskScore,
      maxStepsOverride: executingAgent?.metadata?.maxAutonomousSteps as number | undefined,
    });

    const finalResult = this.evaluateResilience(elementName, updateResult, params.outcome as string) ?? updateResult;
    this.attachNotifications(elementName, finalResult);
    return { _type: 'StepResult', ...finalResult };
  }

  private validateNextActionHint(value: unknown): string | undefined {
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError('nextActionHint must be a string if provided');
    }
    return value;
  }

  private validateRiskScore(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError('riskScore must be a number if provided');
    }
    if (value < 0 || value > 100) {
      throw new Error('riskScore must be between 0 and 100');
    }
    return value;
  }

  private attachNotifications(agentName: string, result: Record<string, unknown>): void {
    const autonomy = result.autonomy as Record<string, unknown> | undefined;
    if (!autonomy) {
      return;
    }
    const notifications = this.collectNotifications(agentName, autonomy);
    if (notifications.length > 0) {
      autonomy.notifications = notifications;
    }
  }

  private async complete(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const completeResult = await manager.completeAgentGoal({
      agentName: elementName,
      outcome: params.outcome as StepOutcome,
      summary: params.summary as string,
      goalId: params.goalId as string | undefined,
    });

    const completedAgent = this.executingAgents.get(this.sessionKey(elementName));
    this.recordResilienceCompletion(completedAgent, params.outcome === 'success', elementName);
    this.executingAgents.delete(this.sessionKey(elementName));
    return { _type: 'CompletionResult', ...completeResult };
  }

  private recordResilienceCompletion(
    agent: ExecutingAgentEntry | undefined,
    isSuccess: boolean,
    elementName: string
  ): void {
    if (!agent?.resiliencePolicy || (agent.continuationCount === 0 && agent.retryCount === 0)) {
      return;
    }
    this.handlers.resilienceMetrics?.recordCompletionAfterResilience(isSuccess);
    if (isSuccess) {
      this.handlers.circuitBreaker?.reset(elementName);
    }
  }

  private async continueExecution(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const continueResult = await manager.continueAgentExecution({
      agentName: elementName,
      previousStepResult: params.previousStepResult as string | undefined,
      parameters: params.parameters as Record<string, unknown> | undefined,
    });
    return { _type: 'ContinueResult', ...continueResult };
  }

  private async abort(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const reason = (params.reason as string) || 'Aborted by user';
    const activeGoalIds = await this.getActiveGoalIds(manager, elementName);
    if (activeGoalIds.length === 0) {
      throw new Error(`No active execution found for agent '${elementName}'. Nothing to abort.`);
    }

    activeGoalIds.forEach(goalId => this.abortedGoals.add(this.sessionKey(goalId)));
    await this.markAbortAsFailed(manager, elementName, reason);
    this.recordResilienceCompletion(this.executingAgents.get(this.sessionKey(elementName)), false, elementName);
    this.executingAgents.delete(this.sessionKey(elementName));
    this.unblockDangerZone(elementName);
    this.logAbort(elementName, activeGoalIds, reason);

    return {
      _type: 'AbortResult',
      success: true,
      agentName: elementName,
      abortedGoalIds: activeGoalIds,
      reason,
      message: `Agent '${elementName}' execution aborted. ${activeGoalIds.length} goal(s) terminated.`,
    };
  }

  private async markAbortAsFailed(manager: AgentManager, elementName: string, reason: string): Promise<void> {
    try {
      await manager.completeAgentGoal({
        agentName: elementName,
        outcome: 'failure',
        summary: `Execution aborted: ${reason}`,
      });
    } catch {
      logger.warn('Failed to mark aborted agent goal as failed', { agentName: elementName });
    }
  }

  private unblockDangerZone(elementName: string): void {
    try {
      this.handlers.dangerZoneEnforcer?.unblock(elementName);
    } catch {
      // Non-fatal: agent may not have been blocked
    }
  }

  private logAbort(elementName: string, activeGoalIds: string[], reason: string): void {
    SecurityMonitor.logSecurityEvent({
      type: 'AGENT_EXECUTED',
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.dispatchExecute.abort',
      details: `Agent execution aborted: ${elementName} — ${reason}`,
      additionalData: { agentName: elementName, abortedGoalIds: activeGoalIds, reason },
    });
  }

  private async getGatheredData(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const goalId = params.goalId;
    if (typeof goalId !== 'string' || !goalId) {
      throw new Error('goalId is required for get_gathered_data');
    }
    const gatheredData = await manager.getGatheredData({ agentName: elementName, goalId });
    return { _type: 'GatheredData', ...gatheredData };
  }

  private async prepareHandoff(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const goalId = params.goalId;
    if (typeof goalId !== 'string' || !goalId) {
      throw new Error('goalId is required for prepare_handoff');
    }

    const gatheredData = await manager.getGatheredData({ agentName: elementName, goalId });
    const { activeElements, successCriteria } = await this.getHandoffMetadata(manager, elementName);
    const handoffState = prepareHandoffState(elementName, gatheredData, activeElements, successCriteria);

    return {
      _type: 'HandoffResult',
      handoffState,
      handoffBlock: generateHandoffBlock(handoffState),
    };
  }

  private async getHandoffMetadata(
    manager: AgentManager,
    elementName: string
  ): Promise<{ activeElements: Record<string, string[]>; successCriteria: string[] }> {
    const defaults = { activeElements: { agents: [elementName] }, successCriteria: [] as string[] };
    try {
      const agentElement = await manager.read(elementName);
      const meta = agentElement?.metadata as AgentMetadataV2 | undefined;
      const activeElements = { ...(meta?.activates as Record<string, string[]> | undefined) };
      activeElements.agents = [...new Set([...(activeElements.agents ?? []), elementName])];
      return { activeElements, successCriteria: meta?.goal?.successCriteria || [] };
    } catch {
      return defaults;
    }
  }

  private async resumeFromHandoff(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handoffBlockParam = params.handoffBlock;
    if (typeof handoffBlockParam !== 'string' || !handoffBlockParam) {
      throw new Error('handoffBlock is required for resume_from_handoff (the full handoff block text)');
    }

    const restoredState = parseHandoffBlock(handoffBlockParam);
    if (restoredState.agentName !== elementName) {
      logger.warn('Handoff agent mismatch detected', {
        expectedAgent: elementName,
        blockAgent: restoredState.agentName,
      });
      throw new Error('Handoff agent mismatch: the handoff block was not prepared for this agent');
    }

    const callerParams = (params.parameters as Record<string, unknown>) || {};
    const continueResult = await manager.continueAgentExecution({
      agentName: elementName,
      previousStepResult: `Resumed from handoff (goalId: ${restoredState.goalId}, ${restoredState.goalProgress.stepsCompleted} steps completed)`,
      parameters: {
        ...callerParams,
        resumedFromHandoff: true,
        originalGoalId: restoredState.goalId,
      },
    });

    return {
      _type: 'ResumeResult',
      ...continueResult,
      restoredFrom: {
        agentName: restoredState.agentName,
        goalId: restoredState.goalId,
        version: restoredState.version,
        stepsCompleted: restoredState.goalProgress.stepsCompleted,
        preparedAt: restoredState.preparedAt,
      },
    };
  }

  private collectNotifications(agentName: string, autonomy: Record<string, unknown>): AgentNotification[] {
    return [
      ...this.collectGatekeeperNotifications(agentName),
      ...this.collectAutonomyNotifications(autonomy),
      ...this.collectDangerZoneNotifications(),
    ];
  }

  private collectGatekeeperNotifications(agentName: string): AgentNotification[] {
    const executingAgent = this.executingAgents.get(this.sessionKey(agentName));
    return executingAgent?.recentBlocks.flatMap(block => this.gatekeeperNotification(block)) ?? [];
  }

  private gatekeeperNotification(block: ExecutingAgentEntry['recentBlocks'][number]): AgentNotification[] {
    if (block.reported) {
      return [];
    }
    block.reported = true;
    const elementTypeSuffix = block.elementType ? `(${block.elementType})` : '';
    return [{
      type: 'permission_pending',
      message: `${block.operation}${elementTypeSuffix} requires confirmation`,
      metadata: {
        operation: block.operation,
        element_type: block.elementType,
        reason: block.reason,
        level: block.level,
      },
      timestamp: block.timestamp,
    }];
  }

  private collectAutonomyNotifications(autonomy: Record<string, unknown>): AgentNotification[] {
    if (autonomy.continue !== false) {
      return [];
    }
    const reason = (autonomy.reason as string) || (autonomy.factors as string[] || []).join(', ');
    return reason ? [{
      type: 'autonomy_pause',
      message: `Agent paused: ${reason}`,
      metadata: { reason },
      timestamp: new Date().toISOString(),
    }] : [];
  }

  private collectDangerZoneNotifications(): AgentNotification[] {
    const enforcer = this.handlers.dangerZoneEnforcer;
    if (!enforcer?.hasBlockedAgents()) {
      return [];
    }
    return enforcer.getBlockedAgents().flatMap(blockedAgent => {
      const blockCheck = enforcer.check(blockedAgent);
      return blockCheck.blocked ? [{
        type: 'danger_zone',
        message: `Agent '${blockedAgent}' is blocked due to danger zone trigger: ${blockCheck.reason}`,
        metadata: {
          agentName: blockedAgent,
          reason: blockCheck.reason,
          verificationId: blockCheck.verificationId,
        },
        timestamp: new Date().toISOString(),
      }] : [];
    });
  }

  private evaluateResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    stepOutcome: string
  ): Record<string, unknown> | null {
    const autonomy = updateResult.autonomy as { continue: boolean; reason?: string; factors?: string[] } | undefined;
    const executingAgent = this.executingAgents.get(this.sessionKey(agentName));
    const context = this.buildResilienceContext(agentName, stepOutcome, autonomy, executingAgent);
    if (!context || !executingAgent?.resiliencePolicy) {
      return null;
    }

    const action = evaluateResiliencePolicy(executingAgent.resiliencePolicy, context, this.handlers.circuitBreaker);
    switch (action.action) {
      case 'continue':
        return this.continueAfterResilience(agentName, updateResult, autonomy!, executingAgent, action, context);
      case 'retry':
        return this.retryAfterResilience(agentName, updateResult, autonomy!, executingAgent, action, context);
      case 'restart':
        return this.restartAfterResilience(agentName, updateResult, autonomy!, executingAgent, action, context);
      case 'pause':
        this.recordResiliencePause(action.reason);
        return null;
      default:
        return null;
    }
  }

  private buildResilienceContext(
    agentName: string,
    stepOutcome: string,
    autonomy: { continue: boolean; reason?: string; factors?: string[] } | undefined,
    executingAgent: ExecutingAgentEntry | undefined
  ): ResilienceContext | null {
    if (!autonomy || autonomy.continue === true || !executingAgent?.resiliencePolicy) {
      return null;
    }
    const isStepLimit = autonomy.reason?.startsWith('Maximum autonomous steps reached') ?? false;
    const isFailure = stepOutcome === 'failure';
    if (!isStepLimit && !isFailure) {
      return null;
    }
    return {
      trigger: isStepLimit ? 'step_limit' : 'execution_failure',
      continuationCount: executingAgent.continuationCount,
      retryCount: executingAgent.retryCount,
      stepOutcome: stepOutcome as 'success' | 'failure' | 'partial',
      agentName,
    };
  }

  private recordResiliencePause(reason: string | undefined): void {
    if (!reason?.includes('exhausted') && !reason?.includes('Circuit breaker')) {
      return;
    }
    this.handlers.resilienceMetrics?.recordResilienceLimit();
    if (reason.includes('Circuit breaker')) {
      this.handlers.resilienceMetrics?.recordCircuitBreakerTrip();
    }
  }

  private continueAfterResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    autonomy: { continue: boolean; reason?: string; factors?: string[] },
    executingAgent: ExecutingAgentEntry,
    action: ReturnType<typeof evaluateResiliencePolicy>,
    context: ResilienceContext
  ): Record<string, unknown> {
    executingAgent.continuationCount++;
    executingAgent.retryCount = 0;
    this.handlers.resilienceMetrics?.recordAutoContinuation();
    this.logResilienceAction('AGENT_AUTO_CONTINUED', agentName, action.reason, context, {
      continuationCount: executingAgent.continuationCount,
      maxContinuations: action.maxContinuations,
    });
    return this.withResilienceAutonomy(updateResult, autonomy, action, `resilience: auto-continued (${executingAgent.continuationCount}/${action.maxContinuations || 'unlimited'})`);
  }

  private retryAfterResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    autonomy: { continue: boolean; reason?: string; factors?: string[] },
    executingAgent: ExecutingAgentEntry,
    action: ReturnType<typeof evaluateResiliencePolicy>,
    context: ResilienceContext
  ): Record<string, unknown> {
    executingAgent.retryCount++;
    this.handlers.resilienceMetrics?.recordStepRetry();
    this.logResilienceAction('AGENT_STEP_RETRIED', agentName, action.reason, context, {
      retryCount: executingAgent.retryCount,
      backoffMs: action.backoffMs,
    });
    return this.withResilienceAutonomy(updateResult, autonomy, action, `resilience: retry attempt ${executingAgent.retryCount}`);
  }

  private restartAfterResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    autonomy: { continue: boolean; reason?: string; factors?: string[] },
    executingAgent: ExecutingAgentEntry,
    action: ReturnType<typeof evaluateResiliencePolicy>,
    context: ResilienceContext
  ): Record<string, unknown> {
    executingAgent.continuationCount++;
    executingAgent.retryCount = 0;
    this.handlers.resilienceMetrics?.recordAutoRestart();
    this.logResilienceAction('AGENT_AUTO_RESTARTED', agentName, action.reason, context, {
      continuationCount: executingAgent.continuationCount,
      maxContinuations: action.maxContinuations,
      preserveState: executingAgent.resiliencePolicy?.preserveState ?? true,
    });
    return this.withResilienceAutonomy(updateResult, autonomy, action, `resilience: auto-restarted (${executingAgent.continuationCount}/${action.maxContinuations || 'unlimited'})`);
  }

  private logResilienceAction(
    type: 'AGENT_AUTO_CONTINUED' | 'AGENT_STEP_RETRIED' | 'AGENT_AUTO_RESTARTED',
    agentName: string,
    reason: string | undefined,
    context: ResilienceContext,
    additionalData: Record<string, unknown>
  ): void {
    SecurityMonitor.logSecurityEvent({
      type,
      severity: 'MEDIUM',
      source: 'MCPAQLHandler.evaluateResilience',
      details: `Agent '${agentName}' ${type.toLowerCase()}: ${reason}`,
      additionalData: { agentName, trigger: context.trigger, ...additionalData },
    });
  }

  private withResilienceAutonomy(
    updateResult: Record<string, unknown>,
    autonomy: { continue: boolean; reason?: string; factors?: string[] },
    action: ReturnType<typeof evaluateResiliencePolicy>,
    factor: string
  ): Record<string, unknown> {
    return {
      ...updateResult,
      autonomy: {
        ...autonomy,
        continue: true,
        reason: action.reason,
        factors: [...(autonomy.factors || []), factor],
        resilienceAction: action,
      },
    };
  }

  private async getActiveGoalIds(manager: AgentManager, agentName: string): Promise<string[]> {
    try {
      const stateResult = await manager.getAgentState({ agentName });
      return stateResult?.state?.goals
        ?.filter((g: { status: string }) => g.status === 'in_progress')
        .map((g: { id: string }) => g.id) ?? [];
    } catch {
      return [];
    }
  }
}
