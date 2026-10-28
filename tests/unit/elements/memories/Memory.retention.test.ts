import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Memory, MemoryMetadata } from '../../../../src/elements/memories/Memory.js';
import { MEMORY_SECURITY_EVENTS } from '../../../../src/elements/memories/constants.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { createTestMetadataService } from '../../../helpers/di-mocks.js';

const metadataService = createTestMetadataService();
const onLoadPolicy = { shouldEnforceOnLoad: () => true, isEnabled: () => true };
const metadata: Partial<MemoryMetadata> = { name: 'Retention regression', maxEntries: 3, onFull: 'evict_oldest' };

async function serializedEntries(count: number, onFull: MemoryMetadata['onFull'] = 'evict_oldest') {
  const source = new Memory({ ...metadata, maxEntries: count, onFull }, metadataService);
  for (let i = 0; i < count; i++) {
    const entry = await source.addEntry(`Entry ${i}`);
    entry.timestamp = new Date(Date.UTC(2026, 0, i + 1));
  }
  const data = JSON.parse(source.serialize());
  data.metadata.maxEntries = 3;
  data.extensions.maxEntries = 3;
  return JSON.stringify(data);
}

function load(serialized: string, suppressLoadPolicy = false) {
  const memory = new Memory(metadata, metadataService, undefined, onLoadPolicy);
  memory.deserialize(serialized, { suppressLoadPolicy });
  return memory;
}

describe('Memory retention without an append (Issue #3136)', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it.each([
    [3, 'evict_oldest'],
    [3, 'error'],
    [5, 'error'],
  ] as const)('keeps %i entries with onFull=%s through five on_load cycles', async (count, onFull) => {
    let serialized = await serializedEntries(count, onFull);
    const expected = JSON.parse(serialized).entries;
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');

    for (let i = 0; i < 5; i++) {
      const memory = load(serialized);
      expect(JSON.parse(memory.serialize()).entries).toEqual(expected);
      expect(memory.isDirty()).toBe(false);
      expect(memory.getPolicyRemovedCount()).toBe(0);
      serialized = memory.serialize();
    }

    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_SECURITY_EVENTS.RETENTION_POLICY_ENFORCED,
    }));
  });

  it.each([1, 2, 4])('evicts exactly %i excess entries on load, oldest first', async excess => {
    const serialized = await serializedEntries(3 + excess);
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const memory = load(serialized);

    expect(memory.getAllEntries().map(entry => entry.content)).toEqual(
      Array.from({ length: 3 }, (_, i) => `Entry ${i + excess}`),
    );
    expect(memory.getPolicyRemovedCount()).toBe(excess);
    expect(memory.isDirty()).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'MEDIUM',
      details: expect.stringContaining(`Evicted ${excess} oldest entries`),
    }));
  });

  it.each([3, 4, 6])('removes expiry before trimming a %i-entry load to capacity', async count => {
    const data = JSON.parse(await serializedEntries(count));
    data.entries.find((entry: { content: string }) => entry.content === 'Entry 0').expiresAt = '2000-01-01T00:00:00Z';
    const memory = load(JSON.stringify(data));

    expect(memory.getAllEntries().map(entry => entry.content)).toEqual(
      Array.from({ length: Math.min(count - 1, 3) }, (_, i) => `Entry ${i + Math.max(1, count - 3)}`),
    );
    expect(memory.getPolicyRemovedCount()).toBe(Math.max(1, count - 3));
    expect(memory.isDirty()).toBe(true);
  });

  it.each([3, 5])('manual or scheduled enforcement trims only excess from %i entries', async count => {
    const memory = load(await serializedEntries(count), true);

    expect(await memory.enforceRetentionPolicy()).toBe(count - 3);
    expect(memory.getEntries().size).toBe(3);
    expect(memory.isDirty()).toBe(count > 3);
    expect(await memory.enforceRetentionPolicy()).toBe(0);
  });

  it.each([3, 5])('candidate load retention trims only excess from %i entries', async count => {
    const memory = load(await serializedEntries(count), true);
    const candidate = memory.createPersistenceCandidate();

    expect(await candidate.enforceCandidateLoadRetention()).toBe(count - 3);
    expect(candidate.getEntries().size).toBe(3);
    expect(candidate.isDirty()).toBe(count > 3);
    expect(memory.getEntries().size).toBe(count);
    expect(memory.isDirty()).toBe(false);
  });

  it('still makes room for one before adding to a full evict_oldest memory', async () => {
    const memory = load(await serializedEntries(3));
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    await memory.addEntry('New entry');

    expect(memory.getAllEntries().map(entry => entry.content)).toEqual(['Entry 1', 'Entry 2', 'New entry']);
    expect(memory.getPolicyRemovedCount()).toBe(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Memory.enforceRetentionPolicy',
      severity: 'MEDIUM',
      details: expect.stringContaining('Evicted 1 oldest entries'),
    }));
  });

  it('keeps permanent error memories unchanged during enforcement and a rejected add', async () => {
    const memory = load(await serializedEntries(5, 'error'));
    const before = memory.serialize();

    expect(await memory.enforceRetentionPolicy()).toBe(0);
    expect(await memory.createPersistenceCandidate().enforceCandidateLoadRetention()).toBe(0);
    await expect(memory.addEntry('Rejected')).rejects.toThrow('is full');
    expect(memory.serialize()).toBe(before);
    expect(memory.isDirty()).toBe(false);
    expect(memory.getPolicyRemovedCount()).toBe(0);
  });
});
