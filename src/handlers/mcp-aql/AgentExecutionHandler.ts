import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { AsyncKeyedLock } from '../../utils/AsyncKeyedLock.js';
import type { AgentManager } from '../../elements/agents/AgentManager.js';
import type { PersistedActivationIdentity } from '../../state/IActivationStateStore.js';
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

interface ResolvedExecutionTarget {
  name: string;
  identity: PersistedActivationIdentity;
  key: string;
}

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
    this.ensureNotDangerZoneBlocked(method, elementName);
    const target = await this.resolveDispatchTarget(method, manager, elementName);

    return this.executionOperationLock.runExclusive(target.key, async () => {
      await this.ensureAgentCanExecute(method, manager, target);

      const handlers: Partial<Record<string, () => Promise<unknown>>> = {
        execute: () => this.executeAgent(manager, target, params),
        getState: () => this.getState(manager, target, params),
        updateState: () => this.updateState(manager, target, params),
        complete: () => this.complete(manager, target, params),
        continue: () => this.continueExecution(manager, target, params),
        abort: () => this.abort(manager, target, params),
        getGatheredData: () => this.getGatheredData(manager, target, params),
        prepareHandoff: () => this.prepareHandoff(manager, target, params),
        resumeFromHandoff: () => this.resumeFromHandoff(manager, target, params),
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
    level: string,
    sourceIdentity?: PersistedActivationIdentity,
  ): void {
    if (!sourceIdentity || this.executingAgents.size === 0) return;

    const block = {
      operation,
      elementType,
      reason,
      level,
      timestamp: new Date().toISOString(),
      reported: false,
    };

    const agentEntry = this.executingAgents.get(this.executionKey(sourceIdentity));
    if (!agentEntry) return;
    agentEntry.recentBlocks.push(block);
    this.trimRecentBlocks(agentEntry);
  }

  private async resolveExecutionTarget(
    manager: AgentManager,
    name: string,
  ): Promise<ResolvedExecutionTarget> {
    const identity = await manager.resolveExecutionIdentity(name);
    return { name, identity, key: this.executionKey(identity) };
  }

  private async resolveDispatchTarget(
    method: string,
    manager: AgentManager,
    name: string,
  ): Promise<ResolvedExecutionTarget> {
    const isTerminalLifecycleOperation = method === 'complete' || method === 'abort';
    if (!isTerminalLifecycleOperation) return this.resolveExecutionTarget(manager, name);

    const trackedTarget = this.findUniqueTrackedTarget(name);
    if (trackedTarget) return trackedTarget;

    try {
      return await this.resolveExecutionTarget(manager, name);
    } catch (error) {
      if (!(error instanceof ElementNotFoundError)) throw error;
      const action = method === 'complete' ? 'complete' : 'abort';
      throw new Error(
        `No active execution found for agent '${name}' in this session. Nothing to ${action}.`,
      );
    }
  }

  private findUniqueTrackedTarget(name: string): ResolvedExecutionTarget | undefined {
    const matches: ResolvedExecutionTarget[] = [];
    for (const [key, entry] of this.executingAgents) {
      if (entry.name !== name || key !== this.executionKey(entry.identity)) continue;
      matches.push({ name, identity: entry.identity, key });
    }
    return matches.length === 1 ? matches[0] : undefined;
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
    target: ResolvedExecutionTarget,
  ): Promise<void> {
    if (method === 'execute' || method === 'getState' || method === 'abort') {
      return;
    }
    await this.ensureNoAbortedGoals(manager, target);
  }

  private ensureNotDangerZoneBlocked(method: string, elementName: string): void {
    if (method === 'getState' || method === 'abort' || !this.handlers.dangerZoneEnforcer) {
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

  private async ensureNoAbortedGoals(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
  ): Promise<void> {
    const agentGoalIds = await this.getActiveGoalIds(manager, target.name, false, target.identity);
    for (const goalId of agentGoalIds) {
      if (this.abortedGoals.has(this.sessionKey(goalId))) {
        throw new Error(
          `Agent '${target.name}' execution was aborted (goalId: ${goalId}). ` +
          `Further execution operations are rejected. Use execute_agent to start a new execution.`
        );
      }
    }
  }

  private async executeAgent(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const runtimeMaxSteps = this.validateRuntimeMaxSteps(params.maxAutonomousSteps);
    const executeResult = await manager.executeAgent(
      target.name,
      params.parameters as Record<string, unknown>,
      { executionIdentity: target.identity },
    );
    await this.trackExecutingAgent(
      manager,
      target,
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
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>,
    runtimeMaxSteps: number | undefined,
    goalId: string | undefined,
    preserveExistingState = false,
  ): Promise<void> {
    const previousEntry = this.executingAgents.get(target.key);
    const goalIds = [...(previousEntry?.goalIds ?? [])];
    if (goalId && !goalIds.includes(goalId)) {
      goalIds.push(goalId);
    }
    if (preserveExistingState && previousEntry) {
      previousEntry.goalIds = goalIds;
      return;
    }
    const executionEntry: ExecutingAgentEntry = {
      name: target.name,
      identity: target.identity,
      goalIds,
      metadata: runtimeMaxSteps === undefined ? {} : { maxAutonomousSteps: runtimeMaxSteps },
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      originalParameters: params.parameters as Record<string, unknown> | undefined,
      recentBlocks: [],
    };
    this.executingAgents.set(target.key, executionEntry);

    await this.hydrateExecutionPolicies(manager, target.name, executionEntry);
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
    target: ResolvedExecutionTarget,
  ): Promise<ExecutingAgentEntry | undefined> {
    const existingEntry = this.executingAgents.get(target.key);
    if (existingEntry) {
      return existingEntry;
    }

    const excludedGoalIds = this.getTrackedGoalIds(target);
    const reclaimedState = await manager.reclaimOrphanedAgentState({
      agentName: target.name,
      excludedGoalIds,
      executionIdentity: target.identity,
    });
    const concurrentEntry = this.executingAgents.get(target.key);
    if (concurrentEntry) {
      return concurrentEntry;
    }
    const activeGoalIds = reclaimedState?.goals
      .filter(goal => goal.status === 'in_progress')
      .map(goal => goal.id) ?? [];
    const orphanedGoalIds = activeGoalIds.filter(goalId =>
      !this.isGoalTrackedByAnotherSession(target, goalId)
    );
    if (orphanedGoalIds.length === 0) {
      return undefined;
    }

    const reclaimedEntry: ExecutingAgentEntry = {
      name: target.name,
      identity: target.identity,
      goalIds: orphanedGoalIds,
      metadata: {},
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      recentBlocks: [],
    };
    // Claim every orphan synchronously before policy hydration yields. This
    // prevents two reconnecting sessions from adopting the same durable goal.
    this.executingAgents.set(target.key, reclaimedEntry);
    await this.hydrateExecutionPolicies(manager, target.name, reclaimedEntry);
    logger.info('Reclaimed orphaned agent execution for replacement session', {
      agentName: target.name,
      goalIds: orphanedGoalIds,
    });
    return reclaimedEntry;
  }

  private async reclaimExistingAgentExecution(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
  ): Promise<ExecutingAgentEntry | undefined> {
    try {
      return await this.reclaimOrphanedExecution(manager, target);
    } catch (error) {
      if (error instanceof ElementNotFoundError) {
        return undefined;
      }
      throw error;
    }
  }

  private isGoalTrackedByAnotherSession(
    target: ResolvedExecutionTarget,
    goalId: string,
  ): boolean {
    for (const [executionKey, entry] of this.executingAgents) {
      if (
        executionKey !== target.key &&
        this.identitiesEqual(entry.identity, target.identity) &&
        entry.goalIds?.includes(goalId)
      ) {
        return true;
      }
    }
    return false;
  }

  private getTrackedGoalIds(
    target: ResolvedExecutionTarget,
  ): string[] {
    const trackedGoalIds = new Set<string>();
    for (const [executionKey, entry] of this.executingAgents) {
      if (
        executionKey !== target.key &&
        this.identitiesEqual(entry.identity, target.identity)
      ) {
        for (const goalId of entry.goalIds ?? []) {
          trackedGoalIds.add(goalId);
        }
      }
    }
    return [...trackedGoalIds];
  }

  private identitiesEqual(
    left: PersistedActivationIdentity,
    right: PersistedActivationIdentity,
  ): boolean {
    return left.kind === right.kind && left.value === right.value;
  }

  private executionKey(identity: PersistedActivationIdentity): string {
    return this.sessionKey(`${identity.kind}:${identity.value}`);
  }

  private async getState(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const stateResult = await manager.getAgentState({
      agentName: target.name,
      includeDecisionHistory: params.includeDecisionHistory as boolean | undefined,
      includeContext: params.includeContext as boolean | undefined,
      executionIdentity: target.identity,
    });
    return { _type: 'ExecutionState', ...stateResult };
  }

  private async updateState(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const nextActionHint = this.validateNextActionHint(params.nextActionHint);
    const riskScore = this.validateRiskScore(params.riskScore);
    const executingAgent = this.executingAgents.get(target.key)
      ?? await this.reclaimOrphanedExecution(manager, target);
    const ownedGoalId = executingAgent?.goalIds?.at(-1);
    if (!executingAgent || !ownedGoalId) {
      throw new Error(
        `No active goal found for agent '${target.name}' in this session. ` +
        'Use execute_agent to start a new goal first.',
      );
    }

    const updateResult = await manager.recordAgentStep({
      agentName: target.name,
      goalId: ownedGoalId,
      stepDescription: params.stepDescription as string,
      outcome: params.outcome as StepOutcome,
      findings: params.findings as string,
      confidence: params.confidence as number,
      nextActionHint,
      riskScore,
      maxStepsOverride: executingAgent.metadata.maxAutonomousSteps as number | undefined,
      executionIdentity: target.identity,
    });

    const finalResult = this.evaluateResilience(target, updateResult, params.outcome as string) ?? updateResult;
    this.attachNotifications(target, ownedGoalId, finalResult);
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
    target: ResolvedExecutionTarget,
    goalId: string,
    result: Record<string, unknown>,
  ): void {
    const autonomy = result.autonomy as Record<string, unknown> | undefined;
    if (!autonomy) {
      return;
    }
    const notifications = this.collectNotifications(target, goalId, autonomy);
    if (notifications.length > 0) {
      autonomy.notifications = notifications;
    }
  }

  private async complete(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const completedAgent = this.executingAgents.get(target.key)
      ?? await this.reclaimExistingAgentExecution(manager, target);
    const requestedGoalId = params.goalId as string | undefined;
    if (!completedAgent?.goalIds?.length) {
      throw new Error(
        `No active execution found for agent '${target.name}' in this session. ` +
        'Nothing to complete.',
      );
    }
    if (requestedGoalId && !completedAgent.goalIds.includes(requestedGoalId)) {
      throw new Error(
        `Goal '${requestedGoalId}' is not owned by this session's execution of '${target.name}'.`,
      );
    }
    const ownedGoalId = requestedGoalId ?? completedAgent.goalIds.at(-1);
    if (!ownedGoalId) {
      throw new Error(`No owned goal found for agent '${target.name}' in this session.`);
    }
    const completeResult = await manager.completeAgentGoal({
      agentName: target.name,
      outcome: params.outcome as StepOutcome,
      summary: params.summary as string,
      goalId: ownedGoalId,
      executionIdentity: target.identity,
    });

    this.recordResilienceCompletion(completedAgent, params.outcome === 'success', target.name);
    const currentAgent = this.executingAgents.get(target.key);
    if (currentAgent?.goalIds?.includes(ownedGoalId)) {
      currentAgent.goalIds = currentAgent.goalIds.filter(id => id !== ownedGoalId);
    }
    if (currentAgent && currentAgent.goalIds?.length === 0) {
      this.executingAgents.delete(target.key);
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
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const ownedGoalId = await this.requireOwnedActiveGoal(manager, target);

    const continueResult = await manager.continueAgentExecution({
      agentName: target.name,
      goalId: ownedGoalId,
      previousStepResult: params.previousStepResult as string | undefined,
      parameters: params.parameters as Record<string, unknown> | undefined,
      executionIdentity: target.identity,
    });
    await this.trackExecutingAgent(
      manager,
      target,
      params,
      undefined,
      continueResult.goalId,
      true,
    );
    return { _type: 'ContinueResult', ...continueResult };
  }

  private async requireOwnedActiveGoal(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    requiredGoalId?: string,
  ): Promise<string> {
    const executionEntry = this.executingAgents.get(target.key)
      ?? await this.reclaimOrphanedExecution(manager, target);
    if (!executionEntry) {
      throw new Error(
        `No active execution found for agent '${target.name}' in this session. ` +
        'Use execute_agent to start a new goal. If you are reporting progress for ' +
        'the current goal, use mcp_aql_create record_execution_step.',
      );
    }

    const activeGoalIds = await this.getActiveGoalIds(manager, target.name, true, target.identity);
    const ownedGoalIds = this.getOwnedActiveGoalIds(activeGoalIds, executionEntry);
    const ownedGoalId = requiredGoalId
      ? ownedGoalIds.find(goalId => goalId === requiredGoalId)
      : ownedGoalIds.at(-1);
    if (!ownedGoalId) {
      const goalDetail = requiredGoalId ? ` Goal '${requiredGoalId}' is not owned here.` : '';
      throw new Error(
        `No active goal found for agent '${target.name}' in this session.${goalDetail} ` +
        'Use execute_agent to start a new goal. If you are reporting progress for ' +
        'the current goal, use mcp_aql_create record_execution_step.',
      );
    }
    return ownedGoalId;
  }

  private async abort(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const reason = (params.reason as string) || 'Aborted by user';
    const executionPolicyAtStart = this.executingAgents.get(target.key)
      ?? await this.reclaimExistingAgentExecution(manager, target);
    const generation = manager.observeExecutionGeneration(target.identity);
    try {
      const activeGoalIds = await this.getActiveGoalIds(manager, target.name, true, target.identity);
      const ownedGoalIds = this.getOwnedActiveGoalIds(activeGoalIds, executionPolicyAtStart);
      if (ownedGoalIds.length === 0) {
        return await this.recoverStalePolicy(
          manager,
          target,
          executionPolicyAtStart,
          generation,
          reason,
        );
      }

      this.assertExecutionUnchanged(manager, target, executionPolicyAtStart, generation.token);

      for (const goalId of ownedGoalIds) {
        await manager.completeAgentGoalForRecovery({
          agentName: target.name,
          goalId,
          outcome: 'failure',
          summary: `Execution aborted: ${reason}`,
          executionIdentity: target.identity,
        });
        this.abortedGoals.add(this.sessionKey(goalId));
      }

      const remainingGoalIds = await this.getActiveGoalIds(
        manager,
        target.name,
        true,
        target.identity,
      );
      const remainingOwnedGoalIds = this.getOwnedActiveGoalIds(
        remainingGoalIds,
        executionPolicyAtStart,
      );
      this.assertExecutionUnchanged(
        manager,
        target,
        executionPolicyAtStart,
        generation.token,
        remainingOwnedGoalIds,
      );

      this.recordResilienceCompletion(executionPolicyAtStart, false, target.name);
      if (this.executingAgents.get(target.key) === executionPolicyAtStart) {
        this.executingAgents.delete(target.key);
      }
      this.logAbort(target.name, ownedGoalIds, reason);

      return {
        _type: 'AbortResult',
        success: true,
        agentName: target.name,
        abortedGoalIds: ownedGoalIds,
        reason,
        message: `Agent '${target.name}' execution aborted. ${ownedGoalIds.length} goal(s) terminated.`,
      };
    } finally {
      generation.release();
    }
  }

  private async recoverStalePolicy(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    executionPolicyAtStart: ExecutingAgentEntry | undefined,
    generation: { token: object },
    reason: string,
  ): Promise<unknown> {
    if (!executionPolicyAtStart) {
      // There is no stale in-memory policy to mutate. A concurrent execution
      // remains untouched, so preserve the established no-active-execution
      // result instead of treating unrelated generation history as a race.
      throw new Error(
        `No active execution found for agent '${target.name}' in this session. Nothing to abort.`,
      );
    }
    this.assertExecutionUnchanged(
      manager,
      target,
      executionPolicyAtStart,
      generation.token,
    );

    const revalidatedGoalIds = await this.getActiveGoalIds(
      manager,
      target.name,
      true,
      target.identity,
    );
    const revalidatedOwnedGoalIds = this.getOwnedActiveGoalIds(
      revalidatedGoalIds,
      executionPolicyAtStart,
    );
    this.assertExecutionUnchanged(
      manager,
      target,
      executionPolicyAtStart,
      generation.token,
      revalidatedOwnedGoalIds,
    );

    if (this.executingAgents.get(target.key) === executionPolicyAtStart) {
      this.executingAgents.delete(target.key);
      SecurityMonitor.logSecurityEvent({
        type: 'AGENT_POLICY_RECOVERED',
        severity: 'MEDIUM',
        source: 'AgentExecutionHandler.abort',
        details: `Recovered stale execution policy for agent: ${target.name}`,
        additionalData: { agentName: target.name, reason: 'stale_execution_policy' },
      });
      return {
        _type: 'AbortResult',
        success: true,
        agentName: target.name,
        abortedGoalIds: [],
        recoveredStalePolicy: true,
        reason,
        message: `Removed stale execution policy for agent '${target.name}'. ` +
          'No active goal owned by this session remained.',
      };
    }

    throw new Error(
      `No active execution found for agent '${target.name}' in this session. Nothing to abort.`,
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
    target: ResolvedExecutionTarget,
    executionPolicyAtStart: ExecutingAgentEntry | undefined,
    generationToken: object,
    activeGoalIds: string[] = [],
  ): void {
    const currentPolicy = this.executingAgents.get(target.key);
    if (
      activeGoalIds.length > 0 ||
      manager.hasExecutionGenerationChanged(target.identity, generationToken) ||
      (currentPolicy !== undefined && currentPolicy !== executionPolicyAtStart)
    ) {
      throw new Error(
        `Execution state changed while aborting agent '${target.name}'. ` +
        'The newer execution policy was preserved; retry abort_execution to abort it.'
      );
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
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const goalId = params.goalId;
    if (typeof goalId !== 'string' || !goalId) {
      throw new Error('goalId is required for get_gathered_data');
    }
    const gatheredData = await manager.getGatheredData({
      agentName: target.name,
      goalId,
      executionIdentity: target.identity,
    });
    return { _type: 'GatheredData', ...gatheredData };
  }

  private async prepareHandoff(
    manager: AgentManager,
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const goalId = params.goalId;
    if (typeof goalId !== 'string' || !goalId) {
      throw new Error('goalId is required for prepare_handoff');
    }

    const ownedGoalId = await this.requireOwnedActiveGoal(manager, target, goalId);
    const gatheredData = await manager.getGatheredData({
      agentName: target.name,
      goalId: ownedGoalId,
      executionIdentity: target.identity,
    });
    const { activeElements, successCriteria } = await this.getHandoffMetadata(manager, target.name);
    const handoffState = prepareHandoffState(target.name, gatheredData, activeElements, successCriteria);

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
    target: ResolvedExecutionTarget,
    params: Record<string, unknown>
  ): Promise<unknown> {
    const handoffBlockParam = params.handoffBlock;
    if (typeof handoffBlockParam !== 'string' || !handoffBlockParam) {
      throw new Error('handoffBlock is required for resume_from_handoff (the full handoff block text)');
    }

    const restoredState = parseHandoffBlock(handoffBlockParam);
    let restoredIdentity: PersistedActivationIdentity;
    try {
      restoredIdentity = await manager.resolveExecutionIdentity(restoredState.agentName);
    } catch {
      throw new Error('Handoff agent mismatch: the handoff block was not prepared for this agent');
    }
    if (!this.identitiesEqual(restoredIdentity, target.identity)) {
      logger.warn('Handoff agent mismatch detected', {
        expectedAgent: target.name,
        blockAgent: restoredState.agentName,
      });
      throw new Error('Handoff agent mismatch: the handoff block was not prepared for this agent');
    }

    const ownedGoalId = await this.requireOwnedActiveGoal(
      manager,
      target,
      restoredState.goalId,
    );
    const callerParams = isRecord(params.parameters) ? params.parameters : {};
    const continueResult = await manager.continueAgentExecution({
      agentName: target.name,
      goalId: ownedGoalId,
      previousStepResult: `Resumed from handoff (goalId: ${restoredState.goalId}, ${restoredState.goalProgress.stepsCompleted} steps completed)`,
      parameters: {
        ...callerParams,
        resumedFromHandoff: true,
        originalGoalId: restoredState.goalId,
      },
      executionIdentity: target.identity,
    });
    await this.trackExecutingAgent(
      manager,
      target,
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
    target: ResolvedExecutionTarget,
    goalId: string,
    autonomy: Record<string, unknown>,
  ): AgentNotification[] {
    return [
      ...this.collectGatekeeperNotifications(target.key),
      ...this.collectAutonomyNotifications(autonomy),
      ...this.collectDangerZoneNotifications(target.name, goalId),
    ];
  }

  private collectGatekeeperNotifications(executionKey: string): AgentNotification[] {
    const executingAgent = this.executingAgents.get(executionKey);
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
    target: ResolvedExecutionTarget,
    updateResult: Record<string, unknown>,
    stepOutcome: string
  ): Record<string, unknown> | null {
    const autonomy = updateResult.autonomy as { continue: boolean; reason?: string; factors?: string[] } | undefined;
    const executingAgent = this.executingAgents.get(target.key);
    const context = this.buildResilienceContext(target.name, stepOutcome, autonomy, executingAgent);
    if (!autonomy || !context || !executingAgent?.resiliencePolicy) {
      return null;
    }

    const action = evaluateResiliencePolicy(executingAgent.resiliencePolicy, context, this.handlers.circuitBreaker);
    switch (action.action) {
      case 'continue':
        return this.continueAfterResilience(target.name, updateResult, autonomy, executingAgent, action, context);
      case 'retry':
        return this.retryAfterResilience(target.name, updateResult, autonomy, executingAgent, action, context);
      case 'restart':
        return this.restartAfterResilience(target.name, updateResult, autonomy, executingAgent, action, context);
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
    executionIdentity?: PersistedActivationIdentity,
  ): Promise<string[]> {
    try {
      const stateResult = strict
        ? await manager.getAgentStateForRecovery({ agentName, executionIdentity })
        : await manager.getAgentState({ agentName, executionIdentity });
      return stateResult.state.goals
        .filter((g: { status: string }) => g.status === 'in_progress')
        .map((g: { id: string }) => g.id);
    } catch (error) {
      if (
        strict
        && !(error instanceof ElementNotFoundError)
        && (error as { code?: unknown }).code !== 'ESTALE'
      ) {
        throw error;
      }
      return [];
    }
  }
}
