import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import { readdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence, FileMemoryFenceTimeoutError, observeTenantFence } from '../../../src/storage/FileMemoryFence.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

const roots: string[] = [];
async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fence-audit-secret-root-'));
  roots.push(directory);
  return directory;
}
const events = () => SecurityMonitor.getEventsByType('OPERATION_FAILED').filter(event => event.source === 'FileMemoryFence');
afterEach(async () => {
  jest.restoreAllMocks();
  SecurityMonitor.clearAllEventsForTesting();
  for (const directory of roots.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('FileMemoryFence failure audit boundaries', () => {
  it('records invalid locator failures separately in the real dedup window without caller data', async () => {
    const sentinel = '../secret-token-content-hash';
    const tenantRoot = await root();
    const operation = jest.fn(() => 1);
    for (let i = 0; i < 2; i++) await expect(new FileMemoryFence().withFence(
      { tenantRoot, memoryLocator: sentinel }, operation,
    )).rejects.toBeInstanceOf(TypeError);
    expect(operation).not.toHaveBeenCalled();
    expect(events()).toHaveLength(2);
    expect(events()[0].details).not.toBe(events()[1].details);
    expect(events().every(event => event.details.includes('stage=resolution'))).toBe(true);
    expect(JSON.stringify(events())).not.toContain(tenantRoot);
    expect(JSON.stringify(events())).not.toContain(sentinel);
  });

  if (process.platform === 'win32') return;

  it('audits actual unsafe namespace observation but normal absence and successful release stay quiet', async () => {
    const tenantRoot = await root();
    await expect(observeTenantFence(tenantRoot)).resolves.toEqual({ present: false });
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => 'done')).resolves.toBe('done');
    expect(events()).toHaveLength(0);
    await fs.chmod(path.join(tenantRoot, '.memory-fences'), 0o777);
    await expect(observeTenantFence(tenantRoot)).rejects.toThrow('not private');
    expect(events()).toHaveLength(1);
    expect(events()[0].details).toContain('stage=observation');
  });

  it('audits acquisition timeout without changing the held lease or invoking the contender', async () => {
    const tenantRoot = await root();
    const fence = new FileMemoryFence();
    const contender = jest.fn(() => 1);
    await fence.withTenantFence(tenantRoot, async () => {
      const before = await fs.readFile(path.join(tenantRoot, '.memory-fences/tenant.lock/owner'));
      await expect(fence.withTenantFence(tenantRoot, contender, { timeoutMs: 20 })).rejects.toBeInstanceOf(FileMemoryFenceTimeoutError);
      expect(await fs.readFile(path.join(tenantRoot, '.memory-fences/tenant.lock/owner'))).toEqual(before);
      expect(JSON.stringify(events())).not.toContain(before.toString());
    });
    expect(contender).not.toHaveBeenCalled();
    expect(events()).toHaveLength(1);
    expect(events()[0].details).toContain('stage=acquisition');
  });

  it.each([null, undefined])('preserves primitive callback rejection %s and observes only after release', async cause => {
    const tenantRoot = await root();
    let observedLeaseNames: string[] | undefined;
    const unsubscribe = SecurityMonitor.addLogListener(() => {
      observedLeaseNames = readdirSync(path.join(tenantRoot, '.memory-fences'));
      throw new Error('secret audit listener failure');
    });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('secret fallback failure'); });
    try {
      await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => { throw cause; })).rejects.toBe(cause);
    } finally { unsubscribe(); }
    expect(observedLeaseNames).toEqual([]);
    expect(events()).toHaveLength(1);
    expect(events()[0].details).toContain('stage=callback; callback=failed');
    expect(JSON.stringify(events())).not.toContain('secret audit');
  });

  it('preserves a postcommit receipt and contains a throwing monitor without inventing rollback', async () => {
    const tenantRoot = await root();
    const receipt = Object.assign(new Error('secret postcommit detail'), { code: 'EHEADCOMMITTED' });
    const monitor = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('sink failed'); });
    await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => { throw receipt; })).rejects.toBe(receipt);
    expect(await fs.readdir(path.join(tenantRoot, '.memory-fences'))).toEqual([]);
    expect(monitor).toHaveBeenCalledTimes(1);
    const event = monitor.mock.calls[0][0];
    expect(event.details).toContain('storage-outcome=unclassified');
    expect(JSON.stringify(event)).not.toMatch(/secret|EHEADCOMMITTED|rollback|refused/);
  });

  it('does not inspect arbitrary callback error properties or let observer mutation turn failure into success', async () => {
    const tenantRoot = await root();
    const receipt = Object.defineProperty(new Error('secret error message'), 'code', {
      get() { throw new Error('untrusted getter must not run'); },
    });
    let observedLeaseNames: string[] | undefined;
    const unsubscribe = SecurityMonitor.addLogListener(() => {
      observedLeaseNames = readdirSync(path.join(tenantRoot, '.memory-fences'));
      writeFileSync(path.join(tenantRoot, 'observer-file'), 'observer mutation');
    });
    try {
      await expect(new FileMemoryFence().withTenantFence(tenantRoot, () => { throw receipt; })).rejects.toBe(receipt);
    } finally { unsubscribe(); }
    expect(events()).toHaveLength(1);
    expect(JSON.stringify(events())).not.toContain('secret error');
    expect(observedLeaseNames).toEqual([]);
    expect(await fs.readFile(path.join(tenantRoot, 'observer-file'), 'utf8')).toBe('observer mutation');
    expect(await fs.readdir(path.join(tenantRoot, '.memory-fences'))).toEqual([]);
  });

  it.each([false, true])('retains actual release failure composition after callback failed=%s', async callbackFailed => {
    const tenantRoot = await root();
    const primary = null;
    let observed: unknown;
    try {
      await new FileMemoryFence().withTenantFence(tenantRoot, async () => {
        await fs.writeFile(path.join(tenantRoot, '.memory-fences/tenant.lock/owner'), 'secret-replaced-owner');
        if (callbackFailed) throw primary;
        return 'callback completed';
      });
    } catch (cause) { observed = cause; }
    expect(observed).toBeInstanceOf(Error);
    if (callbackFailed) {
      expect(observed).toBeInstanceOf(AggregateError);
      expect((observed as AggregateError).cause).toBe(primary);
      expect((observed as AggregateError).errors[0]).toBe(primary);
      expect((observed as AggregateError).errors[1]).toBeInstanceOf(Error);
    }
    expect(await fs.readFile(path.join(tenantRoot, '.memory-fences/tenant.lock/owner'), 'utf8')).toBe('secret-replaced-owner');
    expect(events()).toHaveLength(1);
    expect(events()[0].details).toContain(`stage=release; callback=${callbackFailed ? 'failed' : 'completed'}`);
    expect(events()[0].details).toContain('storage-outcome=unclassified');
    expect(JSON.stringify(events())).not.toContain('secret-replaced-owner');
  });
});
