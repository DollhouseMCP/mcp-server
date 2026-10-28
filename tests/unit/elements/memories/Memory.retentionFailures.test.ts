import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Memory } from '../../../../src/elements/memories/Memory.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

const metadata = new MetadataService();

afterEach(() => {
  jest.restoreAllMocks();
});

function failRetentionAudit(cause: Error): void {
  const original = SecurityMonitor.logSecurityEvent;
  jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(event => {
    if (event.type === 'RETENTION_POLICY_ENFORCED') throw cause;
    original.call(SecurityMonitor, event);
  });
}

describe('Retention failure boundaries', () => {
  it('reports an actual on-load enforcement failure instead of ignoring a rejected Promise', () => {
    const memory = new Memory({ name: 'Load failure', maxEntries: 2, onFull: 'evict_oldest' }, metadata, undefined,
      { shouldEnforceOnLoad: () => true, isEnabled: () => true });
    const cause = new Error('retention audit failed');
    failRetentionAudit(cause);
    expect(() => memory.deserialize(JSON.stringify({
      id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1, 2].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` })),
    }))).toThrow('retention audit failed');
  });

  it('keeps public enforcement asynchronous while preserving immediate policy effects and exact rejection', async () => {
    const memory = new Memory({ maxEntries: 2, onFull: 'evict_oldest' }, metadata);
    const first = await memory.addEntry('First');
    await memory.addEntry('Second');
    first.expiresAt = new Date('2000-01-01T00:00:00.000Z');
    const cause = new Error('retention audit failed');
    failRetentionAudit(cause);
    let pending: Promise<number> | undefined;
    expect(() => { pending = memory.enforceRetentionPolicy(); }).not.toThrow();
    expect(memory.getAllEntries()).toHaveLength(1);
    await expect(pending).rejects.toBe(cause);
  });

  it('an unavailable optional policy leaves valid loaded entries intact', () => {
    const memory = new Memory({ maxEntries: 1, onFull: 'evict_oldest' }, metadata, undefined, {
      shouldEnforceOnLoad: () => { throw new Error('optional policy unavailable'); }, isEnabled: () => true,
    });
    expect(() => memory.deserialize(JSON.stringify({
      id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` })),
    }))).not.toThrow();
    expect(memory.getAllEntries().map(entry => entry.id)).toEqual(['entry-1', 'entry-0']);
  });

  it('suppresses policy lookup and enforcement during guarded hydration', () => {
    const policy = { shouldEnforceOnLoad: jest.fn(() => true), isEnabled: jest.fn(() => true) };
    const memory = new Memory({ maxEntries: 1, onFull: 'evict_oldest' }, metadata, undefined, policy);
    const enforcement = jest.spyOn(memory as any, 'enforceRetentionPolicySync');
    failRetentionAudit(new Error('must not enforce'));
    expect(() => memory.deserialize(JSON.stringify({
      id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` })),
    }), { suppressLoadPolicy: true })).not.toThrow();
    expect(policy.shouldEnforceOnLoad).not.toHaveBeenCalled();
    expect(policy.isEnabled).not.toHaveBeenCalled();
    expect(enforcement).not.toHaveBeenCalled();
    expect(memory.getAllEntries().map(entry => entry.id)).toEqual(['entry-1', 'entry-0']);
  });

});
