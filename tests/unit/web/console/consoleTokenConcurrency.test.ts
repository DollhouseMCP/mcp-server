import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Secret, TOTP } from 'otpauth';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import {
  ConsoleTokenStore, readTokenFileRaw, type DialogApprovalRequest, type DialogApprovalResult,
} from '../../../../src/web/console/consoleToken.js';
import { ApprovalService } from '../../../../src/web-console/modules/approvals/ApprovalService.js';
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

function pendingApproval(): DialogApprovalRequest {
  return {
    requestId: randomUUID(), sessionId: 'local-session',
    operationDigest: 'fixture-operation-digest', expiresAt: Date.now() + 60_000,
  };
}

it('creates one normal basic-tier file when two stdio startups race', async () => {
  const homes = await Promise.all(['boot-first-', 'boot-second-'].map(prefix => mkdtemp(path.join(directory, prefix))));
  const controller = new AbortController();
  const children = homes.map(home => writer('bootstrap-stdio', home, controller.signal));
  const completed = Promise.allSettled(children);
  try {
    await Promise.all(homes.map(home => waitForFile(path.join(home, 'ready'), 10000)));
    children.forEach(child => child.child.stdin?.end());
    const outcomes = (await completed).map(result => {
      if (result.status === 'rejected') throw result.reason;
      return JSON.parse(result.value.stdout) as { created: boolean };
    });
    expect(outcomes.filter(result => result.created)).toHaveLength(1);
    expect(await new ConsoleTokenStore(tokenFile).lookupApprovalEnrollment()).toBe('unenrolled');
    expect(await readdir(directory)).toEqual(expect.arrayContaining([path.basename(tokenFile)]));
    expect(await readdir(directory)).not.toContain(`${path.basename(tokenFile)}.approval-state`);
    if (process.platform !== 'win32') expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  } finally {
    controller.abort();
    await completed;
  }
}, 25000);

async function proveInTwoProcesses(
  batches: readonly [DialogApprovalRequest[], DialogApprovalRequest[]], code: string,
): Promise<DialogApprovalResult[]> {
  const homes = await Promise.all(['first-', 'second-'].map(prefix => mkdtemp(path.join(directory, prefix))));
  const controller = new AbortController();
  const children = homes.map(home => writer('dialog-approval', home, controller.signal));
  const completed = Promise.allSettled(children);
  try {
    await Promise.all(homes.map(home => waitForFile(path.join(home, 'ready'), 10000)));
    children.forEach((child, index) => child.child.stdin?.end(JSON.stringify({ requests: batches[index], code })));
    return (await completed).flatMap(result => {
      if (result.status === 'rejected') throw result.reason;
      return JSON.parse(result.value.stdout) as DialogApprovalResult[];
    });
  } finally {
    controller.abort();
    await completed;
  }
}

it('spends one approval across two processes without putting the code in the stored record', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Parent');
  const enrollment = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  const pending = pendingApproval();
  const code = enrollmentCode(enrollment.secret);
  const childHome = await mkdtemp(path.join(directory, 'abandoned-'));
  await writer('abandon-lock', childHome);
  const results = await proveInTwoProcesses([[pending], [pending]], code);
  expect(results.toSorted()).toEqual(['approved', 'spent']);

  const statePath = `${tokenFile}.approval-state`;
  const state = JSON.parse(await readFile(statePath, 'utf8')) as { attempts: number[]; spent: Record<string, number> };
  expect(state).toEqual({
    attempts: [expect.any(Number)],
    spent: { [Object.keys(state.spent)[0]]: pending.expiresAt },
  });
  expect(Object.keys(state.spent)[0]).toMatch(/^[0-9a-f]{64}$/);
  expect(state).not.toHaveProperty('code');
  if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600);
}, 25000);

it('shares the rate limit across processes and pending requests', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Parent');
  const enrollment = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  const batches = [Array.from({ length: 5 }, pendingApproval), Array.from({ length: 6 }, pendingApproval)] as const;
  const results = await proveInTwoProcesses(batches, 'invalid');
  expect(results.filter(result => result === 'refused')).toHaveLength(10);
  expect(results.filter(result => result === 'rate_limited')).toHaveLength(1);
  await expect(store.confirmApprovalFromDialog(pendingApproval(), async () => ({
    confirmed: true, code: enrollmentCode(enrollment.secret),
  }))).resolves.toBe('rate_limited');
}, 25000);

it('passes only request metadata to persistence after dialog proof when the console is disabled', async () => {
  const provisioner = new ConsoleTokenStore(tokenFile);
  await provisioner.ensureInitialized('Parent');
  const enrollment = provisioner.beginTotpEnrollment();
  const { backupCodes } = await provisioner.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  const store = new ConsoleTokenStore(tokenFile);
  const request = pendingApproval();
  const requestWithUnexpectedField = { ...request, code: backupCodes[0] };
  const persistedPath = path.join(directory, 'action.json');
  await expect(ApprovalService.approveFromDialog({
    request: requestWithUnexpectedField,
    tokenStore: store,
    dialog: async shown => {
      expect(shown).toEqual(request);
      return { confirmed: true, code: backupCodes[0] };
    },
    commit: async approved => {
      await writeFile(persistedPath, JSON.stringify(approved));
      return true;
    },
  })).resolves.toBe('approved');
  const persisted = await readFile(persistedPath, 'utf8');
  expect(JSON.parse(persisted)).toEqual(request);
  expect(persisted).not.toContain(backupCodes[0]);
  expect(await provisioner.verifyTotp(backupCodes[0])).toEqual({ ok: false });
});

it('requires explicit confirmation and keeps missing, unenrolled, and enrolled state distinct', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  const dialog = jest.fn(async () => ({ confirmed: false } as const));
  await expect(store.lookupApprovalEnrollment()).resolves.toBe('unknown');
  await expect(store.confirmApprovalFromDialog(pendingApproval(), dialog)).resolves.toBe('unavailable');
  expect(dialog).not.toHaveBeenCalled();

  await store.ensureInitialized('Parent');
  await expect(store.lookupApprovalEnrollment()).resolves.toBe('unenrolled');
  await expect(store.confirmApprovalFromDialog(pendingApproval(), dialog)).resolves.toBe('refused');
  const basicRequest = pendingApproval();
  await expect(new ConsoleTokenStore(tokenFile).confirmApprovalFromDialog(basicRequest, async () => ({
    confirmed: true,
  }))).resolves.toBe('approved');
  await expect(store.confirmApprovalFromDialog(basicRequest, async () => ({ confirmed: true }))).resolves.toBe('spent');
  const enrollment = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
  await expect(new ConsoleTokenStore(tokenFile).lookupApprovalEnrollment()).resolves.toBe('enrolled');
  await writeFile(tokenFile, '{');
  await expect(store.lookupApprovalEnrollment()).resolves.toBe('unknown');
});

it('refuses stale enrollment and unreadable or missing initialized approval state', async () => {
  const store = new ConsoleTokenStore(tokenFile);
  await store.ensureInitialized('Parent');
  const enrollment = store.beginTotpEnrollment();
  await expect(store.confirmApprovalFromDialog(pendingApproval(), async () => {
    await store.confirmTotpEnrollment(enrollment.pendingId, enrollmentCode(enrollment.secret));
    return { confirmed: true };
  })).resolves.toBe('unavailable');

  const request = pendingApproval();
  const dialog = async () => ({ confirmed: true, code: enrollmentCode(enrollment.secret) } as const);
  await expect(store.confirmApprovalFromDialog(request, dialog)).resolves.toBe('approved');
  const statePath = `${tokenFile}.approval-state`;
  await writeFile(statePath, '{');
  await expect(store.confirmApprovalFromDialog(pendingApproval(), dialog)).resolves.toBe('unavailable');
  expect(await readFile(statePath, 'utf8')).toBe('{');
  await rm(statePath);
  await expect(new ConsoleTokenStore(tokenFile).confirmApprovalFromDialog(request, dialog)).resolves.toBe('unavailable');
});

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
