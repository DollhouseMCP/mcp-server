/**
 * Tests for stale process detection and recovery (#1850).
 */

import { describe, it, expect } from '@jest/globals';
import * as net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';

const execAsync = promisify(execFile);

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

describe('Stale Process Recovery (#1850)', () => {
  it('validates all safety guards and platform compatibility', async () => {
    const { findPidOnPort, killStaleProcess, recoverStalePort } =
      await import('../../../../src/web/console/StaleProcessRecovery.js');

    // --- exports ---
    expect(typeof findPidOnPort).toBe('function');
    expect(typeof killStaleProcess).toBe('function');
    expect(typeof recoverStalePort).toBe('function');

    // --- findPidOnPort: free port returns null ---
    const port1 = await getFreePort();
    expect(await findPidOnPort(port1)).toBeNull();

    // --- killStaleProcess: non-existent PID returns false ---
    expect(await killStaleProcess(99999999, 41715)).toBe(false);

    // --- killStaleProcess: current process rejected (not a .bin/mcp-server binary) ---
    expect(await killStaleProcess(process.pid, 41715)).toBe(false);

    // --- recoverStalePort: free port returns false ---
    const port2 = await getFreePort();
    expect(await recoverStalePort(port2)).toBe(false);

    // --- platform: ps supports user= and command= ---
    const { stdout } = await execAsync('ps', ['-p', String(process.pid), '-o', 'user=,command='], { timeout: 1000 });
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toContain(userInfo().username);
  }, 15000);
});
