import { expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { observeLiveOwnerLockCalls, decodeLiveOwnerLockProbe } from './fixtures/liveOwnerLockProbe.js';

function fixture() {
  const fs = { existsSync: jest.fn((..._args: unknown[]) => false), statSync: jest.fn((..._args: unknown[]) => ({ marker: true })),
    readFileSync: jest.fn((..._args: unknown[]): unknown => 'private-provider-output'), rmSync: jest.fn((..._args: unknown[]) => undefined) };
  const childProcess = { execFileSync: jest.fn((..._args: unknown[]): unknown => 'private-provider-output') };
  let now = 10;
  const clock = jest.fn(() => now), syncBuiltinESMExports = jest.fn();
  const originals = { ...fs, execFileSync: childProcess.execFileSync };
  const observation = observeLiveOwnerLockCalls({ fs, childProcess, syncBuiltinESMExports,
    stateFile: 'private-state', pid: 123, clock, started: 0 });
  return { fs, childProcess, originals, clock, syncBuiltinESMExports, observation, advance: () => { now += 7; } };
}

it('delegates exact provider arguments, receiver, returned value and falsy failures, then restores bindings', () => {
  const f = fixture(), receiver = { caller: true }, returned = Buffer.from('private-provider-output');
  const args = ['private-process-argument'], options = { timeout: 51, encoding: 'utf8' };
  f.originals.execFileSync.mockImplementationOnce(function(this: unknown) {
    expect(this).toBe(receiver); f.advance(); return returned as unknown as string;
  });
  expect(Reflect.apply(f.childProcess.execFileSync, receiver, ['private/wmic.exe', args, options])).toBe(returned);
  expect(f.originals.execFileSync.mock.calls[0]).toEqual(['private/wmic.exe', args, options]);
  expect(f.originals.execFileSync.mock.calls[0][1]).toBe(args);
  expect(f.originals.execFileSync.mock.calls[0][2]).toBe(options);
  f.originals.execFileSync.mockImplementationOnce(() => { f.advance(); throw false; });
  let failure: unknown;
  try { Reflect.apply(f.childProcess.execFileSync, receiver, ['private/pwsh.exe', args, options]); }
  catch (cause) { failure = cause; }
  expect(failure).toBe(false);
  expect(f.observation.snapshot().providers.wmic).toEqual({ count: 1, firstEntryMs: 10, totalMs: 7, maxMs: 7, outcome: 'returned' });
  expect(f.observation.snapshot().providers.pwsh).toMatchObject({ count: 1, totalMs: 7, outcome: 'error' });
  expect(f.observation.snapshot().providers.powershell.count).toBe(0);
  expect(JSON.stringify(f.observation.snapshot())).not.toContain('private-');
  f.observation.restore(); f.observation.restore();
  expect(f.childProcess.execFileSync).toBe(f.originals.execFileSync);
  for (const key of ['existsSync', 'statSync', 'readFileSync', 'rmSync'] as const) expect(f.fs[key]).toBe(f.originals[key]);
  expect(f.syncBuiltinESMExports).toHaveBeenCalledTimes(2);
});

it('observes only existing filesystem calls without per-poll clocks, additional probes or authority interpretation', () => {
  const f = fixture();
  try {
    expect(f.fs.existsSync('private-state.lock/1.done')).toBe(false);
    const stat = f.fs.statSync('private-state.lock.process-456.identity');
    expect(stat).toEqual({ marker: true });
    expect(f.fs.readFileSync('private-state.lock.process-456.identity', 'utf8')).toBe('private-provider-output');
    const missing = Object.assign(new Error('private-path'), { code: 'ENOENT' });
    f.originals.rmSync.mockImplementationOnce(() => { throw missing; });
    expect(() => f.fs.rmSync('private-state.lock/.123.id.slot.tmp.publish', { recursive: true })).toThrow(missing);
    expect(f.observation.snapshot()).toMatchObject({ lastDone: false, lastMarker: 'read-ok', allocationFinallyLastAttempt: 'missing' });
    for (const method of Object.values(f.originals).slice(0, 4)) expect(method).toHaveBeenCalledTimes(1);
    expect(f.clock).not.toHaveBeenCalled();
    expect(JSON.stringify(f.observation.snapshot())).not.toContain('private-');
  } finally { f.observation.restore(); }
});

it('strictly decodes bounded safe fields and never overwrites a later method owner', () => {
  const f = fixture();
  const snapshot = f.observation.snapshot();
  const decoded = decodeLiveOwnerLockProbe({ ...snapshot, args: ['private-secret'], providers: { ...snapshot.providers, private: { output: 'secret' } } });
  expect(decoded).not.toBeNull(); expect(JSON.stringify(decoded)).not.toContain('private');
  expect(decodeLiveOwnerLockProbe({ ...snapshot, lastMarker: 'raw-path' })).toBeNull();
  expect(decodeLiveOwnerLockProbe({ ...snapshot, providers: { ...snapshot.providers, wmic: { ...snapshot.providers.wmic, count: Infinity } } })).toBeNull();
  const later = jest.fn(() => true); f.fs.existsSync = later;
  f.observation.restore();
  expect(f.fs.existsSync).toBe(later); expect(f.observation.snapshot().unavailable).toBe(true);
});

it('binds and restores the actual Node named export in an isolated child without executing a provider', () => {
  const helper = new URL('./fixtures/liveOwnerLockProbe.js', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import cp, { execFileSync } from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { observeLiveOwnerLockCalls } from ${JSON.stringify(helper)};
    const original = cp.execFileSync;
    const sentinel = {}; const args = []; const options = {}; const receiver = {};
    let delegated = false;
    const stub = function(command, actualArgs, actualOptions) {
      delegated = this === receiver && command === 'wmic.exe' && actualArgs === args && actualOptions === options;
      return sentinel;
    };
    cp.execFileSync = stub;
    let tick = 0;
    const probe = observeLiveOwnerLockCalls({ fs, childProcess: cp, syncBuiltinESMExports, stateFile: 'isolated', pid: process.pid, clock: () => ++tick, started: 0 });
    try {
      const sameResult = Reflect.apply(execFileSync, receiver, ['wmic.exe', args, options]) === sentinel;
      probe.restore();
      console.log(JSON.stringify({ delegated, sameResult, count: probe.snapshot().providers.wmic.count, restored: execFileSync === stub }));
    } finally { probe.restore(); cp.execFileSync = original; syncBuiltinESMExports(); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ delegated: true, sameResult: true, count: 1, restored: true });
});
