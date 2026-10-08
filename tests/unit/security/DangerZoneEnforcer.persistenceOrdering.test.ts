/** Same-instance asynchronous persistence ordering; no cross-process durability claim. */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
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

function observer() {
  const firstEntered = deferred(), releaseFirst = deferred(), completed = deferred();
  const attempted: string[][] = [], written: string[][] = [];
  const writeFile = jest.fn<(file: string, content: string) => Promise<void>>(async (_file, content) => {
    const agents = Object.keys((JSON.parse(content) as { blocks: Record<string, unknown> }).blocks).sort();
    attempted.push(agents);
    if (attempted.length === 1) {
      firstEntered.resolve();
      await releaseFirst.promise;
    }
    written.push(agents);
    if (written.length === 2) completed.resolve();
  });
  const enforcer = new DangerZoneEnforcer({ writeFile } as unknown as FileOperationsService, '/isolated-test-security');
  enforcer.setAdminToken('fixture-admin');
  return { enforcer, firstEntered, releaseFirst, completed, attempted, written };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('DangerZoneEnforcer persistence ordering', () => {
  it.each(['second block', 'unblock', 'clear all'] as const)('keeps %s behind an in-flight older snapshot', async mutation => {
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const state = observer();
    state.enforcer.block('first-agent', 'fixture', ['test']);
    await state.firstEntered.promise;
    try {
      if (mutation === 'second block') state.enforcer.block('second-agent', 'fixture', ['test']);
      else if (mutation === 'unblock') expect(state.enforcer.unblock('first-agent')).toBe(true);
      else expect(state.enforcer.clearAll('fixture-admin')).toBe(true);
      await nextTurn();
      expect(state.attempted).toEqual([['first-agent']]);
    } finally {
      state.releaseFirst.resolve();
      await state.completed.promise;
    }
    const finalAgents = mutation === 'second block' ? ['first-agent', 'second-agent'] : [];
    expect(state.written).toEqual([['first-agent'], finalAgents]);
    expect(state.enforcer.getBlockedAgents().sort()).toEqual(finalAgents);
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
    const enforcer = new DangerZoneEnforcer({ writeFile } as unknown as FileOperationsService, '/isolated-test-security');
    enforcer.block('first-agent', 'fixture', ['test']);
    await firstEntered.promise;
    enforcer.block('second-agent', 'fixture', ['test']);
    releaseFirst.resolve();
    await completed.promise;
    expect(attempted).toEqual([['first-agent'], ['first-agent', 'second-agent']]);
    expect(enforcer.getBlockedAgents().sort()).toEqual(['first-agent', 'second-agent']);
  });
});
