import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as nativeFs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { formatResultsErrors } from 'jest-message-util';

const open = jest.fn<(path: string) => number>();
const read = jest.fn<(fd: number, buffer: Buffer) => number>();
const close = jest.fn();
const directories = jest.fn<(path: string) => { readSync(): { name: string } | null; closeSync(): void }>();
let LinuxOwnedGroup: typeof import('../../helpers/linuxOwnedGroup.js').LinuxOwnedGroup;
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
  ({ OwnedFixtureRegistry } = await import('../../helpers/ownedFixtureProcess.js'));
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
});
