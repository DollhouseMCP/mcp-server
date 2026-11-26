import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Secret, TOTP } from 'otpauth';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { ConsoleTokenStore, readTokenFileRaw } from '../../../../src/web/console/consoleToken.js';
import { waitForFile } from '../../../helpers/file-utils.js';
import { isolatedServerEnv } from '../../../helpers/isolated-server-env.cjs';

const runFile = promisify(execFile);
let directory: string;
let tokenFile: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(homedir(), 'console-token-race-'));
  tokenFile = path.join(directory, 'console-token.auth.json');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function writer(operation: string, home: string, signal?: AbortSignal) {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const entry = fileURLToPath(new URL(`../../../fixtures/security/console-token-writer${extension}`, import.meta.url));
  const loader = extension === '.ts' ? ['--import', 'tsx'] : [];
  return runFile(process.execPath, [...loader, entry, operation, tokenFile], {
    env: isolatedServerEnv(home, { ...process.env, DOLLHOUSE_PORTFOLIO_DIR: path.join(home, 'portfolio') }),
    signal,
    timeout: 20000,
  });
}

function enrollmentCode(secret: string): string {
  return new TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret),
  }).generate();
}

it('spends a backup code once when two processes race from the same snapshot', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Parent');
  const enrollment = store.beginTotpEnrollment();
  const { backupCodes } = await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  const initial = await readTokenFileRaw(tokenFile);
  expect(initial?.totp.backupCodes).toHaveLength(10);
  const homes = await Promise.all(['first-', 'second-'].map(prefix => mkdtemp(path.join(directory, prefix))));
  const controller = new AbortController();
  const children = homes.map(home => writer('verify-backup', home, controller.signal));
  const completed = Promise.allSettled(children);
  try {
    await Promise.all(homes.map(home => waitForFile(path.join(home, 'ready'), 10000)));
    children.forEach(child => child.child.stdin?.end(backupCodes[0]));
    const responses = (await completed).map(result => {
      if (result.status === 'rejected') throw result.reason;
      return JSON.parse(result.value.stdout) as { ok: boolean };
    });
    expect(responses.filter(result => result.ok)).toHaveLength(1);
    expect(responses.filter(result => !result.ok)).toHaveLength(1);
    const durable = await readTokenFileRaw(tokenFile);
    expect(durable?.totp.backupCodes).toEqual(initial?.totp.backupCodes.slice(1));
    expect(durable?.totp.backupCodes).not.toContain(backupCodes[0]);
  } finally {
    controller.abort();
    await completed;
  }
}, 25000);

it('keeps the first committed enrollment when another store has a pending enrollment', async () => {
  const first = new ConsoleTokenStore(tokenFile);
  const second = new ConsoleTokenStore(tokenFile);
  await Promise.all([first.ensureInitialized('First'), second.ensureInitialized('Second')]);
  const winner = first.beginTotpEnrollment();
  const stale = second.beginTotpEnrollment();
  await first.confirmTotpEnrollment(winner.pendingId, enrollmentCode(winner.secret));
  await expect(second.confirmTotpEnrollment(stale.pendingId, enrollmentCode(stale.secret)))
    .rejects.toMatchObject({ code: 'ALREADY_ENROLLED' });

  const durable = await readTokenFileRaw(tokenFile);
  expect(durable?.totp.secret).toBe(winner.secret);
});

it('rotates from current state and preserves backup-code consumption by another store', async () => {
  const first = new ConsoleTokenStore(tokenFile);
  await first.ensureInitialized('First');
  const enrollment = first.beginTotpEnrollment();
  const { backupCodes } = await first.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  const initial = await readTokenFileRaw(tokenFile);
  const second = new ConsoleTokenStore(tokenFile);
  await second.ensureInitialized('Second');

  await expect(first.verifyTotp(backupCodes[0])).resolves.toMatchObject({ ok: true, method: 'backup' });
  const rotation = await second.rotatePrimary(backupCodes[1]);

  const durable = await readTokenFileRaw(tokenFile);
  expect(durable?.tokens[0].token).toBe(rotation.token);
  expect(durable?.totp.backupCodes).toEqual(initial?.totp.backupCodes.slice(2));
});

it('refuses proof against a cached enrollment when the token file becomes unreadable', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('First');
  const enrollment = store.beginTotpEnrollment();
  const { backupCodes } = await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  await writeFile(tokenFile, '{');

  await expect(store.verifyTotp(backupCodes[0])).rejects.toMatchObject({ code: 'STORE_NOT_INITIALIZED' });
  expect(await readTokenFileRaw(tokenFile)).toBeNull();
});

it('initializes the token file after a lock holder exits before cleanup', async () => {
  const childHome = await mkdtemp(path.join(directory, 'child-'));
  await writer('abandon-lock', childHome);
  expect(await readdir(`${tokenFile}.lock`)).toHaveLength(1);

  const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  const store = new ConsoleTokenStore(tokenFile);
  const entry = await store.ensureInitialized('Replacement');
  expect((await readTokenFileRaw(tokenFile))?.tokens[0].id).toBe(entry.id);
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({
    source: 'RecoverableFileWriteLock', severity: 'HIGH',
  }));
}, 25000);
