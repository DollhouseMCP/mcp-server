import { jest } from '@jest/globals';

import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { AgentExecutionHandler } from '../../../../src/handlers/mcp-aql/AgentExecutionHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ExecutingAgentEntry } from '../../../../src/handlers/mcp-aql/shared.js';

interface ManagerMocks {
  manager: AgentManager;
  getAgentStateForRecovery: jest.Mock;
  completeAgentGoalForRecovery: jest.Mock;
  hasExecutionGenerationChanged: jest.Mock;
  release: jest.Mock;
}

function policy(name = 'test-agent'): ExecutingAgentEntry {
  return {
    name,
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
  const getAgentStateForRecovery = jest.fn();
  const completeAgentGoalForRecovery = jest.fn().mockResolvedValue({ success: true });
  const hasExecutionGenerationChanged = jest.fn().mockReturnValue(false);
  const release = jest.fn();
  const manager = {
    getAgentStateForRecovery,
    completeAgentGoalForRecovery,
    hasExecutionGenerationChanged,
    observeExecutionGeneration: jest.fn().mockReturnValue({ token: {}, release }),
  } as unknown as AgentManager;

  return {
    manager,
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
});
