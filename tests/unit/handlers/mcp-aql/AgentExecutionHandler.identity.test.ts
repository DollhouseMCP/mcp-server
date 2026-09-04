import { describe, expect, it, jest } from '@jest/globals';

import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import { AgentExecutionHandler } from '../../../../src/handlers/mcp-aql/AgentExecutionHandler.js';
import type { HandlerRegistry } from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ExecutingAgentEntry } from '../../../../src/handlers/mcp-aql/shared.js';
import type { PersistedActivationIdentity } from '../../../../src/state/IActivationStateStore.js';
import { ElementNotFoundError } from '../../../../src/utils/ErrorHandler.js';
import {
  createDecisionFromPolicy,
  resolveElementPolicy,
} from '../../../../src/handlers/mcp-aql/policies/ElementPolicies.js';

const FIRST_NAME = 'Case_Sensitive-Agent';
const SECOND_NAME = 'case-sensitive-agent';

describe('AgentExecutionHandler durable execution identity', () => {
  it('preserves the no-active-execution contract when completion names a missing agent', async () => {
    const resolveExecutionIdentity = jest.fn<() => Promise<PersistedActivationIdentity>>()
      .mockRejectedValue(new ElementNotFoundError('Agent', 'missing-agent'));
    const completeAgentGoal = jest.fn();
    const manager = { resolveExecutionIdentity, completeAgentGoal } as unknown as AgentManager;
    const handler = new AgentExecutionHandler(
      { agentManager: manager } as HandlerRegistry,
      new Map(),
      new Set(),
      name => `session-a:${name}`,
    );

    await expect(handler.dispatch('complete', {
      element_name: 'missing-agent',
      outcome: 'success',
      summary: 'Should not complete',
    })).rejects.toThrow(
      "No active execution found for agent 'missing-agent' in this session. Nothing to complete.",
    );

    expect(resolveExecutionIdentity).toHaveBeenCalledWith('missing-agent');
    expect(completeAgentGoal).not.toHaveBeenCalled();
  });

  it('completes a tracked execution against its original identity after name reuse', async () => {
    const originalIdentity = { kind: 'database' as const, value: 'original-row-id' };
    const replacementIdentity = { kind: 'database' as const, value: 'replacement-row-id' };
    const resolveExecutionIdentity = jest.fn<() => Promise<PersistedActivationIdentity>>()
      .mockResolvedValue(replacementIdentity);
    const getAgentState = jest.fn().mockResolvedValue({ state: { goals: [] } });
    const completeAgentGoal = jest.fn().mockResolvedValue({ success: true });
    const manager = {
      resolveExecutionIdentity,
      getAgentState,
      completeAgentGoal,
    } as unknown as AgentManager;
    const trackedEntry: ExecutingAgentEntry = {
      name: 'reused-agent',
      identity: originalIdentity,
      goalIds: ['original-goal'],
      metadata: {},
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      recentBlocks: [],
    };
    const executingAgents = new Map([
      ['session-a:database:original-row-id', trackedEntry],
    ]);
    const handler = new AgentExecutionHandler(
      { agentManager: manager } as HandlerRegistry,
      executingAgents,
      new Set(),
      name => `session-a:${name}`,
    );

    await expect(handler.dispatch('complete', {
      element_name: 'reused-agent',
      outcome: 'success',
      summary: 'Complete the original execution',
    })).resolves.toMatchObject({ success: true });

    expect(resolveExecutionIdentity).not.toHaveBeenCalled();
    expect(getAgentState).toHaveBeenCalledWith(expect.objectContaining({
      executionIdentity: originalIdentity,
    }));
    expect(completeAgentGoal).toHaveBeenCalledWith(expect.objectContaining({
      executionIdentity: originalIdentity,
      goalId: 'original-goal',
    }));
    expect(executingAgents.size).toBe(0);
  });

  it('checks the danger-zone gate before resolving a storage identity', async () => {
    const resolveExecutionIdentity = jest.fn<() => Promise<PersistedActivationIdentity>>()
      .mockResolvedValue({ kind: 'file', value: 'blocked.md' });
    const manager = { resolveExecutionIdentity } as unknown as AgentManager;
    const handler = new AgentExecutionHandler(
      {
        agentManager: manager,
        dangerZoneEnforcer: {
          check: jest.fn().mockReturnValue({
            blocked: true,
            reason: 'dangerous agent',
            resolution: 'Resolve the trigger.',
          }),
        },
      } as unknown as HandlerRegistry,
      new Map(),
      new Set(),
      name => `session-a:${name}`,
    );

    await expect(handler.dispatch('execute', { element_name: 'blocked', parameters: {} }))
      .rejects.toThrow('danger zone trigger');
    expect(resolveExecutionIdentity).not.toHaveBeenCalled();
  });

  it('attributes a Gatekeeper block only to its durable source identity', () => {
    const firstIdentity = { kind: 'file' as const, value: 'first.md' };
    const secondIdentity = { kind: 'file' as const, value: 'second.md' };
    const makeEntry = (name: string, identity: PersistedActivationIdentity): ExecutingAgentEntry => ({
      name,
      identity,
      goalIds: [],
      metadata: {},
      startedAt: Date.now(),
      continuationCount: 0,
      retryCount: 0,
      recentBlocks: [],
    });
    const first = makeEntry('same display', firstIdentity);
    const second = makeEntry('same display', secondIdentity);
    const handler = new AgentExecutionHandler(
      { agentManager: {} as AgentManager } as HandlerRegistry,
      new Map([
        ['session-a:file:first.md', first],
        ['session-a:file:second.md', second],
      ]),
      new Set(),
      name => `session-a:${name}`,
    );

    handler.recordGatekeeperBlock('delete_element', 'agents', 'denied', 'deny', firstIdentity);

    expect(first.recentBlocks).toHaveLength(1);
    expect(second.recentBlocks).toHaveLength(0);
  });

  it('carries an executing agent identity through a denied Gatekeeper decision', () => {
    const identity = { kind: 'database' as const, value: 'agent-row-id' };
    const result = resolveElementPolicy('delete_element', [{
      type: 'agent',
      name: 'Policy Agent',
      executionIdentity: identity,
      metadata: {
        name: 'Policy Agent',
        gatekeeper: { deny: ['delete_element'] },
      },
    }]);

    expect(createDecisionFromPolicy('delete_element', result).sourceIdentity).toEqual(identity);
  });

  it.each([
    { policyKind: 'allow', gatekeeper: { allow: ['create_element'] } },
    { policyKind: 'confirm', gatekeeper: { confirm: ['create_element'] } },
  ])('preserves scope-block attribution when a later policy would $policyKind', ({ gatekeeper }) => {
    const blockingIdentity = { kind: 'database' as const, value: 'blocking-agent-id' };
    const laterIdentity = { kind: 'database' as const, value: 'later-agent-id' };
    const result = resolveElementPolicy('create_element', [
      {
        type: 'agent',
        name: 'Scope Blocker',
        executionIdentity: blockingIdentity,
        metadata: {
          name: 'Scope Blocker',
          gatekeeper: { scopeRestrictions: { allowedTypes: ['skills'] } },
        },
      },
      {
        type: 'agent',
        name: 'Later Policy Agent',
        executionIdentity: laterIdentity,
        metadata: { name: 'Later Policy Agent', gatekeeper },
      },
    ], 'personas');

    expect(result).toMatchObject({
      sourceElement: 'Scope Blocker',
      sourceIdentity: blockingIdentity,
      matchedPolicy: 'scope_restriction',
      scopeBlocked: true,
    });
    const decision = createDecisionFromPolicy('create_element', result, 'personas');
    expect(decision.allowed).toBe(false);
    expect(decision.sourceIdentity).toEqual(blockingIdentity);
    expect(decision.reason).toContain('Scope Blocker');
    expect(decision.reason).not.toContain('Later Policy Agent');
  });

  it.each([
    {
      kind: 'database' as const,
      firstValue: '11111111-1111-4111-8111-111111111111',
      secondValue: '22222222-2222-4222-8222-222222222222',
    },
    {
      kind: 'file' as const,
      firstValue: 'Case_Sensitive-Agent.md',
      secondValue: 'case-sensitive-agent.md',
    },
  ])('keeps canonical-colliding $kind agents in distinct lifecycle entries', async ({
    kind,
    firstValue,
    secondValue,
  }) => {
    const identities = new Map<string, PersistedActivationIdentity>([
      [FIRST_NAME, { kind, value: firstValue }],
      [SECOND_NAME, { kind, value: secondValue }],
    ]);
    const executeAgent = jest.fn<(name: string) => Promise<Record<string, unknown>>>()
      .mockImplementation((name) => Promise.resolve({
        agentName: name,
        goal: `${name} goal`,
        goalId: name === FIRST_NAME ? 'goal-first' : 'goal-second',
      }));
    const read = jest.fn<(name: string) => Promise<Record<string, unknown>>>()
      .mockImplementation((name) => Promise.resolve({
        metadata: name === FIRST_NAME
          ? {
              gatekeeper: { deny: ['delete_element'] },
              resilience: { maxRetries: 1 },
            }
          : {
              gatekeeper: { allow: ['read_element'] },
              resilience: { maxRetries: 7 },
            },
      }));
    const manager = {
      resolveExecutionIdentity: jest.fn((name: string) => Promise.resolve(identities.get(name))),
      executeAgent,
      read,
    } as unknown as AgentManager;
    const executingAgents = new Map<string, ExecutingAgentEntry>();
    const handler = new AgentExecutionHandler(
      { agentManager: manager } as unknown as HandlerRegistry,
      executingAgents,
      new Set<string>(),
      name => `session-a:${name}`,
    );

    await handler.dispatch('execute', { element_name: FIRST_NAME, parameters: {} });
    await handler.dispatch('execute', { element_name: SECOND_NAME, parameters: {} });

    const first = executingAgents.get(`session-a:${kind}:${firstValue}`);
    const second = executingAgents.get(`session-a:${kind}:${secondValue}`);
    expect(executingAgents.size).toBe(2);
    expect(first).toMatchObject({
      name: FIRST_NAME,
      goalIds: ['goal-first'],
      metadata: { gatekeeper: { deny: ['delete_element'] } },
      resiliencePolicy: { maxRetries: 1 },
    });
    expect(second).toMatchObject({
      name: SECOND_NAME,
      goalIds: ['goal-second'],
      metadata: { gatekeeper: { allow: ['read_element'] } },
      resiliencePolicy: { maxRetries: 7 },
    });
  });
});
