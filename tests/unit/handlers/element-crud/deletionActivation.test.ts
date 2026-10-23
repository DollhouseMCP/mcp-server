import { describe, expect, it, jest } from '@jest/globals';
import { atDeletionCommit, currentDeletedActivations, captureDeletedActivations, findStoredActivation } from '../../../../src/handlers/element-crud/deletionActivation.js';
import type { PersistedActivation } from '../../../../src/state/IActivationStateStore.js';

const record = (name: string, filename?: string, identity?: PersistedActivation['identity']): PersistedActivation =>
  ({ name, filename, identity, activatedAt: '2026-10-21T00:00:00Z' });

describe('deletion activation identity', () => {
  it('prefers durable identity over filename and filename over display name', () => {
    const byName = record('shared');
    const byFile = record('other', 'shared');
    const byIdentity = record('another', undefined, { kind: 'database', value: 'shared' });
    expect(findStoredActivation([byName, byFile, byIdentity], 'shared')).toBe(byIdentity);
    expect(findStoredActivation([byName, byFile], 'shared')).toBe(byFile);
    expect(findStoredActivation([byName], 'shared')).toBe(byName);
    expect(findStoredActivation([byName, record('shared', 'other.md')], 'shared')).toBeUndefined();
  });

  it('captures accepted aliases without matching conflicting identities or similar names', async () => {
    const target = { filePath: 'my-skill.md' };
    const exact = record('My Skill', 'my-skill.md');
    const alias = record('my-skill');
    const conflicting = record('My Skill', 'different.md');
    const similar = record('my');
    const resolve = jest.fn<(name: string) => Promise<typeof target | undefined>>()
      .mockImplementation(async name => name === 'my-skill' ? target : undefined);
    expect(await captureDeletedActivations([exact, alias, conflicting, similar], target, 'my-skill.md', resolve))
      .toEqual([exact, alias]);
    expect(resolve.mock.calls).toEqual([['my-skill'], ['my']]);
  });

  it('does not infer an ambiguous name-only record belongs to the target', async () => {
    const target = { filename: 'first.md' };
    const exact = record('Duplicate', 'first.md');
    const ambiguous = record('Duplicate');
    expect(await captureDeletedActivations([exact, ambiguous], target, 'first.md', async () => target)).toEqual([exact]);
  });
  it('retains an unloadable unrelated alias without blocking the healthy target', async () => {
    const target = { filePath: 'healthy.md' };
    const healthy = record('healthy');
    const broken = record('broken');
    const resolve = async (name: string) => {
      if (name === 'broken') throw new Error('Malformed unrelated definition');
      return target;
    };
    await expect(captureDeletedActivations([healthy, broken], target, 'healthy.md', resolve))
      .resolves.toEqual([healthy]);
  });

  it('captures at commit, not preparation, and does nothing if no commit occurs', async () => {
    const complete = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const capture = jest.fn(() => complete);
    const cleanup = atDeletionCommit(capture);
    await cleanup();
    expect(capture).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    cleanup.onCommitted!();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    await cleanup();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('defers capture failures to best-effort cleanup instead of failing committed deletion', async () => {
    const failure = new Error('capture failed');
    const cleanup = atDeletionCommit(() => { throw failure; });
    expect(() => cleanup.onCommitted!()).not.toThrow();
    await expect(cleanup()).rejects.toBe(failure);
  });

  it('refreshes prepared alias lifetimes without claiming conflicting or ambiguous records', () => {
    const prepared = [record('alias')];
    const fresh = record('alias');
    const exact = record('P', 'p.md');
    const other = record('P', 'other.md');
    expect(currentDeletedActivations([fresh, exact, other], prepared, 'p.md')).toEqual([fresh, exact]);
    expect(currentDeletedActivations([fresh, record('alias')], prepared, 'p.md')).toEqual([]);
  });

});
