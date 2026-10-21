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
  it('replaces a reused instance with the loaded capacity and removes every old index entry', async () => {
    const memory = new Memory({ maxEntries: 3 }, metadata);
    const first = await memory.addEntry('Old first');
    const second = await memory.addEntry('Old second');
    const index = (memory as unknown as { searchIndex: { removeEntry(id: string): void } }).searchIndex;
    const remove = jest.spyOn(index, 'removeEntry');
    memory.deserialize(JSON.stringify({ id: memory.id, type: memory.type,
      metadata: { ...memory.metadata, maxEntries: 1 },
      entries: [{ id: 'replacement', timestamp: '2026-01-01T00:00:00.000Z', content: 'Replacement' }]
    }), { suppressLoadPolicy: true });
    expect(remove.mock.calls).toEqual([[first.id], [second.id]]);
    expect(memory.getAllEntries().map(entry => entry.id)).toEqual(['replacement']);
    const before = memory.serialize();
    await expect(memory.addEntry('Over the loaded limit')).rejects.toThrow(/limit is 1/);
    expect(memory.serialize()).toBe(before);

    memory.deserialize(JSON.stringify({ id: memory.id, type: memory.type,
      metadata: { ...memory.metadata, maxEntries: 2 }, entries: memory.getAllEntries()
    }), { suppressLoadPolicy: true });
    await expect(memory.addEntry('Within the replacement limit')).resolves.toBeDefined();
    expect(memory.getAllEntries()).toHaveLength(2);
  });

  it('does not consult or enforce load policy during guarded hydration', () => {
    const policy = { shouldEnforceOnLoad: jest.fn(() => true), isEnabled: jest.fn(() => true) };
    const memory = new Memory({ maxEntries: 1, onFull: 'evict_oldest' }, metadata, undefined, policy);
    memory.deserialize(JSON.stringify({ id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` }))
    }), { suppressLoadPolicy: true });
    expect(policy.shouldEnforceOnLoad).not.toHaveBeenCalled();
    expect(policy.isEnabled).not.toHaveBeenCalled();
    expect(memory.getAllEntries().map(entry => entry.id).sort()).toEqual(['entry-0', 'entry-1']);
  });

  it('removes expired entries from the derived search index as well as authoritative storage', () => {
    const memory = new Memory({}, metadata, undefined,
      { shouldEnforceOnLoad: () => true, isEnabled: () => true });
    const index = (memory as unknown as { searchIndex: { removeEntry(id: string): void } }).searchIndex;
    const remove = jest.spyOn(index, 'removeEntry');
    memory.deserialize(JSON.stringify({ id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [{ id: 'expired', timestamp: '2020-01-01T00:00:00.000Z', content: 'Expired entry',
        expiresAt: '2020-01-02T00:00:00.000Z' }]
    }));
    expect(memory.getAllEntries()).toEqual([]);
    expect(remove).toHaveBeenCalledWith('expired');
    expect(memory.getPolicyRemovedCount()).toBe(1);
  });

  it('reports an actual on-load enforcement failure instead of ignoring a rejected Promise', () => {
    const memory = new Memory({ name: 'Load failure', maxEntries: 2, onFull: 'evict_oldest' }, metadata, undefined,
      { shouldEnforceOnLoad: () => true, isEnabled: () => true });
    const cause = new Error('retention audit failed');
    failRetentionAudit(cause);
    expect(() => memory.deserialize(JSON.stringify({
      id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` })),
    }))).toThrow('retention audit failed');
  });

  it('keeps public enforcement asynchronous while preserving immediate policy effects and exact rejection', async () => {
    const memory = new Memory({ maxEntries: 2, onFull: 'evict_oldest' }, metadata);
    await memory.addEntry('First');
    await memory.addEntry('Second');
    const cause = new Error('retention audit failed');
    failRetentionAudit(cause);
    let pending: Promise<number> | undefined;
    expect(() => { pending = memory.enforceRetentionPolicy(); }).not.toThrow();
    expect(memory.getAllEntries()).toHaveLength(1);
    await expect(pending).rejects.toBe(cause);
  });

  it('an unavailable optional resolver leaves valid loaded entries intact', () => {
    const memory = new Memory({ maxEntries: 1, onFull: 'evict_oldest' }, metadata, undefined,
      { shouldEnforceOnLoad: () => { throw new Error('optional resolver unavailable'); }, isEnabled: () => true });
    expect(() => memory.deserialize(JSON.stringify({
      id: memory.id, type: memory.type, metadata: memory.metadata,
      entries: [0, 1].map(i => ({ id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i}` })),
    }))).not.toThrow();
    expect(memory.getAllEntries().map(entry => entry.id).sort()).toEqual(['entry-0', 'entry-1']);
  });
});
