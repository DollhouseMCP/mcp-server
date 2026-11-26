import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import type { FileCreateOptions, FileOperationsService, FileReadOptions } from '../../../src/services/FileOperationsService.js';

const record = { reason: 'Review required', blockedAt: 'invalid date', verificationId: 'challenge' };
let directory: string;
let filename: string;
let readFile: jest.Mock<(file: string, options?: FileReadOptions) => Promise<string>>;
const enforcers: DangerZoneEnforcer[] = [];
let writeFile: jest.Mock<(file: string, content: string) => Promise<void>>;
function instance() {
  const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore({ readFile, writeFile,
    withWriteLock: async (file: string, operation: () => Promise<unknown>) => operation(),
    createFileExclusive: async (file: string, bytes: string, options: FileCreateOptions) => {
      await fs.writeFile(file, bytes, { flag: 'wx', encoding: options.encoding, mode: options.mode });
      return true;
    },
    createDirectory: async (directory: string) => { await fs.mkdir(directory, { recursive: true }); },
    copyFile: async (source: string, target: string, options: { exclusive?: boolean }) => fs.copyFile(source, target, options.exclusive ? fs.constants.COPYFILE_EXCL : 0),
    chmod: (file: string, mode: number) => fs.chmod(file, mode),
  } as unknown as FileOperationsService, directory));
  enforcers.push(enforcer);
  return enforcer;
}
async function snapshot(blocks: Record<string, unknown>) {
  await fs.writeFile(filename, JSON.stringify({ version: 1, blocks }));
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-readiness-'));
  filename = path.join(directory, 'blocked-agents.json');
  readFile = jest.fn((file: string, options?: FileReadOptions) => fs.readFile(file, options?.encoding ?? 'utf8'));
  writeFile = jest.fn((file: string, content: string) => fs.writeFile(file, content));
});
afterEach(async () => {
  await Promise.all(enforcers.splice(0).map(enforcer => enforcer.shutdown()));
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('blocked-agent state readiness', () => {
  it.each(['EACCES', 'EIO', 'ETIMEDOUT', 'ENOTDIR'])('retains unavailable state after %s', async code => {
    readFile.mockRejectedValue(Object.assign(new Error('read failed'), { code }));
    jest.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('copy failed'), { code }));
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('agent')).blocked).toBe(true);
    enforcer.block('agent', 'Review required', [], 'challenge');
    expect((await enforcer.unblock('agent', 'challenge'))).toBe(false);
    enforcer.setAdminToken('admin');
    expect(await enforcer.clearAll('admin')).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(writeFile).not.toHaveBeenCalled();
  });
  it.each(['{', 'null', '{"version":1}', '{"version":2,"blocks":{}}', '{"version":1,"blocks":[]}', '{"version":1,"blocks":null}', '{"version":1,"blocks":"value"}'])('preserves an unavailable snapshot: %s', async content => {
    await fs.writeFile(filename, content);
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('agent')).blocked).toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ severity: 'HIGH' }));
    expect(await fs.readFile(filename, 'utf8')).toBe(content);
  });
  it('restores valid records and reserves unreadable records', async () => {
    await snapshot({ a: null, b: record, c: { ...record, sessionId: 4 } });
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('b')).verificationId).toBe('challenge');
    expect((await enforcer.check('a'))).toMatchObject({ blocked: true });
    expect((await enforcer.check('a')).verificationId).toBeUndefined();
    expect((await enforcer.unblock('a'))).toBe(false);
    expect((await enforcer.unblock('c', 'challenge'))).toBe(false);
  });
  it.each([{ a: record, 'bad/key': record }, { a: record, ' a ': record }])('publishes only a fully validated map', async blocks => {
    await snapshot(blocks);
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('unlisted')).blocked).toBe(true);
    expect((await enforcer.getBlockedAgents())).toEqual([]);
  });
  it('holds calls during load and keeps newer in-memory blocks', async () => {
    let finish!: (content: string) => void;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    readFile.mockImplementation(() => new Promise(resolve => { finish = resolve; entered(); }));
    const enforcer = instance();
    const loading = enforcer.initialize();
    const checking = enforcer.check('unlisted');
    enforcer.block('agent', 'New review', [], 'new');
    expect(writeFile).not.toHaveBeenCalled();
    await reading;
    finish(JSON.stringify({ version: 1, blocks: { agent: record, older: record } }));
    await loading;
    expect((await checking).blocked).toBe(false);
    expect((await enforcer.check('agent')).verificationId).toBe('new');
    expect((await enforcer.check('older')).verificationId).toBe('challenge');
    await enforcer.flush();
  });
  it('reloads repaired state and keeps an evidence copy during an authorized reset', async () => {
    await fs.writeFile(filename, '{');
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.unblock('agent', 'challenge'))).toBe(false);
    enforcer.setAdminToken('admin');
    expect(await enforcer.clearAll('admin')).toBe(true);
    const copies = (await fs.readdir(directory)).filter(name => name !== 'blocked-agents.json');
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, copies[0]), 'utf8')).toBe('{');
    expect((await enforcer.check('agent')).blocked).toBe(false);
    await snapshot({ agent: record });
    await enforcer.initialize();
    expect((await enforcer.check('agent')).verificationId).toBe('challenge');
  });
  it('loads absent and legacy snapshots with stable timestamps', async () => {
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('agent')).blocked).toBe(false);
    await snapshot({ agent: record });
    await enforcer.initialize();
    expect((await enforcer.check('agent'))).toMatchObject({ eventId: 'challenge', blockedAt: new Date(0).toISOString() });
  });
  it('revalidates a repaired snapshot before publishing readiness', async () => {
    await fs.writeFile(filename, 'null');
    const enforcer = instance();
    await enforcer.initialize();
    expect((await enforcer.check('unlisted')).blocked).toBe(true);
    await snapshot({ agent: record });
    const reload = enforcer.initialize();
    const checking = enforcer.check('unlisted');
    await reload;
    expect((await checking).blocked).toBe(false);
    expect((await enforcer.check('unlisted')).blocked).toBe(false);
    expect((await enforcer.check('agent')).verificationId).toBe('challenge');
  });
  it('preserves placeholder restrictions in subsequent snapshots', async () => {
    await snapshot({ damaged: null });
    const enforcer = instance();
    await enforcer.initialize();
    enforcer.block('agent', 'Review required', []);
    await enforcer.flush();
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).blocks.damaged).toBeNull();
    const restored = instance();
    await restored.initialize();
    expect((await restored.check('damaged')).blocked).toBe(true);
    expect((await restored.unblock('damaged'))).toBe(false);
  });
  it('orders an outstanding snapshot before reload', async () => {
    const enforcer = instance();
    await enforcer.initialize();
    enforcer.block('agent', 'Review required', [], 'new');
    await enforcer.initialize();
    expect((await enforcer.check('agent')).verificationId).toBe('new');
  });
  it('holds new blocks made while an administrative reset is pending', async () => {
    await fs.writeFile(filename, 'null');
    const enforcer = instance();
    await enforcer.initialize();
    enforcer.setAdminToken('admin');
    const resetting = enforcer.clearAll('admin');
    enforcer.block('new', 'Review required', [], 'new-code');
    const reloading = enforcer.initialize();
    const checking = enforcer.check('unlisted');
    expect(await resetting).toBe(true);
    await reloading;
    expect((await checking).blocked).toBe(false);
    await enforcer.flush();
    expect((await enforcer.check('new')).verificationId).toBe('new-code');
    expect(JSON.parse(await fs.readFile(filename, 'utf8')).blocks.new.verificationId).toBe('new-code');
  });

});
