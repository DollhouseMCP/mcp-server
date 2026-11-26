import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { logger } from '../../../src/utils/logger.js';
import { isolatedServerEnv } from '../../helpers/isolated-server-env.cjs';

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
