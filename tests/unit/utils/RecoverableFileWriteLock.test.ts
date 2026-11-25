import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { withRecoverableFileWriteLock } from '../../../src/utils/RecoverableFileWriteLock.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';

let directory: string;
let lockPath: string;
const runFile = promisify(execFile);

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(homedir(), 'write-lock-'));
  lockPath = path.join(directory, 'blocked-agents.json.lock');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('reclaims an exited writer and keeps two reclaimers mutually exclusive', async () => {
  const childHome = await fs.mkdtemp(path.join(directory, 'child-home-'));
  const extension = path.extname(fileURLToPath(import.meta.url));
  const module = new URL(`../../../src/utils/RecoverableFileWriteLock${extension}`, import.meta.url);
  const loader = extension === '.ts' ? ['--import', 'tsx'] : [];
  const script = `
    import { withRecoverableFileWriteLock } from ${JSON.stringify(module.href)};
    await withRecoverableFileWriteLock(process.argv[1], async () => process.exit(0));
  `;
  await runFile(process.execPath, [...loader, '--input-type=module', '--eval', script, lockPath], {
    env: isolatedServerEnv(childHome, { ...process.env, DOLLHOUSE_PORTFOLIO_DIR: path.join(childHome, 'portfolio') }),
    timeout: 10000,
  });
  expect(await fs.readdir(lockPath)).toHaveLength(1);

  const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  let active = 0;
  const write = async () => {
    expect(active).toBe(0);
    active++;
    try {
      await delay(125);
    } finally {
      active--;
    }
  };
  await Promise.all([
    withRecoverableFileWriteLock(lockPath, write, 5000),
    withRecoverableFileWriteLock(lockPath, write, 5000),
  ]);

  expect(audit).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'HIGH',
    source: 'RecoverableFileWriteLock',
    details: 'Reclaimed the file write lock of a dead local process',
    additionalData: { pid: expect.any(Number) },
  }));
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15000);

it('takes over an empty directory left by an interrupted cleanup', async () => {
  await fs.mkdir(lockPath);
  await expect(withRecoverableFileWriteLock(lockPath, async () => fs.readdir(lockPath), 5000))
    .resolves.toHaveLength(1);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('times out without stealing a live owner’s lock', async () => {
  const entered = latch();
  const finish = latch();
  const holder = withRecoverableFileWriteLock(lockPath, async () => {
    entered.resolve();
    await finish.promise;
  });
  const contender = jest.fn(async () => undefined);
  const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  try {
    await Promise.race([entered.promise, holder]);
    const markers = await fs.readdir(lockPath);
    expect(markers).toHaveLength(1);
    await fs.utimes(path.join(lockPath, markers[0]), new Date(0), new Date(0));
    await expect(withRecoverableFileWriteLock(lockPath, contender, 60)).rejects.toThrow('Timed out');
    expect(contender).not.toHaveBeenCalled();
    expect(await fs.readdir(lockPath)).toEqual(markers);
    expect(audit).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await holder;
  }
});
