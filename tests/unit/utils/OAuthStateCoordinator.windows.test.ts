import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

let now = 0;
const execFileSync = jest.fn<(command: string, args: string[], options: { timeout: number }) => string>();
jest.unstable_mockModule('node:child_process', () => ({ execFileSync }));
jest.unstable_mockModule('node:os', () => ({ ...os, uptime: () => now / 1_000 }));
const { withOAuthStateLockSync } = await import('../../../oauth-state-coordinator.mjs');

describe('OAuth state lock Windows probe budget', () => {
  let directory: string;
  let stateFile: string;
  let ownerDone: string;
  let entered: boolean;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalSystemRoot = process.env.SystemRoot;

  beforeEach(() => {
    now = 0;
    entered = false;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-windows-probe-'));
    stateFile = path.join(directory, 'state.json');
    ownerDone = `${stateFile}.lock/1.done`;
    fs.mkdirSync(`${stateFile}.lock`);
    const ownerPid = process.pid + 1_000_000;
    const ownerIdentity = 'win32:10000';
    fs.writeFileSync(`${stateFile}.lock/1.slot`, JSON.stringify({ id: 'live-owner', ownerPid, ownerIdentity }));
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(`${stateFile}.lock/1.slot`, staleTime, staleTime);
    fs.writeFileSync(`${stateFile}.lock.process-${ownerPid}.identity`,
      JSON.stringify({ identity: ownerIdentity, writtenAt: staleTime.getTime() }));

    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    process.env.SystemRoot = String.raw`C:\Windows`;
    jest.spyOn(process, 'kill').mockReturnValue(true);
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    jest.spyOn(Atomics, 'wait').mockImplementation((_signal, _index, _value, timeout) => {
      now += timeout ?? 0;
      return 'timed-out';
    });
    execFileSync.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function slowProbes(releaseOwner: boolean) {
    execFileSync.mockImplementation((command, _args, { timeout }) => {
      expect(timeout).toBeGreaterThan(0);
      expect(entered).toBe(false);
      expect(fs.existsSync(ownerDone)).toBe(false);
      if (command.endsWith('WMIC.exe')) {
        now += Math.min(164, timeout);
        throw Object.assign(new Error('WMIC absent'), { code: 'ENOENT' });
      }
      if (command.endsWith('pwsh.exe')) {
        now += Math.min(783, timeout);
        throw new Error('pwsh failed');
      }
      expect(command).toMatch(/\\powershell\.exe$/);
      // The owner releases while the contender is blocked in the last probe.
      if (releaseOwner) fs.writeFileSync(ownerDone, '');
      now += timeout;
      throw Object.assign(new Error('powershell timed out'), { code: 'ETIMEDOUT' });
    });
  }

  it('observes release after slow failed probes within the original five-second deadline', () => {
    slowProbes(true);

    withOAuthStateLockSync(stateFile, () => {
      expect(fs.existsSync(ownerDone)).toBe(true);
      entered = true;
    });

    expect(entered).toBe(true);
    expect(execFileSync.mock.calls.map(([command]) => path.win32.basename(command)))
      .toEqual(['WMIC.exe', 'pwsh.exe', 'powershell.exe']);
    expect(execFileSync.mock.calls[2][2].timeout).toBe(1_553);
    expect(now).toBe(2_510); // 2.5 s total probe budget + one 10 ms retry.
    expect(now).toBeLessThan(5_000);
    expect(fs.existsSync(`${stateFile}.lock/2.done`)).toBe(true);
  });

  it('keeps a live owner with unavailable identity and expires without extending the deadline', () => {
    slowProbes(false);

    expect(() => withOAuthStateLockSync(stateFile, () => { entered = true; }))
      .toThrow('Timed out waiting for OAuth state lock');

    expect(entered).toBe(false);
    expect(now).toBeGreaterThanOrEqual(5_000);
    expect(now).toBeLessThanOrEqual(5_001);
    expect(fs.existsSync(ownerDone)).toBe(false);
    expect(fs.existsSync(`${stateFile}.lock/1.slot`)).toBe(true);
    expect(fs.existsSync(`${stateFile}.lock/2.done`)).toBe(true);
    expect(fs.existsSync(`${stateFile}.lock.process-${process.pid}.identity`)).toBe(false);
  });
});
