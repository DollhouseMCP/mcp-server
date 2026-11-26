import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Secret, TOTP } from 'otpauth';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { MAX_BLOCK_SNAPSHOT_BYTES } from '../../../src/state/readDangerZoneBlockSnapshot.js';
import { logger } from '../../../src/utils/logger.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';
import { ConsoleTokenStore, type ApprovalDialog } from '../../../src/web/console/consoleToken.js';
import { ApprovalService } from '../../../src/web-console/modules/approvals/ApprovalService.js';

const snapshot = (blocks: Record<string, unknown>) => JSON.stringify({ version: 1, blocks });
const block = { reason: 'Requires review', blockedAt: new Date(0).toISOString() };
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const rejected = Buffer.from([0x7b, 0xff, 0x0a]);
const denied = { blocked: true, reason: 'Blocked-agent state is unavailable.' };
const runFile = promisify(execFile);
let directory: string;
let fileOps: FileOperationsService;
let store: FileDangerZoneBlockStore;
let enforcer: DangerZoneEnforcer;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(homedir(), 'block-recovery-'));
  fileOps = new FileOperationsService(new FileLockManager());
  store = new FileDangerZoneBlockStore(fileOps, directory);
  enforcer = new DangerZoneEnforcer(store);
});

afterEach(async () => {
  await enforcer.shutdown();
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function replace(content: string) {
  const staging = path.join(directory, 'replacement');
  await fs.writeFile(staging, content);
  await fs.rename(staging, store.location);
}

function requestLocalReset(tokenStore: ConsoleTokenStore, dialog: ApprovalDialog) {
  return enforcer.requestLocalReset('stdio-session', (request, commit) =>
    ApprovalService.approveFromDialog({ request, commit, tokenStore, dialog }));
}

function requestLocalRelease(tokenStore: ConsoleTokenStore, dialog: ApprovalDialog, session = 'stdio-session') {
  return enforcer.requestLocalRelease('block-challenge', session, (_agentName, request, commit) =>
    ApprovalService.approveFromDialog({ request, commit, tokenStore, dialog }));
}

it('keeps the block until the owning session supplies authenticator proof in the dialog', async () => {
  const tokenStore = new ConsoleTokenStore(path.join(directory, 'console-token'));
  await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
  const pending = tokenStore.beginTotpEnrollment();
  const authenticator = new TOTP({ secret: Secret.fromBase32(pending.secret), algorithm: 'SHA1', digits: 6, period: 30 });
  await tokenStore.confirmTotpEnrollment(pending.pendingId, authenticator.generate());
  await enforcer.initialize();
  expect(await enforcer.block('agent', 'Review required', [], 'block-challenge', undefined, 'stdio-session')).toBe(true);

  const foreignDialog = jest.fn<ApprovalDialog>();
  await expect(requestLocalRelease(tokenStore, foreignDialog, 'different-session')).resolves.toEqual({ status: 'session' });
  expect(foreignDialog).not.toHaveBeenCalled();
  await expect(requestLocalRelease(tokenStore, async () => ({ confirmed: true }))).resolves.toEqual({ status: 'refused' });
  expect((await enforcer.check('agent')).blocked).toBe(true);
  await expect(requestLocalRelease(tokenStore, async (_request, enrollment) => {
    expect(enrollment).toBe('enrolled');
    return { confirmed: true, code: authenticator.generate() };
  })).resolves.toEqual({ status: 'approved', agentName: 'agent' });
  expect(await enforcer.check('agent')).toEqual({ blocked: false });
});

it('keeps a replacement block when approval is for the previous event', async () => {
  const tokenStore = new ConsoleTokenStore(path.join(directory, 'console-token'));
  await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
  await enforcer.initialize();
  await enforcer.block('agent', 'First block', [], 'block-challenge', undefined, 'stdio-session');
  await expect(requestLocalRelease(tokenStore, async () => {
    await enforcer.block('agent', 'Replacement block', [], 'block-challenge', undefined, 'stdio-session');
    return { confirmed: true };
  })).resolves.toEqual({ status: 'changed' });
  expect(await enforcer.check('agent')).toMatchObject({ blocked: true, reason: 'Replacement block' });
});

it.each(['malformed', 'oversized'] as const)('resets the %s snapshot after basic approval and atomically retains queued blocks', async kind => {
  const tokenStore = new ConsoleTokenStore(path.join(directory, 'console-token'));
  await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
  const bytes = kind === 'oversized' ? Buffer.alloc(MAX_BLOCK_SNAPSHOT_BYTES + 1, 0x20) : rejected;
  if (kind === 'oversized') bytes.write(snapshot({}));
  const warnings = jest.spyOn(logger, 'warn');
  await fs.writeFile(store.location, bytes);
  await enforcer.initialize();
  if (kind === 'oversized') {
    expect(warnings).toHaveBeenCalledWith('Rejected blocked-agent snapshot', { reason: 'Block snapshot exceeds size limit' });
  }
  expect(await enforcer.block('pending-agent', 'Queued before approval', [], 'before')).toBe(false);
  expect(await enforcer.check('unlisted', true)).toMatchObject({
    blocked: true, reason: expect.stringContaining(store.location),
    resolution: expect.stringContaining('request_blocked_agent_reset'),
  });
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
  await expect(requestLocalReset(tokenStore, async (request, enrollment) => {
    expect(request.operationDigest).toBe(digest(bytes));
    expect(enrollment).toBe('unenrolled');
    expect(await enforcer.block('later-agent', 'Queued while the dialog was open', [], 'later')).toBe(false);
    return { confirmed: true };
  })).resolves.toBe('approved');

  const newSnapshot = JSON.parse(await fs.readFile(store.location, 'utf8'));
  expect(Object.keys(newSnapshot.blocks).sort()).toEqual(['later-agent', 'pending-agent']);
  const backups = (await fs.readdir(directory)).filter(name => name.endsWith('.backup'));
  expect(backups).toHaveLength(1);
  expect((await fs.readFile(path.join(directory, backups[0]))).equals(bytes)).toBe(true);
  expect(await enforcer.check('unlisted')).toEqual({ blocked: false });

  const peer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(fileOps, directory));
  try {
    expect(await peer.check('pending-agent')).toMatchObject({ blocked: true, verificationId: 'before' });
    expect(await peer.check('later-agent')).toMatchObject({ blocked: true, verificationId: 'later' });
  } finally {
    await peer.shutdown();
  }
});

it('refuses to replace a snapshot if the copied evidence does not match the approved digest', async () => {
  const tokenStore = new ConsoleTokenStore(path.join(directory, 'console-token'));
  await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
  const oversized = Buffer.alloc(MAX_BLOCK_SNAPSHOT_BYTES + 1, 0x20);
  await fs.writeFile(store.location, oversized);
  await enforcer.initialize();
  jest.spyOn(fileOps, 'copyFile').mockImplementationOnce(async (_source, destination) => {
    await fs.writeFile(destination, 'incomplete evidence');
  });

  await expect(requestLocalReset(tokenStore, async () => ({ confirmed: true }))).resolves.toBe('changed');
  expect((await fs.readFile(store.location)).equals(oversized)).toBe(true);
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
});

it('refuses cancellation, concurrent prompts, and replacement before the approved reset', async () => {
  const tokenStore = new ConsoleTokenStore(path.join(directory, 'console-token'));
  await tokenStore.ensureInitialized('Stdio', { onlyIfBothAbsent: true });
  interceptWatcher();
  await fs.writeFile(store.location, rejected);
  await enforcer.initialize();
  await expect(requestLocalReset(tokenStore, async () => ({ confirmed: false }))).resolves.toBe('refused');
  expect(await fs.readFile(store.location)).toEqual(rejected);

  const changed = '{"version":2,"blocks":{}}';
  const duplicate = jest.fn(async () => ({ confirmed: true } as const));
  await expect(requestLocalReset(tokenStore, async () => {
    await expect(requestLocalReset(tokenStore, duplicate)).resolves.toBe('busy');
    await replace(changed);
    return { confirmed: true };
  })).resolves.toBe('changed');
  expect(duplicate).not.toHaveBeenCalled();
  expect(await fs.readFile(store.location, 'utf8')).toBe(changed);
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
});

function interceptWatcher() {
  let retry!: () => Promise<void>;
  const stop = jest.fn();
  jest.spyOn(store, 'watchForRecovery').mockImplementation(callback => {
    retry = callback;
    return stop;
  });
  return { retry: () => retry(), stop };
}

it('keeps every agent refused after a file replacement races a read', async () => {
  const watcher = interceptWatcher();
  const warnings = jest.spyOn(logger, 'warn');
  await fs.writeFile(store.location, rejected);
  await enforcer.initialize();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);

  await replace(snapshot({}));
  const read = fileOps.readFile.bind(fileOps);
  jest.spyOn(fileOps, 'readFile').mockImplementationOnce(async (...args) => {
    const bytes = await read(...args);
    await replace('{"version":1,"blocks":');
    return bytes;
  });
  await watcher.retry();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
  expect(await enforcer.check('another')).toMatchObject(denied);
  expect(watcher.stop).not.toHaveBeenCalled();
  expect(warnings).toHaveBeenCalledWith('Rejected blocked-agent snapshot', { reason: 'Blocked-agent file changed or the read was incomplete' });
});

it('rejects a syntactically valid short read and stays closed until the full snapshot loads', async () => {
  const watcher = interceptWatcher();
  await fs.writeFile(store.location, rejected);
  await enforcer.initialize();
  const repaired = snapshot({ stored: block });
  await replace(repaired);
  jest.spyOn(fileOps, 'readFile').mockResolvedValueOnce(snapshot({}));
  await watcher.retry();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
  expect(await enforcer.check('stored')).toMatchObject(denied);

  await watcher.retry();
  expect(await enforcer.check('stored')).toMatchObject({ blocked: true, reason: block.reason });
  expect(await enforcer.check('unlisted')).toEqual({ blocked: false });
  expect(watcher.stop).toHaveBeenCalledTimes(1);
});

it.each([
  ['unsupported version', '{"version":2,"blocks":{"evidence-only-agent":null}}'],
  ['contains invalid characters', '{"version":1,"blocks":{"evidence-only-agent":null,"bad/key":null}}'],
  ['Duplicate persisted agent name', '{"version":1,"blocks":{"evidence-only-agent":null,"agent":null," agent ":null}}'],
])('records the rejection reason and recovers from %s without discarding evidence', async (reason, content) => {
  const watcher = interceptWatcher();
  const warnings = jest.spyOn(logger, 'warn');
  const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  await fs.writeFile(store.location, content);
  await enforcer.initialize();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
  expect(warnings).toHaveBeenCalledWith('Rejected blocked-agent snapshot', { reason: expect.stringContaining(reason) });
  expect(JSON.stringify(warnings.mock.calls)).not.toContain('evidence-only-agent');

  const evidenceFiles = (await fs.readdir(directory)).filter(name => name.endsWith('.backup'));
  expect(evidenceFiles).toHaveLength(1);
  const evidence = path.join(directory, evidenceFiles[0]);
  expect(await fs.readFile(evidence, 'utf8')).toBe(content);
  if (process.platform !== 'win32') expect((await fs.stat(evidence)).mode & 0o777).toBe(0o600);

  await fs.unlink(store.location);
  await watcher.retry();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);

  const repaired = snapshot({ stored: block });
  await replace(repaired);
  await watcher.retry();
  expect(await enforcer.check('unlisted')).toEqual({ blocked: false });
  expect(await enforcer.check('stored')).toMatchObject({ blocked: true, reason: block.reason });
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({
    severity: 'HIGH',
    details: 'Externally repaired blocked-agent state loaded',
    additionalData: { previousDigest: digest(content), currentDigest: digest(repaired) },
  }));
});

it('preserves the exact malformed bytes before recovery', async () => {
  const warnings = jest.spyOn(logger, 'warn');
  await fs.writeFile(store.location, rejected);
  await enforcer.initialize();
  expect(await enforcer.check('unlisted')).toMatchObject(denied);
  expect(warnings).toHaveBeenCalledWith('Rejected blocked-agent snapshot', { reason: 'malformed JSON' });
  const evidence = (await fs.readdir(directory)).find(name => name.endsWith('.backup'));
  expect(evidence).toBeDefined();
  expect(await fs.readFile(path.join(directory, evidence!))).toEqual(rejected);
});

it.each([
  { first: 'a', second: 'b' },
  { first: 'b', second: 'a' },
])('chooses the same block when $first is replayed before $second', async ({ first, second }) => {
  await replace(snapshot({ stored: block }));
  const replay = (eventId: string) => store.apply({
    kind: 'put', name: 'shared', block: { ...block, eventId }, replay: true,
  });
  await replay(first);
  await replay(second);

  const writes = jest.spyOn(fileOps, 'writeFile');
  const expected = { stored: block, shared: { ...block, eventId: 'b' } };
  await expect(replay('b')).resolves.toEqual({ snapshot: expected });
  expect(writes).not.toHaveBeenCalled();
  expect(await store.load()).toEqual({ status: 'loaded', value: expected });
});

it('uses the recovery tie-break for a block admitted during the repair read', async () => {
  const watcher = interceptWatcher();
  const timestamp = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(timestamp);
  await fs.writeFile(store.location, rejected);
  await enforcer.initialize();
  expect(await enforcer.block('queued', 'Queued review', [])).toBe(false);
  // A valid legacy block with no event ID uses its verification ID for comparison.
  const repaired = { ...block, blockedAt: new Date(timestamp).toISOString(), verificationId: 'z-existing' };
  await replace(snapshot({ shared: repaired }));
  const read = fileOps.readFile.bind(fileOps);
  let pending: Promise<boolean> | undefined;
  jest.spyOn(fileOps, 'readFile').mockImplementationOnce(async (...args) => {
    const bytes = await read(...args);
    pending = enforcer.block('shared', 'Concurrent review', []);
    return bytes;
  });

  await watcher.retry();
  expect(pending).toBeDefined();
  await expect(pending).resolves.toBe(false);
  expect(await enforcer.check('shared')).toMatchObject({ blocked: true, eventId: 'z-existing' });
  expect(await enforcer.check('queued')).toMatchObject({ blocked: true, reason: 'Queued review' });
});

async function waitForMarkers(homes: string[]) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if ((await Promise.all(homes.map(home => fs.access(path.join(home, 'ready')).then(() => true, () => false)))).every(Boolean)) return;
    await delay(20);
  }
  throw new Error('Both recovery processes must start before the file changes');
}

it('automatically recovers two processes after an atomic rename and preserves both queues', async () => {
  await fs.writeFile(store.location, rejected);
  const homes = await Promise.all(['first-', 'second-'].map(prefix => fs.mkdtemp(path.join(directory, prefix))));
  const abort = new AbortController();
  const extension = path.extname(fileURLToPath(import.meta.url));
  const entry = fileURLToPath(new URL(`../../fixtures/security/block-recovery-worker${extension}`, import.meta.url));
  const execArgs = extension === '.ts' ? ['--import', 'tsx', entry] : [entry];
  const workers = Promise.allSettled(homes.map((home, index) =>
    runFile(process.execPath, [...execArgs, directory, String(index)],
      { env: isolatedServerEnv(home, { ...process.env, DOLLHOUSE_PORTFOLIO_DIR: path.join(home, 'portfolio') }),
        signal: abort.signal, timeout: 20000 })));
  try {
    await waitForMarkers(homes);
    await replace(snapshot({ stored: block }));
    const results = await workers;
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const blocks = JSON.parse(await fs.readFile(store.location, 'utf8')).blocks;
    expect(Object.keys(blocks).sort()).toEqual(['first', 'second', 'stored']);
  } finally {
    abort.abort();
    await workers;
  }
}, 25000);
