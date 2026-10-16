import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as nativeFs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { formatResultsErrors } from 'jest-message-util';

const open = jest.fn<(path: string) => number>();
const read = jest.fn<(fd: number, buffer: Buffer) => number>();
const close = jest.fn();
const directories = jest.fn<(path: string) => { readSync(): { name: string } | null; closeSync(): void }>();
let LinuxOwnedGroup: typeof import('../../helpers/linuxOwnedGroup.js').LinuxOwnedGroup;
let OwnedFixtureProcess: typeof import('../../helpers/ownedFixtureProcess.js').OwnedFixtureProcess;
let OwnedFixtureRegistry: typeof import('../../helpers/ownedFixtureProcess.js').OwnedFixtureRegistry;
let metadata: Map<number, string>, files: Map<number, number>;
let entries: string[], nextFd: number;
function stat(pid: number, started = '100', session = 123): string {
  const fields = Array<string>(20).fill('0');
  fields[0] = 'S'; fields[2] = '123'; fields[3] = String(session);
  fields[17] = '1'; fields[19] = started;
  return `${pid} (synthetic process) ${fields.join(' ')}`;
}
beforeAll(async () => {
  const fs = { ...nativeFs, openSync: open, readSync: read, closeSync: close, opendirSync: directories };
  jest.unstable_mockModule('node:fs', () => fs); jest.doMock('node:fs', () => fs);
  ({ LinuxOwnedGroup } = await import('../../helpers/linuxOwnedGroup.js'));
  ({ OwnedFixtureRegistry, OwnedFixtureProcess } = await import('../../helpers/ownedFixtureProcess.js'));
});
beforeEach(() => {
  metadata = new Map([[123, stat(123)], [124, stat(124)]]);
  files = new Map(); entries = ['123', '124']; nextFd = 1;
  open.mockReset(); read.mockReset(); close.mockReset(); directories.mockReset();
  open.mockImplementation(path => {
    const pid = Number(path.split('/')[2]);
    if (!metadata.has(pid)) throw Object.assign(new Error('private-path-not-for-output'), { code: 'ENOENT' });
    const fd = nextFd++; files.set(fd, pid); return fd;
  });
  read.mockImplementation((fd, buffer) => buffer.write(metadata.get(files.get(fd)!)!));
  directories.mockImplementation(() => {
    const names = [...entries]; let index = 0;
    return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} };
  });
});
const deadline = () => performance.now() + 2500;

describe('Linux authorization refusal evidence without OS resources', () => {
  it('preserves exact original read order and successful capture', () => {
    const group = new LinuxOwnedGroup(123);
    expect(group.captureBeforeKill(deadline())).toBe(true);
    expect(open.mock.calls.map(([path]) => path)).toEqual([
      '/proc/123/stat', '/proc/123/stat', '/proc/123/stat', '/proc/124/stat', '/proc/123/stat',
    ]);
    expect(group.refusalDetail()).toBeUndefined();
    expect(group.captureBeforeKill(deadline())).toBe(true);
    expect(open).toHaveBeenCalledTimes(7);
  });
  it('distinguishes missing initial leader and keeps first refusal across repeated calls', () => {
    metadata.delete(123);
    const group = new LinuxOwnedGroup(123);
    expect(group.captureBeforeKill(deadline())).toBe(false);
    const first = group.refusalDetail();
    expect(first).toEqual({ mode: 'first', stage: 'initial-leader', reason: 'missing-leader', retained: null, observed: null, code: null });
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toEqual(first);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('distinguishes an initial observation exception from a missing leader', () => {
    open.mockImplementationOnce(() => { throw Object.assign(new Error('private/path'), { code: 'EACCES' }); });
    const group = new LinuxOwnedGroup(123);
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ stage: 'initial-leader', reason: 'observation-error', code: 'EACCES' });
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('reports reused leader without admitting it or querying a census', () => {
    const group = new LinuxOwnedGroup(123); metadata.set(123, stat(123, '101'));
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ stage: 'current-leader', reason: 'leader-mismatch' });
    expect(directories).not.toHaveBeenCalled();
  });
  it('retains a repeated member mismatch with only bounded counts', () => {
    const group = new LinuxOwnedGroup(123); expect(group.captureBeforeKill(deadline())).toBe(true);
    metadata.set(124, stat(124, '101'));
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toEqual({ mode: 'repeated', stage: 'member-match', reason: 'members-mismatch', retained: 2, observed: 2, code: null });
    const copied = group.refusalDetail()!; copied.code = 'raw-private-data';
    expect(group.refusalDetail()!.code).toBeNull();
  });
  it.each(['EACCES', 'PRIVATE-SECRET'])('reports only allowlisted error code %s from the existing census', code => {
    const group = new LinuxOwnedGroup(123);
    directories.mockImplementationOnce(() => { throw Object.assign(new Error('private/path'), { code }); });
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toEqual({ mode: 'first', stage: 'census', reason: 'observation-error', retained: null, observed: null, code: code === 'EACCES' ? code : null });
    expect(JSON.stringify(group.refusalDetail())).not.toContain('private/path');
  });
  it('ignores an error-code getter that itself throws', () => {
    const group = new LinuxOwnedGroup(123);
    directories.mockImplementationOnce(() => { throw { get code() { throw new Error('private'); } }; });
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ reason: 'observation-error', code: null });
  });
  it('refuses a wrong-session census member without a post-leader read', () => {
    const group = new LinuxOwnedGroup(123); metadata.set(124, stat(124, '100', 999));
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ stage: 'member-match', reason: 'members-mismatch', observed: 2 });
    expect(open).toHaveBeenCalledTimes(4);
  });
  it('records a changed leader at the existing final recheck', () => {
    const group = new LinuxOwnedGroup(123);
    read.mockImplementation((fd, buffer) => {
      const pid = files.get(fd)!; const written = buffer.write(metadata.get(pid)!);
      if (pid === 124) metadata.set(123, stat(123, '101'));
      return written;
    });
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ stage: 'post-leader', reason: 'leader-mismatch', observed: 2 });
    expect(open).toHaveBeenCalledTimes(5);
  });
  it('keeps an empty repeated census refused', () => {
    const group = new LinuxOwnedGroup(123); expect(group.captureBeforeKill(deadline())).toBe(true);
    entries = [];
    expect(group.captureBeforeKill(deadline())).toBe(false);
    expect(group.refusalDetail()).toMatchObject({ mode: 'repeated', reason: 'members-mismatch', retained: 2, observed: 0 });
  });
  it.each([false, true])('preserves actual retained-owner refusal with diagnostic sink failure %s', async sinkFails => {
    const group = new LinuxOwnedGroup(123); expect(group.captureBeforeKill(deadline())).toBe(true);
    metadata.set(124, stat(124, '101'));
    if (sinkFails) jest.spyOn(group, 'refusalDetail').mockImplementation(() => { throw new Error('private/sink'); });
    const registry = new OwnedFixtureRegistry();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const result = await registry.run(async owner => {
        Object.assign(owner, { child: { pid: 123 }, closed: true, linuxGroup: group, cleanupDeadline: deadline() });
        throw false;
      }).then(() => undefined, error => error as AggregateError);
      expect(result!.errors[0]).toBe(false);
      let refusal!: Error;
      try { registry.assertSettled(); } catch (error) { refusal = error as Error; }
      const rendered = formatResultsErrors([{ ancestorTitles: [], title: 'retained owner', fullName: 'retained owner',
        numPassingAsserts: 0, status: 'failed', failureMessages: [refusal.message], failureDetails: [refusal] }],
      { rootDir: process.cwd(), testMatch: [] } as Parameters<typeof formatResultsErrors>[1], { noStackTrace: true }, 'synthetic.test.ts');
      expect(rendered).toContain('Owned Linux group identity is unproved');
      if (sinkFails) {
        expect(rendered).not.toContain('private/sink');
      } else {
        expect(rendered).toContain('Owned Linux capture refusal');
        expect(rendered).toContain('members-mismatch');
      }
      expect(rendered).not.toContain('private/path');
      expect(kill.mock.calls).toEqual([[-123, 0], [-123, 0]]); // Presence query only; never signal an unproved group.
      await expect(registry.run(async () => 'must-not-enter')).rejects.toThrow('unsettled');
    } finally { Object.defineProperty(process, 'platform', platform); kill.mockRestore(); }
  });
  it.each([[undefined, false], [null, false], [false, false], [0, false], ['', false], [new Error('synthetic-original'), false], [false, true]])('retains the initial cancel refusal before original work settles (%p, sink failure %p)', async (primary, sinkFails) => {
    const group = new LinuxOwnedGroup(123); expect(group.captureBeforeKill(deadline())).toBe(true);
    metadata.set(124, stat(124, '101'));
    if (sinkFails) jest.spyOn(group, 'refusalDetail').mockImplementation(() => { throw new Error('private/sink'); });
    const registry = new OwnedFixtureRegistry();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let settled = false;
    let original!: Promise<AggregateError | undefined>;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      original = registry.run(async owner => {
        Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: group });
        enter(); await gate; throw primary;
      }).then(() => { settled = true; return undefined; }, error => { settled = true; return error as AggregateError; });
      await entered;
      let first!: Error;
      try { await registry.cancelUnfinished(); } catch (error) { first = error as Error; }
      expect(first.message).toBe('Owned Linux group identity is unproved; refusing signal and cleanup');
      expect(settled).toBe(false); // Initial throw must not wait for the original callback.
      if (sinkFails) expect(first.cause).toBeUndefined();
      else expect((first.cause as Error).message).toContain('members-mismatch');
      release();
      const pair = await original;
      expect(pair!.errors[0]).toBe(primary);
      let final!: Error;
      try { registry.assertSettled(); } catch (error) { final = error as Error; }
      expect(final.cause).toBe(pair);
      const rendered = formatResultsErrors([{ ancestorTitles: [], title: 'initial cancel refusal', fullName: 'initial cancel refusal',
        numPassingAsserts: 0, status: 'failed', failureMessages: [final.message], failureDetails: [final] }],
      { rootDir: process.cwd(), testMatch: [] } as Parameters<typeof formatResultsErrors>[1], { noStackTrace: true }, 'synthetic.test.ts');
      if (sinkFails) {
        expect(rendered).toContain('Owned Linux group identity is unproved');
        expect(rendered).not.toContain('private/sink');
      } else expect(rendered).toContain('members-mismatch');
      expect(pair!.errors[1]).toBe(first);
      expect(pair!.cause).toBe(first);
      await expect(registry.cancelUnfinished()).rejects.toBe(first);
      await expect(registry.run(async () => 'must-not-enter')).rejects.toThrow('unsettled');
      expect(kill.mock.calls).toEqual([[-123, 0]]);
    } finally {
      release(); await original;
      Object.defineProperty(process, 'platform', platform); kill.mockRestore();
    }
  });

  it('settles an issued request through fresh absence after an empty census without another signal', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const registry = new OwnedFixtureRegistry();
    let owner!: InstanceType<typeof OwnedFixtureProcess>, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let presence = 0, absent = false;
    const kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && ++presence >= 4) { absent = true; throw Object.assign(new Error('absent'), { code: 'ESRCH' }); }
      return true;
    });
    let result!: Promise<{ error: unknown }>;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      result = registry.run(async value => {
        owner = value;
        Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
        await gate; throw false;
      }).then(() => ({ error: 'unexpected success' }), error => ({ error }));
      owner.cancel();
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
      expect(owner.cleaned).toBe(false);
      expect(() => registry.assertSettled()).toThrow('unsettled');
      entries = []; Object.assign(owner, { closed: true }); release();
      expect((await result).error).toBe(false);
      expect(absent).toBe(true); // Empty census alone did not permit cleanup.
      expect(owner.cleaned).toBe(true);
      expect(directories).toHaveBeenCalledTimes(2); // First capture and unsettled zombie observation.
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
      await expect(registry.run(async () => 'next admission')).resolves.toBe('next admission');
    } finally {
      release(); await result;
      Object.defineProperty(process, 'platform', platform); kill.mockRestore();
    }
  });

  it.each(['live', 'reused', 'unknown', 'empty', 'census-error'])('never treats issued request as settlement for %s evidence', async mode => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const owner = new OwnedFixtureProcess();
      Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
      owner.cancel();
      if (mode !== 'live') { metadata.set(123, stat(123).replace(') S ', ') Z ')); metadata.set(124, stat(124).replace(') S ', ') Z ')); }
      if (mode === 'reused') metadata.set(124, stat(124, '101').replace(') S ', ') Z '));
      if (mode === 'unknown') { metadata.set(125, stat(125).replace(') S ', ') Z ')); entries.push('125'); }
      if (mode === 'empty') entries = [];
      if (mode === 'census-error') directories.mockImplementation(() => { throw new Error('unknown census'); });
      Object.assign(owner, { closed: true, cleanupDeadline: performance.now() + 10 });
      await expect(owner.finish()).rejects.toThrow('Owned fixture group did not close');
      expect(owner.cleaned).toBe(false);
      expect(directories.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally { Object.defineProperty(process, 'platform', platform); kill.mockRestore(); }
  });

  it.each(['undefined', 'null', 'false', 'zero', 'empty', 'EPERM', 'throwing-errno'])('retains exact signal failure without retry or success (%s)', async mode => {
    const failures: Record<string, unknown> = { undefined, null: null, false: false, zero: 0, empty: '',
      EPERM: Object.assign(new Error('signal denied'), { code: 'EPERM' }),
      'throwing-errno': { get code() { throw new Error('errno unavailable'); } } };
    const failure = failures[mode];
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') throw failure;
      return true;
    });
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const owner = new OwnedFixtureProcess();
      Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
      let caught = false;
      try { owner.cancel(); } catch (error) { caught = true; expect(error).toBe(failure); }
      expect(caught).toBe(true);
      try { owner.cancel(); } catch (error) { expect(error).toBe(failure); }
      const outcome = await owner.finish().then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
      expect(outcome.failed).toBe(true); expect(outcome.error).toBe(failure);
      expect(owner.cleaned).toBe(false);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally { Object.defineProperty(process, 'platform', platform); kill.mockRestore(); }
  });

  it('records ESRCH request return but still requires child close before cleanup', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let signalled = false;
    const kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') { signalled = true; throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }
      if (signalled) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    let finish!: Promise<void>;
    let owner!: InstanceType<typeof OwnedFixtureProcess>;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      owner = new OwnedFixtureProcess();
      Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
      owner.cancel(); owner.cancel(); finish = owner.finish();
      await Promise.resolve(); expect(owner.cleaned).toBe(false);
      Object.assign(owner, { closed: true });
      (owner as unknown as { resolveClose(): void }).resolveClose();
      await finish; expect(owner.cleaned).toBe(true);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally {
      if (owner) (owner as unknown as { resolveClose(): void }).resolveClose();
      await finish;
      Object.defineProperty(process, 'platform', platform); kill.mockRestore();
    }
  });

  it('still permits only exact retained single-thread zombies after the issued request', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const owner = new OwnedFixtureProcess();
      Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
      owner.cancel();
      metadata.set(123, stat(123).replace(') S ', ') Z ')); metadata.set(124, stat(124).replace(') S ', ') Z '));
      directories.mockImplementation(path => {
        const names = path.endsWith('/task') ? [path.split('/')[2]] : [...entries]; let index = 0;
        return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} };
      });
      Object.assign(owner, { closed: true });
      await owner.finish(); expect(owner.cleaned).toBe(true);
      expect(owner.events.some(event => event.phase === 'owned-group-zombie-only')).toBe(true);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally { Object.defineProperty(process, 'platform', platform); kill.mockRestore(); }
  });

  it('preserves refusal for a normal exited launcher without a prior authorized request', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      const owner = new OwnedFixtureProcess();
      const group = new LinuxOwnedGroup(123); metadata.delete(123); entries = ['124'];
      Object.assign(owner, { child: { pid: 123 }, closed: true, linuxGroup: group });
      await expect(owner.finish()).rejects.toThrow('identity is unproved');
      expect(owner.cleaned).toBe(false);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(0);
    } finally { Object.defineProperty(process, 'platform', platform); kill.mockRestore(); }
  });

  it('refuses cleanup when an issued request never obtains child close within the existing bound', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    jest.useFakeTimers();
    let owner!: InstanceType<typeof OwnedFixtureProcess>;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      owner = new OwnedFixtureProcess();
      Object.assign(owner, { child: { pid: 123 }, closed: false, linuxGroup: new LinuxOwnedGroup(123) });
      owner.cancel();
      const rejected = expect(owner.finish()).rejects.toThrow('Owned fixture cleanup did not settle within 2500ms');
      await jest.advanceTimersByTimeAsync(2500); await rejected;
      expect(owner.cleaned).toBe(false);
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGKILL')).toHaveLength(1);
    } finally {
      if (owner) (owner as unknown as { resolveClose(): void }).resolveClose();
      jest.useRealTimers(); Object.defineProperty(process, 'platform', platform); kill.mockRestore();
    }
  });

});
