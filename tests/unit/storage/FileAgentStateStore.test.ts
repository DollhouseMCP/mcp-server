import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { AgentState } from '../../../src/elements/agents/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import {
  AgentStateParsedSizeLimitError,
  AgentStateReductionRequiredError,
  AgentStateSizeLimitError,
  FileAgentStateStore,
} from '../../../src/storage/FileAgentStateStore.js';

const RECOVERY_AGENT_STATE_FILE = 'recovery-agent.state.yaml';

const key = { name: 'Recovery Agent', agentElementId: 'agent-id' };

function state(version = 0): AgentState {
  return {
    goals: [],
    decisions: [],
    context: {},
    lastActive: new Date('2026-01-01T00:00:00.000Z'),
    sessionCount: 0,
    stateVersion: version,
  };
}

describe('FileAgentStateStore strict recovery I/O', () => {
  let tempDir: string;
  let stateDir: string;
  let cache: Map<string, AgentState>;
  let serializationService: SerializationService;
  let store: FileAgentStateStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-state-recovery-'));
    stateDir = path.join(tempDir, '.state');
    cache = new Map();
    const lockManager = new FileLockManager();
    serializationService = new SerializationService();
    store = new FileAgentStateStore({
      stateDir,
      fileLockManager: lockManager,
      fileOperations: new FileOperationsService(lockManager),
      serializationService,
      stateCache: cache,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('bypasses stale process-local state during a strict read', async () => {
    await store.save(key, state(), 0);
    const cachedState = cache.get('recovery-agent');
    if (!cachedState) {
      throw new Error('Expected saved state in the process-local cache');
    }
    cachedState.goals.push({
      id: 'cached-only',
      description: 'not durable',
      priority: 'medium',
      status: 'in_progress',
      importance: 5,
      urgency: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const durable = await store.load(key, { strict: true });

    expect(durable?.goals).toEqual([]);
    expect(cache.get('recovery-agent')?.goals).toHaveLength(1);
  });

  it('preserves runtime dates when saving a structured-cloned state', async () => {
    const original = state();
    original.goals.push({
      id: 'dated-goal',
      description: 'Preserve timestamps',
      priority: 'medium',
      status: 'completed',
      importance: 5,
      urgency: 5,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      completedAt: new Date('2026-01-04T00:00:00.000Z'),
    });
    original.decisions.push({
      id: 'dated-decision',
      goalId: 'dated-goal',
      timestamp: new Date('2026-01-03T12:00:00.000Z'),
      decision: 'complete',
      reasoning: 'done',
      framework: 'llm_driven',
      confidence: 1,
    });

    await store.save(key, original, 0);
    const durable = await store.load(key, { strict: true });

    expect(durable?.lastActive.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(durable?.goals[0].createdAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(durable?.goals[0].updatedAt.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    expect(durable?.goals[0].completedAt?.toISOString()).toBe('2026-01-04T00:00:00.000Z');
    expect(durable?.decisions[0].timestamp.toISOString()).toBe('2026-01-03T12:00:00.000Z');
  });

  it('fails closed when asked to reclaim session-neutral file state', async () => {
    await store.save(key, state(), 0);
    const cachedState = cache.get('recovery-agent');
    if (!cachedState) {
      throw new Error('Expected saved state in the process-local cache');
    }
    cachedState.context.cachedOnly = true;

    const reclaimed = await store.reclaimOrphaned(key);

    expect(reclaimed).toBeNull();
    expect(cache.get('recovery-agent')?.context).toEqual({ cachedOnly: true });
  });

  it('defaults malformed integer fields when loading durable state', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), `
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: invalid
stateVersion:
  unexpected: object
`);

    const loaded = await store.load(key);

    expect(loaded).toMatchObject({ sessionCount: 0, stateVersion: 1 });
  });

  it('normalizes malformed nested scalar fields without object stringification', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), `
goals:
  - id: malformed-goal
    description: malformed nested values
    priority: medium
    status: in_progress
    importance:
      unexpected: object
    urgency: true
    estimatedEffort:
      - 1
    createdAt:
      unexpected: object
    updatedAt: 2025-01-02T00:00:00Z
decisions:
  - id: malformed-decision
    goalId: malformed-goal
    decision: inspect
    reasoning: regression proof
    framework: llm_driven
    confidence:
      unexpected: object
    timestamp:
      unexpected: object
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 0
stateVersion: 1
`);

    const loaded = await store.load(key, { strict: true });
    expect(loaded).not.toBeNull();
    if (!loaded) {
      throw new Error('Expected malformed nested scalar fixture to load');
    }
    const goal = loaded.goals.at(0);
    const decision = loaded.decisions.at(0);
    expect(goal).toBeDefined();
    expect(decision).toBeDefined();
    if (!goal || !decision) {
      throw new Error('Expected malformed goal and decision fixtures');
    }

    expect(Number.isNaN(goal.importance)).toBe(true);
    expect(Number.isNaN(goal.urgency)).toBe(true);
    expect(Number.isNaN(goal.estimatedEffort)).toBe(true);
    expect(Number.isNaN(goal.createdAt.getTime())).toBe(true);
    expect(goal.updatedAt.toISOString()).toBe('2025-01-02T00:00:00.000Z');
    expect(Number.isNaN(decision.confidence)).toBe(true);
    expect(Number.isNaN(decision.timestamp.getTime())).toBe(true);
  });

  it.each([
    ['12oops', 1],
    ['3.5', 1],
    ['1e3', 1],
    [-1, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])('defaults a non-integer stateVersion value (%p)', async (stateVersion, expected) => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), `
goals: []
decisions: []
context: {}
lastActive: 2025-01-01T00:00:00Z
sessionCount: 0
stateVersion: ${stateVersion}
`);

    const loaded = await store.load(key);

    expect(loaded?.stateVersion).toBe(expected);
  });

  it('surfaces malformed durable state instead of returning no state', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), ': invalid: yaml: [');

    await expect(store.load(key, { strict: true })).rejects.toThrow();
  });

  it('rejects a recovery save when durable state disappeared', async () => {
    await fs.mkdir(stateDir, { recursive: true });

    await expect(store.save(key, state(1), 1, { requireExisting: true }))
      .rejects.toThrow('state disappeared');
  });

  it('requires the exact durable version during a recovery save', async () => {
    await store.save(key, state(), 0);

    await expect(store.save(key, state(0), 0, { requireExisting: true }))
      .rejects.toThrow('State version conflict');
  });

  it('uses expectedVersion for ordinary optimistic-lock checks', async () => {
    await store.save(key, state(), 0);
    const misleadingState = state(99);

    await expect(store.save(key, misleadingState, 0))
      .rejects.toThrow('State version conflict');
    expect(misleadingState.stateVersion).toBe(99);
  });

  it('rejects an ordinary save when durable state is newer than expected', async () => {
    await store.save(key, state(), 0);
    const staleState = state(0);

    await expect(store.save(key, staleState, 0))
      .rejects.toThrow('State version conflict');
    expect(staleState.stateVersion).toBe(0);
  });

  it('does not mutate the caller version when size validation rejects a save', async () => {
    const oversized = state();
    oversized.context = { payload: 'x'.repeat(70 * 1024) };

    await expect(store.save(key, oversized, 0)).rejects.toThrow('normal persistence limit');

    expect(oversized.stateVersion).toBe(0);
  });

  it('enforces persistence ceilings using UTF-8 bytes', async () => {
    const oversized = state();
    oversized.context = { payload: 'é'.repeat(35 * 1024) };

    await expect(store.save(key, oversized, 0)).rejects.toBeInstanceOf(AgentStateSizeLimitError);
    expect(oversized.stateVersion).toBe(0);
  });

  it('allows a bounded recovery read while ordinary reads retain the normal limit', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(70 * 1024) } });

    await expect(store.load(key, { strict: true })).rejects.toThrow('exceeds allowed size');
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });

    expect(String(recovered?.context.payload)).toHaveLength(70 * 1024);
  });

  it('enforces ordinary load ceilings using UTF-8 bytes', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'é'.repeat(35 * 1024) } });

    await expect(store.load(key)).rejects.toBeInstanceOf(AgentStateSizeLimitError);
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });

    expect(String(recovered?.context.payload)).toHaveLength(35 * 1024);
  });

  it('permits an oversized recovery save only when it strictly shrinks durable state', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(70 * 1024) } });
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });
    expect(recovered).not.toBeNull();
    if (!recovered) {
      throw new Error('Expected oversized state to load in recovery mode');
    }

    recovered.context = { payload: 'x'.repeat(68 * 1024) };
    await expect(store.save(key, recovered, 1, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).resolves.toBe(2);
    expect(recovered.stateVersion).toBe(2);

    const unchanged = await store.load(key, { strict: true, allowOversizedRecovery: true });
    if (!unchanged) {
      throw new Error('Expected reduced state to remain loadable');
    }
    await expect(store.save(key, unchanged, 2, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).rejects.toThrow('must strictly reduce');
    expect(unchanged.stateVersion).toBe(2);
  });

  it('rejects recovery content beyond the bounded recovery ceiling', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(101 * 1024) } });

    await expect(store.load(key, { strict: true, allowOversizedRecovery: true }))
      .rejects.toThrow('exceeds allowed size');
  });

  it('surfaces compact YAML that expands beyond the parsed-state ceiling', async () => {
    const expandedState = state(1);
    expandedState.context = Object.fromEntries(
      Array.from({ length: 9_000 }, (_, index) => [`k${index}`, 'x']),
    );
    expect(JSON.stringify(expandedState).length).toBeGreaterThan(100 * 1024);
    jest.spyOn(serializationService, 'parseFrontmatter').mockReturnValue({
      data: expandedState as unknown as Record<string, unknown>,
      content: '',
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), 'compact-yaml');

    await expect(store.load(key))
      .rejects.toThrow('Parsed agent state exceeds allowed size');
    await expect(store.load(key, { strict: true, allowOversizedRecovery: true }))
      .rejects.toBeInstanceOf(AgentStateParsedSizeLimitError);
  });

  it('routes an oversized terminal update through the reduction path', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(98 * 1024) } });
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });
    expect(recovered).not.toBeNull();
    if (!recovered) {
      throw new Error('Expected oversized state to load for terminal cleanup');
    }
    recovered.context = { payload: 'x'.repeat(101 * 1024) };

    await expect(store.save(key, recovered, 1, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).rejects.toBeInstanceOf(AgentStateReductionRequiredError);
    expect(recovered.stateVersion).toBe(1);
  });

  it('routes a normal candidate beyond the recovery ceiling through terminal cleanup', async () => {
    const oversized = { ...state(), context: { payload: 'x'.repeat(101 * 1024) } };

    await expect(store.save(key, oversized, 0))
      .rejects.toBeInstanceOf(AgentStateSizeLimitError);
    expect(oversized.stateVersion).toBe(0);
  });

  it('compares recovery reduction against actual durable bytes', async () => {
    const existing = { ...state(1), context: { payload: 'x'.repeat(70 * 1024) } };
    jest.spyOn(serializationService, 'parseFrontmatter').mockReturnValue({
      data: existing as unknown as Record<string, unknown>,
      content: '',
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), 'compact-legacy-state');
    const candidate = { ...state(1), context: { payload: 'x'.repeat(68 * 1024) } };

    await expect(store.save(key, candidate, 1, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).rejects.toBeInstanceOf(AgentStateReductionRequiredError);
    expect(candidate.stateVersion).toBe(1);
  });

  it('does not permit oversized reduction without an existing durable state', async () => {
    const oversized = { ...state(), context: { payload: 'x'.repeat(70 * 1024) } };

    await expect(store.save(key, oversized, 0, { allowOversizedReduction: true }))
      .rejects.toThrow('normal persistence limit');
  });

  async function writeStateFile(agentState: AgentState): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    const serialization = new SerializationService();
    const yaml = serialization.dumpYaml({
      ...agentState,
      lastActive: agentState.lastActive.toISOString(),
      sessionCount: String(agentState.sessionCount),
      stateVersion: String(agentState.stateVersion),
    }, { schema: 'json', noRefs: true, sortKeys: true });
    await fs.writeFile(path.join(stateDir, RECOVERY_AGENT_STATE_FILE), yaml);
  }
});
