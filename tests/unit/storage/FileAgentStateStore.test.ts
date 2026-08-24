import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { AgentState } from '../../../src/elements/agents/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import {
  AgentStateReductionRequiredError,
  FileAgentStateStore,
} from '../../../src/storage/FileAgentStateStore.js';

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
    cache.get('recovery-agent')!.goals.push({
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

  it('reclaims from durable state instead of the process-local cache', async () => {
    await store.save(key, state(), 0);
    cache.get('recovery-agent')!.context.cachedOnly = true;

    const reclaimed = await store.reclaimOrphaned(key);

    expect(reclaimed?.context).toEqual({});
  });

  it('defaults malformed integer fields when loading durable state', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), `
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

  it.each([
    ['12oops', 1],
    ['3.5', 1],
    ['1e3', 1],
    [-1, 1],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])('defaults a non-integer stateVersion value (%p)', async (stateVersion, expected) => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), `
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
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), ': invalid: yaml: [');

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

  it('allows a bounded recovery read while ordinary reads retain the normal limit', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(70 * 1024) } });

    await expect(store.load(key, { strict: true })).rejects.toThrow('exceeds allowed size');
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });

    expect(String(recovered?.context.payload)).toHaveLength(70 * 1024);
  });

  it('permits an oversized recovery save only when it strictly shrinks durable state', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(70 * 1024) } });
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });
    expect(recovered).not.toBeNull();

    recovered!.context = { payload: 'x'.repeat(68 * 1024) };
    await expect(store.save(key, recovered!, 1, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).resolves.toBe(2);
    expect(recovered?.stateVersion).toBe(2);

    const unchanged = await store.load(key, { strict: true, allowOversizedRecovery: true });
    await expect(store.save(key, unchanged!, 2, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).rejects.toThrow('must strictly reduce');
    expect(unchanged?.stateVersion).toBe(2);
  });

  it('rejects recovery content beyond the bounded recovery ceiling', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(101 * 1024) } });

    await expect(store.load(key, { strict: true, allowOversizedRecovery: true }))
      .rejects.toThrow('exceeds allowed size');
  });

  it('rejects compact YAML that expands beyond the parsed-state ceiling', async () => {
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
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), 'compact-yaml');

    await expect(store.load(key, { strict: true, allowOversizedRecovery: true }))
      .rejects.toThrow('Parsed agent state exceeds allowed size');
  });

  it('routes an oversized terminal update through the reduction path', async () => {
    await writeStateFile({ ...state(1), context: { payload: 'x'.repeat(98 * 1024) } });
    const recovered = await store.load(key, { strict: true, allowOversizedRecovery: true });
    expect(recovered).not.toBeNull();
    recovered!.context = { payload: 'x'.repeat(101 * 1024) };

    await expect(store.save(key, recovered!, 1, {
      requireExisting: true,
      allowOversizedReduction: true,
    })).rejects.toBeInstanceOf(AgentStateReductionRequiredError);
    expect(recovered?.stateVersion).toBe(1);
  });

  it('compares recovery reduction against actual durable bytes', async () => {
    const existing = { ...state(1), context: { payload: 'x'.repeat(70 * 1024) } };
    jest.spyOn(serializationService, 'parseFrontmatter').mockReturnValue({
      data: existing as unknown as Record<string, unknown>,
      content: '',
    });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), 'compact-legacy-state');
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
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), yaml);
  }
});
