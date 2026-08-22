import { describe, expect, it, jest } from '@jest/globals';

import type { AgentManager } from '../../../../src/elements/agents/AgentManager.js';
import type { BlockCheckResult } from '../../../../src/security/DangerZoneEnforcer.js';
import { AgentExecutionHandler } from '../../../../src/handlers/mcp-aql/AgentExecutionHandler.js';
import type {
  CorrelationIdProvider,
  HandlerRegistry,
} from '../../../../src/handlers/mcp-aql/MCPAQLHandler.js';
import type { ExecutingAgentEntry } from '../../../../src/handlers/mcp-aql/shared.js';

const AGENT_NAME = 'test-agent';
const GOAL_ID = 'goal-1';

function executionEntry(): ExecutingAgentEntry {
  return {
    name: AGENT_NAME,
    goalIds: [GOAL_ID],
    metadata: {},
    startedAt: Date.now(),
    continuationCount: 0,
    retryCount: 0,
    recentBlocks: [],
  };
}

function blockedResult(overrides: Partial<BlockCheckResult>): BlockCheckResult {
  return {
    blocked: true,
    eventId: 'event-1',
    reason: 'Beetlejuice test trigger',
    verificationId: 'verification-1',
    blockedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness(
  block: BlockCheckResult,
  contextTracker?: CorrelationIdProvider,
) {
  const check = jest.fn<(agentName: string) => BlockCheckResult>()
    .mockReturnValueOnce({ blocked: false })
    .mockReturnValue(block);
  const recordAgentStep = jest.fn().mockResolvedValue({
    success: true,
    autonomy: { continue: true },
  });
  const manager = {
    canonicalizeExecutionName: jest.fn((name: string) => name),
    recordAgentStep,
  } as unknown as AgentManager;
  const handlers = {
    agentManager: manager,
    dangerZoneEnforcer: { check },
  } as unknown as HandlerRegistry;
  const executingAgents = new Map<string, ExecutingAgentEntry>([
    [`default:${AGENT_NAME}`, executionEntry()],
  ]);
  const handler = new AgentExecutionHandler(
    handlers,
    executingAgents,
    new Set<string>(),
    name => `default:${name}`,
    contextTracker,
  );

  return { check, handler, recordAgentStep };
}

async function recordStep(handler: AgentExecutionHandler): Promise<Record<string, unknown>> {
  return handler.dispatch('updateState', {
    element_name: AGENT_NAME,
    stepDescription: 'Recorded a safe test step',
    outcome: 'success',
    confidence: 1,
  }) as Promise<Record<string, unknown>>;
}

function expectNoDangerZoneNotification(result: Record<string, unknown>): void {
  const autonomy = result.autonomy as { notifications?: Array<{ type: string }> };
  expect(autonomy.notifications?.some(notification => notification.type === 'danger_zone'))
    .not.toBe(true);
}

describe('AgentExecutionHandler DangerZone notification compatibility', () => {
  it('suppresses a session-owned notification when runtime session context is unavailable', async () => {
    const contextTracker = {
      getCorrelationId: () => undefined,
      getSessionContext: () => undefined,
    } as CorrelationIdProvider;
    const { handler, recordAgentStep } = createHarness(
      blockedResult({ sessionId: 'http-session-a', goalId: GOAL_ID }),
      contextTracker,
    );

    expectNoDangerZoneNotification(await recordStep(handler));
    expect(recordAgentStep).toHaveBeenCalledTimes(1);
    await expect(recordStep(handler)).rejects.toThrow('blocked due to danger zone trigger');
    expect(recordAgentStep).toHaveBeenCalledTimes(1);
  });

  it('enforces a legacy block without replaying it as a fresh goal notification', async () => {
    const { handler, recordAgentStep } = createHarness(
      blockedResult({ sessionId: undefined, goalId: undefined }),
    );

    expectNoDangerZoneNotification(await recordStep(handler));
    expect(recordAgentStep).toHaveBeenCalledTimes(1);
    await expect(recordStep(handler)).rejects.toThrow('blocked due to danger zone trigger');
    expect(recordAgentStep).toHaveBeenCalledTimes(1);
  });
});
