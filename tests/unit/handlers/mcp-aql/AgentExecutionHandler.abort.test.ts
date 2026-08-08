import { jest } from '@jest/globals';

import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { AgentExecutionHandler } from '../../../../src/handlers/mcp-aql/AgentExecutionHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ExecutingAgentEntry } from '../../../../src/handlers/mcp-aql/shared.js';

interface ManagerMocks {
  manager: AgentManager;
  executeAgent: jest.Mock;
  read: jest.Mock;
  continueAgentExecution: jest.Mock;
  completeAgentGoal: jest.Mock;
  getAgentStateForRecovery: jest.Mock;
  completeAgentGoalForRecovery: jest.Mock;
  hasExecutionGenerationChanged: jest.Mock;
  release: jest.Mock;
}

function policy(name = 'test-agent', goalId = 'goal-1'): ExecutingAgentEntry {
  return {
    name,
    goalIds: [goalId],
    metadata: { gatekeeper: { default: 'ask' } },
    startedAt: Date.now(),
    continuationCount: 0,
    retryCount: 0,
    recentBlocks: [],
  };
}

function stateWithGoals(goals: Array<{ id: string; status: string }>) {
  return { state: { goals } };
}

function createManager(): ManagerMocks {
  const executeAgent = jest.fn().mockResolvedValue({
    agentName: 'test-agent',
    goal: 'Test goal',
    goalId: 'goal-1',
  });
  const read = jest.fn().mockResolvedValue({ metadata: {} });
  const continueAgentExecution = jest.fn().mockResolvedValue({
    agentName: 'test-agent',
    goal: 'Continued goal',
    goalId: 'goal-2',
  });
  const completeAgentGoal = jest.fn().mockImplementation(({ goalId }) => Promise.resolve({
    success: true,
    goal: { id: goalId },
  }));
  const getAgentStateForRecovery = jest.fn();
  const completeAgentGoalForRecovery = jest.fn().mockResolvedValue({ success: true });
  const hasExecutionGenerationChanged = jest.fn().mockReturnValue(false);
  const release = jest.fn();
  const manager = {
    executeAgent,
    read,
    continueAgentExecution,
    completeAgentGoal,
    getAgentStateForRecovery,
    completeAgentGoalForRecovery,
    hasExecutionGenerationChanged,
    observeExecutionGeneration: jest.fn().mockReturnValue({ token: {}, release }),
    canonicalizeExecutionName: jest.fn((name: string) => name
      .replaceAll(/([a-z])([A-Z])/g, '$1-$2')
      .replaceAll(/[\s_]+/g, '-')
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .replaceAll(/-+/g, '-')
      .replaceAll(/^-/g, '')
      .replaceAll(/-$/g, '')),
  } as unknown as AgentManager;

  return {
    manager,
    executeAgent,
    read,
    continueAgentExecution,
    completeAgentGoal,
    getAgentStateForRecovery,
    completeAgentGoalForRecovery,
    hasExecutionGenerationChanged,
    release,
  };
}

function createHandler(
  manager: AgentManager,
  executingAgents: Map<string, ExecutingAgentEntry>,
  abortedGoals = new Set<string>(),
  sessionId = 'session-a',
) {
  const handlers = { agentManager: manager } as unknown as HandlerRegistry;
  return {
    handler: new AgentExecutionHandler(
      handlers,
      executingAgents,
      abortedGoals,
      (name) => `${sessionId}:${name}`,
    ),
    abortedGoals,
  };
}

describe('AgentExecutionHandler abort recovery', () => {
  it('tracks goal ownership even when the agent has no optional execution policies', async () => {
    const mocks = createManager();
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('execute', { element_name: 'test-agent', parameters: {} });

    expect(executingAgents.get('session-a:test-agent')).toEqual(expect.objectContaining({
      name: 'test-agent',
      goalIds: ['goal-1'],
      metadata: {},
    }));
  });

  it('retains every goal started by the same session', async () => {
    const mocks = createManager();
    mocks.executeAgent
      .mockResolvedValueOnce({ agentName: 'test-agent', goal: 'First', goalId: 'goal-1' })
      .mockResolvedValueOnce({ agentName: 'test-agent', goal: 'Second', goalId: 'goal-2' });
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('execute', { element_name: 'test-agent', parameters: {} });
    await handler.dispatch('execute', { element_name: 'test-agent', parameters: {} });

    expect(executingAgents.get('session-a:test-agent')?.goalIds).toEqual(['goal-1', 'goal-2']);
  });

  it('tracks a continuation goal without resetting the existing execution state', async () => {
    const mocks = createManager();
    const executionEntry = policy('test-agent', 'goal-1');
    executionEntry.continuationCount = 2;
    const executingAgents = new Map([
      ['session-a:test-agent', executionEntry],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('continue', {
      element_name: 'test-agent',
      previousStepResult: 'Paused after review',
      parameters: { task: 'Resume review' },
    });

    expect(executingAgents.get('session-a:test-agent')).toBe(executionEntry);
    expect(executionEntry.goalIds).toEqual(['goal-1', 'goal-2']);
    expect(executionEntry.continuationCount).toBe(2);

    await handler.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Continuation complete',
    });

    expect(mocks.completeAgentGoal).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-2',
    }));
    expect(executionEntry.goalIds).toEqual(['goal-1']);
  });

  it('uses the canonical agent identity across lifecycle aliases', async () => {
    const mocks = createManager();
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('execute', { element_name: 'MyAgent', parameters: {} });
    await handler.dispatch('complete', {
      element_name: 'my-agent',
      outcome: 'success',
      summary: 'Completed through canonical alias',
    });

    expect(mocks.completeAgentGoal).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'my-agent',
      goalId: 'goal-1',
    }));
    expect(executingAgents.has('session-a:my-agent')).toBe(false);
  });

  it('uses the canonical agent identity when aborting through an alias', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery
      .mockResolvedValueOnce(stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]))
      .mockResolvedValueOnce(stateWithGoals([{ id: 'goal-1', status: 'failed' }]));
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('execute', { element_name: 'MyAgent', parameters: {} });
    const result = await handler.dispatch('abort', { element_name: 'my-agent' });

    expect(result).toEqual(expect.objectContaining({ abortedGoalIds: ['goal-1'] }));
    expect(mocks.completeAgentGoalForRecovery).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'my-agent',
      goalId: 'goal-1',
    }));
    expect(executingAgents.has('session-a:my-agent')).toBe(false);
  });

  it('completes the newest session-owned goal and retains older ownership', async () => {
    const mocks = createManager();
    const executionEntry = policy('test-agent', 'goal-1');
    executionEntry.goalIds = ['goal-1', 'goal-2'];
    const executingAgents = new Map([
      ['session-a:test-agent', executionEntry],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    await handler.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Second execution complete',
    });

    expect(mocks.completeAgentGoal).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-2',
    }));
    expect(executingAgents.get('session-a:test-agent')?.goalIds).toEqual(['goal-1']);
  });

  it('rejects completion of a goal owned by another session', async () => {
    const mocks = createManager();
    const executingAgents = new Map([
      ['session-a:test-agent', policy('test-agent', 'goal-a')],
      ['session-b:test-agent', policy('test-agent', 'goal-b')],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    await expect(handler.dispatch('complete', {
      element_name: 'test-agent',
      goalId: 'goal-b',
      outcome: 'success',
      summary: 'Wrong session',
    })).rejects.toThrow("Goal 'goal-b' is not owned by this session");

    expect(mocks.completeAgentGoal).not.toHaveBeenCalled();
  });

  it('rejects completion when the calling session owns no goal', async () => {
    const mocks = createManager();
    const executingAgents = new Map([
      ['session-b:test-agent', policy('test-agent', 'goal-b')],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    await expect(handler.dispatch('complete', {
      element_name: 'test-agent',
      goalId: 'goal-b',
      outcome: 'success',
      summary: 'Wrong session',
    })).rejects.toThrow("No active execution found for agent 'test-agent' in this session");
    await expect(handler.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Implicit wrong session',
    })).rejects.toThrow("No active execution found for agent 'test-agent' in this session");

    expect(mocks.completeAgentGoal).not.toHaveBeenCalled();
    expect(executingAgents.get('session-b:test-agent')?.goalIds).toEqual(['goal-b']);
  });

  it('reclaims an orphaned durable goal after HTTP session cleanup', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(
      stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]),
    );
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-b');

    await handler.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Completed after reconnect',
    });

    expect(mocks.completeAgentGoal).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
    }));
    expect(executingAgents.has('session-b:test-agent')).toBe(false);
  });

  it('does not reclaim a durable goal still owned by a live session', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(
      stateWithGoals([{ id: 'goal-a', status: 'in_progress' }]),
    );
    const liveEntry = policy('test-agent', 'goal-a');
    const executingAgents = new Map([
      ['session-a:test-agent', liveEntry],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-b');

    await expect(handler.dispatch('complete', {
      element_name: 'test-agent',
      goalId: 'goal-a',
      outcome: 'success',
      summary: 'Wrong live session',
    })).rejects.toThrow("No active execution found for agent 'test-agent' in this session");

    expect(mocks.completeAgentGoal).not.toHaveBeenCalled();
    expect(executingAgents.get('session-a:test-agent')).toBe(liveEntry);
  });

  it('allows only one replacement session to claim the same orphaned goal', async () => {
    const mocks = createManager();
    const lookupResolvers: Array<(value: ReturnType<typeof stateWithGoals>) => void> = [];
    mocks.getAgentStateForRecovery.mockImplementation(() => new Promise((resolve) => {
      lookupResolvers.push(resolve);
    }));
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const sessionB = createHandler(mocks.manager, executingAgents, undefined, 'session-b').handler;
    const sessionC = createHandler(mocks.manager, executingAgents, undefined, 'session-c').handler;

    const completionB = sessionB.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Replacement B',
    });
    const completionC = sessionC.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'Replacement C',
    });
    while (lookupResolvers.length < 2) {
      await Promise.resolve();
    }
    for (const resolve of lookupResolvers) {
      resolve(stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]));
    }

    const results = await Promise.allSettled([completionB, completionC]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(mocks.completeAgentGoal).toHaveBeenCalledTimes(1);
  });

  it('reclaims the original goal before continuing after reconnect', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(
      stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]),
    );
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-b');

    await handler.dispatch('continue', {
      element_name: 'test-agent',
      previousStepResult: 'Resume after reconnect',
      parameters: {},
    });

    expect(executingAgents.get('session-b:test-agent')?.goalIds).toEqual(['goal-1', 'goal-2']);
  });

  it('preserves a newer same-session execution while completion is pending', async () => {
    const mocks = createManager();
    let markCompletionStarted: (() => void) | undefined;
    const completionStarted = new Promise<void>((resolve) => {
      markCompletionStarted = resolve;
    });
    let resolveCompletion: ((value: { success: boolean; goal: { id: string } }) => void) | undefined;
    mocks.completeAgentGoal.mockImplementation(() => new Promise((resolve) => {
      markCompletionStarted?.();
      resolveCompletion = resolve;
    }));
    const originalEntry = policy('test-agent', 'goal-1');
    const executingAgents = new Map([
      ['session-a:test-agent', originalEntry],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    const completion = handler.dispatch('complete', {
      element_name: 'test-agent',
      outcome: 'success',
      summary: 'First execution complete',
    });
    await completionStarted;

    const newerEntry = policy('test-agent', 'goal-2');
    newerEntry.goalIds = ['goal-1', 'goal-2'];
    executingAgents.set('session-a:test-agent', newerEntry);
    resolveCompletion?.({ success: true, goal: { id: 'goal-1' } });

    await completion;

    expect(executingAgents.get('session-a:test-agent')).toBe(newerEntry);
    expect(newerEntry.goalIds).toEqual(['goal-2']);
  });

  it('rejects invalid runtime limits before creating an untracked goal', async () => {
    const mocks = createManager();
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents);

    await expect(handler.dispatch('execute', {
      element_name: 'test-agent',
      parameters: {},
      maxAutonomousSteps: -1,
    })).rejects.toThrow('maxAutonomousSteps must be a non-negative integer');

    expect(mocks.executeAgent).not.toHaveBeenCalled();
    expect(executingAgents.size).toBe(0);
  });

  it('removes a stale policy only after two strict durable-state reads', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(stateWithGoals([]));
    const executingAgents = new Map([['session-a:test-agent', policy()]]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    const result = await handler.dispatch('abort', { element_name: 'test-agent' });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      recoveredStalePolicy: true,
      abortedGoalIds: [],
    }));
    expect(mocks.getAgentStateForRecovery).toHaveBeenCalledTimes(2);
    expect(executingAgents.has('session-a:test-agent')).toBe(false);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('preserves policy when strict durable-state lookup fails', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockRejectedValue(new Error('state store unavailable'));
    const originalPolicy = policy();
    const executingAgents = new Map([['session-a:test-agent', originalPolicy]]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    await expect(handler.dispatch('abort', { element_name: 'test-agent' }))
      .rejects.toThrow('state store unavailable');

    expect(executingAgents.get('session-a:test-agent')).toBe(originalPolicy);
    expect(mocks.completeAgentGoalForRecovery).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('preserves policy and abort markers when durable completion fails', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(
      stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]),
    );
    mocks.completeAgentGoalForRecovery.mockRejectedValue(new Error('version conflict'));
    const originalPolicy = policy();
    const executingAgents = new Map([['session-a:test-agent', originalPolicy]]);
    const { handler, abortedGoals } = createHandler(mocks.manager, executingAgents);

    await expect(handler.dispatch('abort', { element_name: 'test-agent' }))
      .rejects.toThrow('version conflict');

    expect(executingAgents.get('session-a:test-agent')).toBe(originalPolicy);
    expect(abortedGoals).not.toContain('session-a:goal-1');
  });

  it('preserves a newer policy when execution restarts during goal lookup', async () => {
    const mocks = createManager();
    let resolveLookup: ((value: ReturnType<typeof stateWithGoals>) => void) | undefined;
    mocks.getAgentStateForRecovery.mockImplementation(() => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    const originalPolicy = policy();
    const newerPolicy = policy();
    newerPolicy.startedAt += 1;
    const executingAgents = new Map([['session-a:test-agent', originalPolicy]]);
    const { handler } = createHandler(mocks.manager, executingAgents);

    const abortPromise = handler.dispatch('abort', { element_name: 'test-agent' });
    await Promise.resolve();
    executingAgents.set('session-a:test-agent', newerPolicy);
    mocks.hasExecutionGenerationChanged.mockReturnValue(true);
    resolveLookup?.(stateWithGoals([{ id: 'new-goal', status: 'in_progress' }]));

    await expect(abortPromise).rejects.toThrow('newer execution policy was preserved');
    expect(executingAgents.get('session-a:test-agent')).toBe(newerPolicy);
    expect(mocks.completeAgentGoalForRecovery).not.toHaveBeenCalled();
  });

  it('removes only the calling session policy', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(stateWithGoals([]));
    const sessionAPolicy = policy();
    const sessionBPolicy = policy();
    const executingAgents = new Map([
      ['session-a:test-agent', sessionAPolicy],
      ['session-b:test-agent', sessionBPolicy],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-a');

    await handler.dispatch('abort', { element_name: 'test-agent' });

    expect(executingAgents.has('session-a:test-agent')).toBe(false);
    expect(executingAgents.get('session-b:test-agent')).toBe(sessionBPolicy);
  });

  it('aborts only the goal owned by the calling session', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery
      .mockResolvedValueOnce(stateWithGoals([
        { id: 'goal-a', status: 'in_progress' },
        { id: 'goal-b', status: 'in_progress' },
      ]))
      .mockResolvedValueOnce(stateWithGoals([
        { id: 'goal-a', status: 'failed' },
        { id: 'goal-b', status: 'in_progress' },
      ]));
    const sessionAPolicy = policy('test-agent', 'goal-a');
    const sessionBPolicy = policy('test-agent', 'goal-b');
    const executingAgents = new Map([
      ['session-a:test-agent', sessionAPolicy],
      ['session-b:test-agent', sessionBPolicy],
    ]);
    const { handler, abortedGoals } = createHandler(
      mocks.manager,
      executingAgents,
      undefined,
      'session-a',
    );

    const result = await handler.dispatch('abort', { element_name: 'test-agent' });

    expect(mocks.completeAgentGoalForRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.completeAgentGoalForRecovery).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-a',
    }));
    expect(result).toEqual(expect.objectContaining({ abortedGoalIds: ['goal-a'] }));
    expect(abortedGoals).toContain('session-a:goal-a');
    expect(abortedGoals).not.toContain('session-a:goal-b');
    expect(executingAgents.get('session-b:test-agent')).toBe(sessionBPolicy);
  });

  it('aborts every active goal owned by the same session', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery
      .mockResolvedValueOnce(stateWithGoals([
        { id: 'goal-1', status: 'in_progress' },
        { id: 'goal-2', status: 'in_progress' },
        { id: 'goal-b', status: 'in_progress' },
      ]))
      .mockResolvedValueOnce(stateWithGoals([
        { id: 'goal-1', status: 'failed' },
        { id: 'goal-2', status: 'failed' },
        { id: 'goal-b', status: 'in_progress' },
      ]));
    const sessionAEntry = policy('test-agent', 'goal-1');
    sessionAEntry.goalIds = ['goal-1', 'goal-2'];
    const executingAgents = new Map([
      ['session-a:test-agent', sessionAEntry],
      ['session-b:test-agent', policy('test-agent', 'goal-b')],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-a');

    const result = await handler.dispatch('abort', { element_name: 'test-agent' });

    expect(mocks.completeAgentGoalForRecovery).toHaveBeenCalledTimes(2);
    expect(mocks.completeAgentGoalForRecovery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ goalId: 'goal-1' }),
    );
    expect(mocks.completeAgentGoalForRecovery).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ goalId: 'goal-2' }),
    );
    expect(result).toEqual(expect.objectContaining({
      abortedGoalIds: ['goal-1', 'goal-2'],
    }));
  });

  it('does not abort another session goal when the caller has no tracked execution', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery.mockResolvedValue(
      stateWithGoals([{ id: 'goal-b', status: 'in_progress' }]),
    );
    const executingAgents = new Map([
      ['session-b:test-agent', policy('test-agent', 'goal-b')],
    ]);
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-a');

    await expect(handler.dispatch('abort', { element_name: 'test-agent' }))
      .rejects.toThrow("No active execution found for agent 'test-agent'");

    expect(mocks.completeAgentGoalForRecovery).not.toHaveBeenCalled();
    expect(executingAgents.has('session-b:test-agent')).toBe(true);
  });

  it('aborts an orphaned durable goal after HTTP session cleanup', async () => {
    const mocks = createManager();
    mocks.getAgentStateForRecovery
      .mockResolvedValueOnce(stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]))
      .mockResolvedValueOnce(stateWithGoals([{ id: 'goal-1', status: 'in_progress' }]))
      .mockResolvedValueOnce(stateWithGoals([{ id: 'goal-1', status: 'failed' }]));
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const { handler } = createHandler(mocks.manager, executingAgents, undefined, 'session-b');

    const result = await handler.dispatch('abort', {
      element_name: 'test-agent',
      reason: 'Reconnect cleanup',
    });

    expect(result).toEqual(expect.objectContaining({ abortedGoalIds: ['goal-1'] }));
    expect(mocks.completeAgentGoalForRecovery).toHaveBeenCalledWith(expect.objectContaining({
      goalId: 'goal-1',
    }));
    expect(executingAgents.has('session-b:test-agent')).toBe(false);
  });
});
