import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
/** Same-instance asynchronous persistence ordering; no cross-process durability claim. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function observer() {
  const firstEntered = deferred(), releaseFirst = deferred(), completed = deferred();
  const attempted: string[][] = [], written: string[][] = [];
  const writeFile = jest.fn<(file: string, content: string) => Promise<void>>(async (_file, content) => {
    const agents = Object.keys((JSON.parse(content) as { blocks: Record<string, unknown> }).blocks).sort((left, right) => left.localeCompare(right));
    attempted.push(agents);
    if (attempted.length === 1) {
      firstEntered.resolve();
      await releaseFirst.promise;
    }
    written.push(agents);
    if (written.length === 2) completed.resolve();
  });
  const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore({ withWriteLock: async (_file: string, operation: () => Promise<unknown>) => operation(), createDirectory: async (directory: string) => { await fs.mkdir(directory, { recursive: true }); }, writeFile, readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } as unknown as FileOperationsService, path.join(os.tmpdir(), `isolated-test-security-${randomUUID()}`)));
  await enforcer.initialize();
  enforcer.setAdminToken('fixture-admin');
  return { enforcer, firstEntered, releaseFirst, completed, attempted, written };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('DangerZoneEnforcer persistence ordering', () => {
  it.each(['second block', 'unblock', 'clear all'] as const)('keeps %s behind an in-flight older snapshot', async mutation => {
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const state = await observer();
    state.enforcer.block('first-agent', 'fixture', ['test']);
    await state.firstEntered.promise;
    let pending: Promise<unknown>;
    try {
      if (mutation === 'second block') pending = state.enforcer.block('second-agent', 'fixture', ['test']);
      else if (mutation === 'unblock') pending = state.enforcer.unblock('first-agent');
      else pending = state.enforcer.clearAll('fixture-admin');
      await nextTurn();
      expect(state.attempted).toEqual([['first-agent']]);
    } finally {
      state.releaseFirst.resolve();
      await state.completed.promise;
      await pending!;
    }
    const finalAgents = mutation === 'second block' ? ['first-agent', 'second-agent'] : [];
    expect(state.written).toEqual([['first-agent'], finalAgents]);
    expect((await state.enforcer.getBlockedAgents()).sort()).toEqual(finalAgents);
  });

  it('persists later state after an earlier write fails', async () => {
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const firstEntered = deferred(), releaseFirst = deferred(), completed = deferred();
    const diskFailure = new Error('fixture write failure');
    const attempted: string[][] = [];
    const writeFile = jest.fn<(file: string, content: string) => Promise<void>>(async (_file, content) => {
      attempted.push(Object.keys((JSON.parse(content) as { blocks: Record<string, unknown> }).blocks).sort());
      if (attempted.length === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        throw diskFailure;
      }
      completed.resolve();
    });
    const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore({ withWriteLock: async (_file: string, operation: () => Promise<unknown>) => operation(), createDirectory: async (directory: string) => { await fs.mkdir(directory, { recursive: true }); }, writeFile, readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } } as unknown as FileOperationsService, path.join(os.tmpdir(), `isolated-test-security-${randomUUID()}`)));
    await enforcer.initialize();
    const first = enforcer.block('first-agent', 'fixture', ['test']);
    await firstEntered.promise;
    const second = enforcer.block('second-agent', 'fixture', ['test']);
    releaseFirst.resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(await enforcer.flush()).toBe(false);
    await enforcer.initialize();
    await completed.promise;
    expect(attempted).toEqual([['first-agent'], ['first-agent'], ['first-agent', 'second-agent']]);
    expect(await enforcer.flush()).toBe(true);
    expect((await enforcer.getBlockedAgents()).sort()).toEqual(['first-agent', 'second-agent']);
  });
});
