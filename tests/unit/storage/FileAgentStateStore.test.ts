import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import type { AgentState } from '../../../src/elements/agents/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../src/services/SerializationService.js';
import { FileAgentStateStore } from '../../../src/storage/FileAgentStateStore.js';
import { crashFilesystemGuardOwner } from '../../helpers/crashFilesystemGuardOwner.js';

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
  let store: FileAgentStateStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-state-recovery-'));
    stateDir = path.join(tempDir, '.state');
    cache = new Map();
    const lockManager = new FileLockManager();
    store = new FileAgentStateStore({
      stateDir,
      fileLockManager: lockManager,
      fileOperations: new FileOperationsService(lockManager),
      serializationService: new SerializationService(),
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

  it('rereads durable version while holding the cross-process save guard', async () => {
    await expect(store.save(key, state(), 0)).resolves.toBe(1);
    await store.load(key);
    const secondLockManager = new FileLockManager();
    const secondStore = new FileAgentStateStore({
      stateDir,
      fileLockManager: secondLockManager,
      fileOperations: new FileOperationsService(secondLockManager),
      serializationService: new SerializationService(),
      stateCache: new Map(),
    });
    const secondState = await secondStore.load(key, { strict: true });
    if (!secondState) throw new Error('expected durable state');
    await expect(secondStore.save(key, secondState, 1)).resolves.toBe(2);

    await expect(store.save(key, state(1), 1)).rejects.toThrow('State version conflict');
    await expect(store.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 2 });
  });

  it('fails closed when asked to reclaim session-neutral file state', async () => {
    await store.save(key, state(), 0);
    cache.get('recovery-agent')!.context.cachedOnly = true;

    const reclaimed = await store.reclaimOrphaned(key);

    expect(reclaimed).toBeNull();
    expect(cache.get('recovery-agent')?.context).toEqual({ cachedOnly: true });
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

  it('rejects an ordinary save when an existing durable state file is empty', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'recovery-agent.state.yaml'), '');

    await expect(store.save(key, state(), 0)).rejects.toThrow('YAML must contain an object at root level');
  });

  it('rejects a recovery save when durable state disappeared', async () => {
    await fs.mkdir(stateDir, { recursive: true });

    await expect(store.save(key, state(1), 1, { requireExisting: true }))
      .rejects.toThrow('state disappeared');
  });

  it('rejects a nonzero expectedVersion when no durable state exists', async () => {
    await expect(store.save(key, state(4), 4)).rejects.toThrow('State version conflict');
    await expect(store.load(key, { strict: true })).resolves.toBeNull();
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

  it('does not resurrect state deleted by another process', async () => {
    await expect(store.save(key, state(), 0)).resolves.toBe(1);
    await store.load(key);

    const secondLockManager = new FileLockManager();
    const secondStore = new FileAgentStateStore({
      stateDir,
      fileLockManager: secondLockManager,
      fileOperations: new FileOperationsService(secondLockManager),
      serializationService: new SerializationService(),
      stateCache: new Map(),
    });
    await expect(secondStore.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 1 });
    await expect(secondStore.delete(key, { expectedVersion: 1 })).resolves.toBe(true);

    await expect(store.save(key, state(1), 1)).rejects.toThrow('State version conflict');
    await expect(store.load(key, { strict: true })).resolves.toBeNull();
  });

  it('allows a fresh create after strict absence while continuing to reject the stale object', async () => {
    const stale = state();
    await expect(store.save(key, stale, 0)).resolves.toBe(1);

    const secondLockManager = new FileLockManager();
    const secondStore = new FileAgentStateStore({
      stateDir,
      fileLockManager: secondLockManager,
      fileOperations: new FileOperationsService(secondLockManager),
      serializationService: new SerializationService(),
      stateCache: new Map(),
    });
    await expect(secondStore.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 1 });
    await expect(secondStore.delete(key, { expectedVersion: 1 })).resolves.toBe(true);

    await expect(store.load(key, { strict: true })).resolves.toBeNull();
    await expect(store.save(key, state(), 0)).resolves.toBe(1);
    await expect(store.save(key, stale, 1)).rejects.toThrow('State version conflict');
  });

  it('rejects a stale state after another process deletes and recreates the same version', async () => {
    const stale = state();
    await expect(store.save(key, stale, 0)).resolves.toBe(1);

    const secondLockManager = new FileLockManager();
    const secondStore = new FileAgentStateStore({
      stateDir,
      fileLockManager: secondLockManager,
      fileOperations: new FileOperationsService(secondLockManager),
      serializationService: new SerializationService(),
      stateCache: new Map(),
    });
    await expect(secondStore.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 1 });
    await expect(secondStore.delete(key, { expectedVersion: 1 })).resolves.toBe(true);
    await expect(secondStore.save(key, state(), 0)).resolves.toBe(1);

    await expect(store.save(key, stale, 1)).rejects.toThrow('State version conflict');
    await expect(store.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 1 });
  });

  it('clears stale cached state when a strict delete finds no durable file', async () => {
    await expect(store.save(key, state(), 0)).resolves.toBe(1);
    await store.load(key);
    await fs.unlink(path.join(stateDir, 'recovery-agent.state.yaml'));

    await expect(store.delete(key, { expectedVersion: 1 })).resolves.toBe(false);
    expect(cache.has('recovery-agent')).toBe(false);
  });

  it('reclaims a state guard abandoned by a crashed process incarnation', async () => {
    const guardPath = path.join(stateDir, '.locks', 'recovery-agent.guard');
    await crashFilesystemGuardOwner(guardPath);

    await expect(store.save(key, state(), 0)).resolves.toBe(1);
    await expect(store.load(key, { strict: true })).resolves.toMatchObject({ stateVersion: 1 });
  });
});
