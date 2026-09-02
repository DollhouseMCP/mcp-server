import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { AsyncKeyedLock } from '../../utils/AsyncKeyedLock.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AgentExecutionHandler {
  private static readonly MAX_RECENT_BLOCKS = 50;
  // Keep policy ownership and its durable state mutation in one lifecycle operation.
  private readonly executionOperationLock = new AsyncKeyedLock();

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
    const executionKey = this.executionKey(manager, elementName);

    return this.executionOperationLock.runExclusive(executionKey, async () => {
      await this.ensureAgentCanExecute(method, manager, elementName);

      const handlers: Partial<Record<string, () => Promise<unknown>>> = {
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
    });
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
    const runtimeMaxSteps = this.validateRuntimeMaxSteps(params.maxAutonomousSteps);
    const executeResult = await manager.executeAgent(
      elementName,
      params.parameters as Record<string, unknown>
    );
    await this.trackExecutingAgent(
      manager,
      elementName,
      params,
      runtimeMaxSteps,
      executeResult.goalId,
    );
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
    runtimeMaxSteps: number | undefined,
    goalId: string | undefined,
    preserveExistingState = false,
  ): Promise<void> {
    const executionKey = this.executionKey(manager, elementName);
    const previousEntry = this.executingAgents.get(executionKey);
    const goalIds = [...(previousEntry?.goalIds ?? [])];
    if (goalId && !goalIds.includes(goalId)) {
      goalIds.push(goalId);
    }
    if (preserveExistingState && previousEntry) {
      previousEntry.goalIds = goalIds;
      return;
    }
    const executionEntry: ExecutingAgentEntry = {
      name: elementName,
      goalIds,
      metadata: runtimeMaxSteps === undefined ? {} : { maxAutonomousSteps: runtimeMaxSteps },
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      originalParameters: params.parameters as Record<string, unknown> | undefined,
      recentBlocks: [],
    };
    this.executingAgents.set(executionKey, executionEntry);

    await this.hydrateExecutionPolicies(manager, elementName, executionEntry);
  }

  private async hydrateExecutionPolicies(
    manager: AgentManager,
    elementName: string,
    executionEntry: ExecutingAgentEntry,
  ): Promise<void> {

    try {
      const agentElement = await manager.read(elementName);
      const agentMeta = agentElement?.metadata as AgentMetadataV2 | undefined;
      const gatekeeperPolicy = agentMeta?.gatekeeper ??
        (agentMeta?.tools ? translateToolConfigToPolicy(agentMeta.tools) ?? undefined : undefined);
      const resiliencePolicy = agentMeta?.resilience;

      if (gatekeeperPolicy) {
        executionEntry.metadata.gatekeeper = gatekeeperPolicy;
      }
      executionEntry.resiliencePolicy = resiliencePolicy;
    } catch {
      logger.warn('Failed to load optional execution policies while tracking agent', {
        agentName: elementName,
      });
    }
  }

  /**
   * Reclaim durable goals whose transport session was disposed before the
   * lifecycle completed. The manager's state lookup is already scoped to the
   * authenticated user's portfolio; the live-session scan prevents one active
   * session from taking work that is still owned by another.
   */
  private async reclaimOrphanedExecution(
    manager: AgentManager,
    elementName: string,
  ): Promise<ExecutingAgentEntry | undefined> {
    const executionKey = this.executionKey(manager, elementName);
    const existingEntry = this.executingAgents.get(executionKey);
    if (existingEntry) {
      return existingEntry;
    }

    const excludedGoalIds = this.getTrackedGoalIds(manager, elementName, executionKey);
    const reclaimedState = await manager.reclaimOrphanedAgentState({
      agentName: elementName,
      excludedGoalIds,
    });
    const concurrentEntry = this.executingAgents.get(executionKey);
    if (concurrentEntry) {
      return concurrentEntry;
    }
    const activeGoalIds = reclaimedState?.goals
      .filter(goal => goal.status === 'in_progress')
      .map(goal => goal.id) ?? [];
    const orphanedGoalIds = activeGoalIds.filter(goalId =>
      !this.isGoalTrackedByAnotherSession(manager, elementName, executionKey, goalId)
    );
    if (orphanedGoalIds.length === 0) {
      return undefined;
    }

    const reclaimedEntry: ExecutingAgentEntry = {
      name: elementName,
      goalIds: orphanedGoalIds,
      metadata: {},
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      recentBlocks: [],
    };
    // Claim every orphan synchronously before policy hydration yields. This
    // prevents two reconnecting sessions from adopting the same durable goal.
    this.executingAgents.set(executionKey, reclaimedEntry);
    await this.hydrateExecutionPolicies(manager, elementName, reclaimedEntry);
    logger.info('Reclaimed orphaned agent execution for replacement session', {
      agentName: elementName,
      goalIds: orphanedGoalIds,
    });
    return reclaimedEntry;
  }

  private async reclaimExistingAgentExecution(
    manager: AgentManager,
    elementName: string,
  ): Promise<ExecutingAgentEntry | undefined> {
    try {
      return await this.reclaimOrphanedExecution(manager, elementName);
    } catch (error) {
      if (error instanceof ElementNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  private isGoalTrackedByAnotherSession(
    manager: AgentManager,
    elementName: string,
    currentExecutionKey: string,
    goalId: string,
  ): boolean {
    const canonicalName = manager.canonicalizeExecutionName(elementName);
    for (const [executionKey, entry] of this.executingAgents) {
      if (
        executionKey !== currentExecutionKey &&
        manager.canonicalizeExecutionName(entry.name) === canonicalName &&
        entry.goalIds?.includes(goalId)
      ) {
        return true;
      }
    }
    return false;
  }

  private getTrackedGoalIds(
    manager: AgentManager,
    elementName: string,
    currentExecutionKey: string,
  ): string[] {
    const canonicalName = manager.canonicalizeExecutionName(elementName);
    const trackedGoalIds = new Set<string>();
    for (const [executionKey, entry] of this.executingAgents) {
      if (
        executionKey !== currentExecutionKey &&
        manager.canonicalizeExecutionName(entry.name) === canonicalName
      ) {
        for (const goalId of entry.goalIds ?? []) {
          trackedGoalIds.add(goalId);
        }
      }
    }
    return [...trackedGoalIds];
  }

  private executionKey(manager: AgentManager, elementName: string): string {
    return this.sessionKey(manager.canonicalizeExecutionName(elementName));
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
    const executionKey = this.executionKey(manager, elementName);
    const executingAgent = this.executingAgents.get(executionKey)
      ?? await this.reclaimOrphanedExecution(manager, elementName);
    const ownedGoalId = executingAgent?.goalIds?.at(-1);
    if (!executingAgent || !ownedGoalId) {
      throw new Error(
        `No active goal found for agent '${elementName}' in this session. ` +
        'Use execute_agent to start a new goal first.',
      );
    }

    const updateResult = await manager.recordAgentStep({
      agentName: elementName,
      goalId: ownedGoalId,
      stepDescription: params.stepDescription as string,
      outcome: params.outcome as StepOutcome,
      findings: params.findings as string,
      confidence: params.confidence as number,
      nextActionHint,
      riskScore,
      maxStepsOverride: executingAgent.metadata.maxAutonomousSteps as number | undefined,
    });

    const finalResult = this.evaluateResilience(elementName, updateResult, params.outcome as string) ?? updateResult;
    this.attachNotifications(elementName, ownedGoalId, finalResult);
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

  private attachNotifications(
    agentName: string,
    goalId: string,
    result: Record<string, unknown>,
  ): void {
    const autonomy = result.autonomy as Record<string, unknown> | undefined;
    if (!autonomy) {
      return;
    }
    const notifications = this.collectNotifications(agentName, goalId, autonomy);
    if (notifications.length > 0) {
      autonomy.notifications = notifications;
    }
  }

  private async complete(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const executionKey = this.executionKey(manager, elementName);
    const completedAgent = this.executingAgents.get(executionKey)
      ?? await this.reclaimExistingAgentExecution(manager, elementName);
    const requestedGoalId = params.goalId as string | undefined;
    if (!completedAgent?.goalIds?.length) {
      throw new Error(
        `No active execution found for agent '${elementName}' in this session. ` +
        'Nothing to complete.',
      );
    }
    if (requestedGoalId && !completedAgent.goalIds.includes(requestedGoalId)) {
      throw new Error(
        `Goal '${requestedGoalId}' is not owned by this session's execution of '${elementName}'.`,
      );
    }
    const ownedGoalId = requestedGoalId ?? completedAgent.goalIds.at(-1);
    if (!ownedGoalId) {
      throw new Error(`No owned goal found for agent '${elementName}' in this session.`);
    }
    const completeResult = await manager.completeAgentGoal({
      agentName: elementName,
      outcome: params.outcome as StepOutcome,
      summary: params.summary as string,
      goalId: ownedGoalId,
    });

    this.recordResilienceCompletion(completedAgent, params.outcome === 'success', elementName);
    const currentAgent = this.executingAgents.get(executionKey);
    if (currentAgent?.goalIds?.includes(ownedGoalId)) {
      currentAgent.goalIds = currentAgent.goalIds.filter(id => id !== ownedGoalId);
    }
    if (currentAgent && currentAgent.goalIds?.length === 0) {
      this.executingAgents.delete(executionKey);
    }
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
    const ownedGoalId = await this.requireOwnedActiveGoal(manager, elementName);

    const continueResult = await manager.continueAgentExecution({
      agentName: elementName,
      goalId: ownedGoalId,
      previousStepResult: params.previousStepResult as string | undefined,
      parameters: params.parameters as Record<string, unknown> | undefined,
    });
    await this.trackExecutingAgent(
      manager,
      elementName,
      params,
      undefined,
      continueResult.goalId,
      true,
    );
    return { _type: 'ContinueResult', ...continueResult };
  }

  private async requireOwnedActiveGoal(
    manager: AgentManager,
    elementName: string,
    requiredGoalId?: string,
  ): Promise<string> {
    const executionKey = this.executionKey(manager, elementName);
    const executionEntry = this.executingAgents.get(executionKey)
      ?? await this.reclaimOrphanedExecution(manager, elementName);
    if (!executionEntry) {
      throw new Error(
        `No active execution found for agent '${elementName}' in this session. ` +
        'Use execute_agent to start a new goal. If you are reporting progress for ' +
        'the current goal, use mcp_aql_create record_execution_step.',
      );
    }

    const activeGoalIds = await this.getActiveGoalIds(manager, elementName, true);
    const ownedGoalIds = this.getOwnedActiveGoalIds(activeGoalIds, executionEntry);
    const ownedGoalId = requiredGoalId
      ? ownedGoalIds.find(goalId => goalId === requiredGoalId)
      : ownedGoalIds.at(-1);
    if (!ownedGoalId) {
      const goalDetail = requiredGoalId ? ` Goal '${requiredGoalId}' is not owned here.` : '';
      throw new Error(
        `No active goal found for agent '${elementName}' in this session.${goalDetail} ` +
        'Use execute_agent to start a new goal. If you are reporting progress for ' +
        'the current goal, use mcp_aql_create record_execution_step.',
      );
    }
    return ownedGoalId;
  }

  private async abort(
    manager: AgentManager,
    elementName: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const reason = (params.reason as string) || 'Aborted by user';
    const executionKey = this.executionKey(manager, elementName);
    const executionPolicyAtStart = this.executingAgents.get(executionKey)
      ?? await this.reclaimExistingAgentExecution(manager, elementName);
    const generation = manager.observeExecutionGeneration(elementName);
    try {
      const activeGoalIds = await this.getActiveGoalIds(manager, elementName, true);
      const ownedGoalIds = this.getOwnedActiveGoalIds(activeGoalIds, executionPolicyAtStart);
      if (ownedGoalIds.length === 0) {
        return this.recoverStalePolicy(
          manager,
          elementName,
          executionKey,
          executionPolicyAtStart,
          generation,
          reason,
        );
      }

      this.assertExecutionUnchanged(manager, elementName, executionKey, executionPolicyAtStart, generation.token);

      for (const goalId of ownedGoalIds) {
        await manager.completeAgentGoalForRecovery({
          agentName: elementName,
          goalId,
          outcome: 'failure',
          summary: `Execution aborted: ${reason}`,
        });
        this.abortedGoals.add(this.sessionKey(goalId));
      }

      const remainingGoalIds = await this.getActiveGoalIds(manager, elementName, true);
      const remainingOwnedGoalIds = this.getOwnedActiveGoalIds(
        remainingGoalIds,
        executionPolicyAtStart,
      );
      this.assertExecutionUnchanged(
        manager,
        elementName,
        executionKey,
        executionPolicyAtStart,
        generation.token,
        remainingOwnedGoalIds,
      );

      this.recordResilienceCompletion(executionPolicyAtStart, false, elementName);
      if (this.executingAgents.get(executionKey) === executionPolicyAtStart) {
        this.executingAgents.delete(executionKey);
      }
      this.unblockDangerZone(elementName);
      this.logAbort(elementName, ownedGoalIds, reason);

      return {
        _type: 'AbortResult',
        success: true,
        agentName: elementName,
        abortedGoalIds: ownedGoalIds,
        reason,
        message: `Agent '${elementName}' execution aborted. ${ownedGoalIds.length} goal(s) terminated.`,
      };
    } finally {
      generation.release();
    }
  }

  private async recoverStalePolicy(
    manager: AgentManager,
    elementName: string,
    executionKey: string,
    executionPolicyAtStart: ExecutingAgentEntry | undefined,
    generation: { token: object },
    reason: string,
  ): Promise<unknown> {
    if (!executionPolicyAtStart) {
      // There is no stale in-memory policy to mutate. A concurrent execution
      // remains untouched, so preserve the established no-active-execution
      // result instead of treating unrelated generation history as a race.
      throw new Error(
        `No active execution found for agent '${elementName}' in this session. Nothing to abort.`,
      );
    }
    this.assertExecutionUnchanged(
      manager,
      elementName,
      executionKey,
      executionPolicyAtStart,
      generation.token,
    );

    const revalidatedGoalIds = await this.getActiveGoalIds(manager, elementName, true);
    const revalidatedOwnedGoalIds = this.getOwnedActiveGoalIds(
      revalidatedGoalIds,
      executionPolicyAtStart,
    );
    this.assertExecutionUnchanged(
      manager,
      elementName,
      executionKey,
      executionPolicyAtStart,
      generation.token,
      revalidatedOwnedGoalIds,
    );

    if (this.executingAgents.get(executionKey) === executionPolicyAtStart) {
      this.executingAgents.delete(executionKey);
      this.unblockDangerZone(elementName);
      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_POLICY_RECOVERED',
        severity: 'MEDIUM',
        source: 'AgentExecutionHandler.abort',
        details: `Recovered stale execution policy for agent: ${elementName}`,
        additionalData: { agentName: elementName, reason: 'stale_execution_policy' },
      });
      return {
        _type: 'AbortResult',
        success: true,
        agentName: elementName,
        abortedGoalIds: [],
        recoveredStalePolicy: true,
        reason,
        message: `Removed stale execution policy for agent '${elementName}'. ` +
          'No active goal owned by this session remained.',
      };
    }

    throw new Error(
      `No active execution found for agent '${elementName}' in this session. Nothing to abort.`,
    );
  }

  private getOwnedActiveGoalIds(
    activeGoalIds: string[],
    executionEntry: ExecutingAgentEntry | undefined,
  ): string[] {
    if (!executionEntry?.goalIds?.length) {
      return [];
    }
    const ownedGoalIds = new Set(executionEntry.goalIds);
    return activeGoalIds.filter(goalId => ownedGoalIds.has(goalId));
  }

  private assertExecutionUnchanged(
    manager: AgentManager,
    elementName: string,
    executionKey: string,
    executionPolicyAtStart: ExecutingAgentEntry | undefined,
    generationToken: object,
    activeGoalIds: string[] = [],
  ): void {
    const currentPolicy = this.executingAgents.get(executionKey);
    if (
      activeGoalIds.length > 0 ||
      manager.hasExecutionGenerationChanged(elementName, generationToken) ||
      (currentPolicy !== undefined && currentPolicy !== executionPolicyAtStart)
    ) {
      throw new Error(
        `Execution state changed while aborting agent '${elementName}'. ` +
        'The newer execution policy was preserved; retry abort_execution to abort it.'
      );
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

    const ownedGoalId = await this.requireOwnedActiveGoal(manager, elementName, goalId);
    const gatheredData = await manager.getGatheredData({
      agentName: elementName,
      goalId: ownedGoalId,
    });
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
      const meta = agentElement?.metadata as Partial<AgentMetadataV2> | undefined;
      const activeElements: Record<string, string[]> = { agents: [elementName] };
      for (const [elementType, names] of Object.entries(meta?.activates ?? {})) {
        if (!names) {
          continue;
        }
        activeElements[elementType] = elementType === 'agents'
          ? [...new Set([...names, elementName])]
          : [...names];
      }
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
    if (
      manager.canonicalizeExecutionName(restoredState.agentName) !==
      manager.canonicalizeExecutionName(elementName)
    ) {
      logger.warn('Handoff agent mismatch detected', {
        expectedAgent: elementName,
        blockAgent: restoredState.agentName,
      });
      throw new Error('Handoff agent mismatch: the handoff block was not prepared for this agent');
    }

    const ownedGoalId = await this.requireOwnedActiveGoal(
      manager,
      elementName,
      restoredState.goalId,
    );
    const callerParams = isRecord(params.parameters) ? params.parameters : {};
    const continueResult = await manager.continueAgentExecution({
      agentName: elementName,
      goalId: ownedGoalId,
      previousStepResult: `Resumed from handoff (goalId: ${restoredState.goalId}, ${restoredState.goalProgress.stepsCompleted} steps completed)`,
      parameters: {
        ...callerParams,
        resumedFromHandoff: true,
        originalGoalId: restoredState.goalId,
      },
    });
    await this.trackExecutingAgent(
      manager,
      elementName,
      params,
      undefined,
      continueResult.goalId,
      true,
    );

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

  private collectNotifications(
    agentName: string,
    goalId: string,
    autonomy: Record<string, unknown>,
  ): AgentNotification[] {
    return [
      ...this.collectGatekeeperNotifications(agentName),
      ...this.collectAutonomyNotifications(autonomy),
      ...this.collectDangerZoneNotifications(agentName, goalId),
    ];
  }

  private collectGatekeeperNotifications(agentName: string): AgentNotification[] {
    const executingAgent = this.executingAgents.get(
      this.executionKey(this.handlers.agentManager, agentName),
    );
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
    const explicitReason = typeof autonomy.reason === 'string' ? autonomy.reason : '';
    const factors = Array.isArray(autonomy.factors)
      ? autonomy.factors.filter((factor): factor is string => typeof factor === 'string')
      : [];
    const reason = explicitReason || factors.join(', ');
    return reason ? [{
      type: 'autonomy_pause',
      message: `Agent paused: ${reason}`,
      metadata: { reason },
      timestamp: new Date().toISOString(),
    }] : [];
  }

  private collectDangerZoneNotifications(agentName: string, goalId: string): AgentNotification[] {
    const enforcer = this.handlers.dangerZoneEnforcer;
    if (!enforcer) {
      return [];
    }

    const blockCheck = enforcer.check(agentName);
    const sessionId = this.contextTracker?.getSessionContext?.()?.sessionId;
    // Execution responses are not a global operator feed: only return the block
    // created for this agent's active goal in this exact session. Undefined
    // session IDs match for stdio, but a session-owned block is suppressed when
    // runtime context is unavailable. Legacy blocks without goal ownership are
    // likewise enforced without being replayed as fresh goal notifications.
    if (
      !blockCheck.blocked ||
      blockCheck.sessionId !== sessionId ||
      blockCheck.goalId !== goalId ||
      !blockCheck.blockedAt
    ) {
      return [];
    }

    return [{
      type: 'danger_zone',
      message: `Agent '${agentName}' is blocked due to danger zone trigger: ${blockCheck.reason}`,
      metadata: {
        agentName,
        eventId: blockCheck.eventId,
        goalId,
        reason: blockCheck.reason,
        verificationId: blockCheck.verificationId,
      },
      timestamp: blockCheck.blockedAt,
    }];
  }

  private evaluateResilience(
    agentName: string,
    updateResult: Record<string, unknown>,
    stepOutcome: string
  ): Record<string, unknown> | null {
    const autonomy = updateResult.autonomy as { continue: boolean; reason?: string; factors?: string[] } | undefined;
    const executingAgent = this.executingAgents.get(
      this.executionKey(this.handlers.agentManager, agentName),
    );
    const context = this.buildResilienceContext(agentName, stepOutcome, autonomy, executingAgent);
    if (!autonomy || !context || !executingAgent?.resiliencePolicy) {
      return null;
    }

    const action = evaluateResiliencePolicy(executingAgent.resiliencePolicy, context, this.handlers.circuitBreaker);
    switch (action.action) {
      case 'continue':
        return this.continueAfterResilience(agentName, updateResult, autonomy, executingAgent, action, context);
      case 'retry':
        return this.retryAfterResilience(agentName, updateResult, autonomy, executingAgent, action, context);
      case 'restart':
        return this.restartAfterResilience(agentName, updateResult, autonomy, executingAgent, action, context);
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

  private async getActiveGoalIds(
    manager: AgentManager,
    agentName: string,
    strict = false,
  ): Promise<string[]> {
    try {
      const stateResult = strict
        ? await manager.getAgentStateForRecovery({ agentName })
        : await manager.getAgentState({ agentName });
      return stateResult.state.goals
        .filter((g: { status: string }) => g.status === 'in_progress')
        .map((g: { id: string }) => g.id);
    } catch (error) {
      if (strict && !(error instanceof ElementNotFoundError)) {
        throw error;
      }
      return [];
    }
  }
}
