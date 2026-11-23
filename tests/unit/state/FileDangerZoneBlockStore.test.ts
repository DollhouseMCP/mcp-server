import { admissionPhases, verifyAdmission, verifyBlockDrain, verifyResetStage } from '../../helpers/blockDrain.js';
import { conflictCases, verifyDeclinedWrite } from '../../helpers/blockConflicts.js';
import { firstUseCases, verifyConcurrentFirstUse, verifyFirstUse } from '../../helpers/blockFirstUse.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';

afterEach(() => { jest.restoreAllMocks(); });
it.each([false, true])('resets absent state after a failed write: %s', async failWrite => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-reset-absent-'));
  try {
    const fileOps = new FileOperationsService(new FileLockManager());
    const store = new FileDangerZoneBlockStore(fileOps, directory);
    if (failWrite) {
      jest.spyOn(fileOps, 'writeFile').mockRejectedValueOnce(new Error('Storage unavailable'));
      const enforcer = new DangerZoneEnforcer(store);
      expect(await enforcer.block('agent', 'Review required', [])).toBe(false);
      enforcer.setAdminToken('admin');
      expect(await enforcer.clearAll('admin')).toBe(true);
      expect((await enforcer.check('agent')).blocked).toBe(false);
    } else expect(await store.reset()).toBe('');
    expect(await store.load()).toEqual({ status: 'loaded', value: {} });
    expect((await fs.readdir(directory)).filter(name => name.endsWith('.backup'))).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
it.each(firstUseCases)('loads file state on first %s', async operation => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-first-use-'));
  try { await verifyFirstUse(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory), operation); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});
it('joins concurrent first uses of file state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-first-use-'));
  try { await verifyConcurrentFirstUse(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory)); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});
it.each(conflictCases)('reconciles a declined file-store write: %s', async scenario => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-conflict-'));
  const create = () => new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory);
  try { await verifyDeclinedWrite(create(), create(), scenario, true); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});
describe.each(['read', 'evidence', 'delete'])('file reset during %s', phase => {
  it.each([1, 3])('persists %s arrivals', async count => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-reset-'));
    const fileOps = new FileOperationsService(new FileLockManager());
    try {
      await verifyResetStage(new FileDangerZoneBlockStore(fileOps, directory), count, pause => {
        if (phase === 'delete') {
          const write = fileOps.writeFile.bind(fileOps);
          jest.spyOn(fileOps, 'writeFile').mockImplementationOnce(async (...args) => { await write(...args); await pause(); });
        } else {
          const copy = fs.copyFile.bind(fs);
          jest.spyOn(fs, 'copyFile').mockImplementationOnce(async (...args) => {
            if (phase === 'read') await pause();
            await copy(...args);
            if (phase === 'evidence') await pause();
          });
        }
      });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
describe.each(admissionPhases)('file admission during %s', phase => {
  it.each([[1, false], [3, false], [1, true], [3, true]] as const)('settles %s arrivals (failure: %s)', async (count, fail) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-admission-'));
    try { await verifyAdmission(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory), phase, count, fail); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});
describe('file block snapshots', () => {
  it('writes through atomic file operations and reads the resulting snapshot', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-snapshot-'));
    try {
      const locks = new FileLockManager();
      const atomicWrite = jest.spyOn(locks, 'atomicWriteFile');
      const store = new FileDangerZoneBlockStore(new FileOperationsService(locks), directory);
      const blocks = { agent: { reason: 'Review required', blockedAt: new Date(0).toISOString() } };
      await store.save(blocks);
      expect(atomicWrite).toHaveBeenCalledTimes(1);
      expect(await store.load()).toEqual({ status: 'loaded', value: blocks });
      expect(await fs.readdir(path.join(directory, '.tmp'))).toEqual([]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it('latches an oversized snapshot', async () => {
    const readFile = jest.fn<() => Promise<string>>().mockResolvedValue('é'.repeat(6 * 1024 * 1024));
    const stat = jest.fn<() => Promise<{ size: number }>>().mockResolvedValue({ size: 11 * 1024 * 1024 });
    const store = new FileDangerZoneBlockStore({ readFile, stat } as unknown as FileOperationsService, path.join(os.tmpdir(), 'block-snapshot'));
    expect(await store.load()).toMatchObject({ status: 'invalid' });
    expect(readFile).not.toHaveBeenCalled();
  });
});

it.each([false, true])('settles successive pending block writes (failure: %s)', async fail => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-drain-'));
    try { await verifyBlockDrain(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory), fail); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('does not retry an oversized snapshot after the backoff window', async () => {
  const { DangerZoneEnforcer } = await import('../../../src/security/DangerZoneEnforcer.js');
  const readFile = jest.fn<() => Promise<string>>().mockResolvedValue('x'.repeat(11 * 1024 * 1024));
  const store = new FileDangerZoneBlockStore({ readFile } as unknown as FileOperationsService, path.join(os.tmpdir(), 'oversized-block-state'));
  jest.useFakeTimers();
  try {
    const enforcer = new DangerZoneEnforcer(store);
    await enforcer.initialize();
    const calls = readFile.mock.calls.length;
    jest.advanceTimersByTime(10001);
    expect((await enforcer.check('other')).blocked).toBe(true);
    expect(readFile).toHaveBeenCalledTimes(calls);
  } finally { jest.useRealTimers(); }
});

it.each([false, true])('settles initial-load pending writes (failure: %s)', async fail => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-initial-drain-'));
  try { await verifyBlockDrain(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory), fail, 'initial'); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('block directory mode', () => {
  it.each(['save', 'reset'])('creates the security directory with owner-only permissions during %s', async operation => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-directory-'));
    const directory = path.join(root, 'security');
    try {
      const store = new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory);
      if (operation === 'save') await store.save({}); else await store.reset();
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

it.each([{ 'invalid/name': null }, { agent: null, ' agent ': null }])('reports invalid snapshot names without changing the file', async blocks => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-names-'));
  const file = path.join(directory, 'blocked-agents.json');
  const content = JSON.stringify({ version: 1, blocks });
  try {
    await fs.writeFile(file, content);
    const store = new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory);
    expect(await store.load()).toMatchObject({ status: 'invalid' });
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it('normalizes parser keys while preserving raw entry values', async () => {
  const { readDangerZoneBlockSnapshot } = await import('../../../src/state/readDangerZoneBlockSnapshot.js');
  const block = { agentName: 'payload-name', reason: 'Review required', extra: { retained: true } };
  const result = await readDangerZoneBlockSnapshot(async () => JSON.stringify({ version: 1, blocks: { ' agent ': block, ' placeholder ': null } }));
  expect(result.status).toBe('loaded');
  if (result.status !== 'loaded') throw new Error('Expected loaded snapshot');
  expect(Object.getPrototypeOf(result.value)).toBeNull();
  expect(result.value).toEqual({ agent: block, placeholder: null });
});
