import { Memory, MemoryMetadata } from '../../../../src/elements/memories/Memory.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';

const metadataService = new MetadataService();

function loadedMemory(count: number, metadata: Partial<MemoryMetadata> = {}): Memory {
  const memory = new Memory({ name: 'Capacity recovery', ...metadata }, metadataService);
  memory.deserialize(JSON.stringify({
    id: memory.id, type: ElementType.MEMORY, metadata: memory.metadata,
    entries: Array.from({ length: count }, (_, i) => ({
      id: `legacy-${i}`, timestamp: new Date(1700000000000 + i).toISOString(), content: `Preserved entry ${i}`,
    })),
  }));
  return memory;
}

describe('Permanent memory capacity safety', () => {
  it('rejects the 1001st entry and preserves all 1000 entries byte for byte', async () => {
    const memory = loadedMemory(1000);
    const before = memory.serialize();
    await expect(memory.addEntry('Rejected new entry')).rejects.toThrow(/Memory is full.*1000\/1000.*Start a new memory/s);
    expect(memory.serialize()).toBe(before);
    expect(memory.getAllEntries()).toHaveLength(1000);
  });

  it('loads all 1001 legacy entries and rejects append without trimming them', async () => {
    const memory = loadedMemory(1001);
    expect(memory.getAllEntries().map(entry => entry.id)).toEqual(Array.from({ length: 1001 }, (_, i) => `legacy-${i}`));
    const before = memory.serialize();
    await expect(memory.addEntry('No capacity')).rejects.toThrow('Memory is full');
    expect(memory.serialize()).toBe(before);
  });

  it('accepts exactly one of competing additions at 999 and retains every accepted entry', async () => {
    const memory = loadedMemory(999);
    const original = memory.getAllEntries().map(entry => entry.id);
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => memory.addEntry(`Concurrent ${i}`)));
    const accepted = attempts.filter(result => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(7);
    const entries = memory.getAllEntries();
    expect(entries).toHaveLength(1000);
    expect(entries.map(entry => entry.id)).toEqual(expect.arrayContaining(original));
    for (const result of accepted) {
      if (result.status === 'fulfilled') expect(await memory.getEntry(result.value.id)).toEqual(result.value);
    }
  });

  it.each([
    { onFull: 'evict_oldest' as const },
    { retentionDays: 7 },
  ])('retains the oldest-entry eviction contract when configured: %j', async policy => {
    const memory = loadedMemory(2, { maxEntries: 2, ...policy });
    const added = await memory.addEntry('Replacement');
    expect(memory.getAllEntries().map(entry => entry.id)).toEqual(['legacy-1', added.id]);
    expect(await memory.getEntry('legacy-0')).toBeUndefined();
  });

  it('explicit error overrides expiring retention', async () => {
    const memory = loadedMemory(2, { maxEntries: 2, retentionDays: 7, onFull: 'error' });
    const before = memory.serialize();
    await expect(memory.addEntry('Rejected')).rejects.toThrow('Memory is full');
    expect(memory.serialize()).toBe(before);
  });

  it('a malformed explicit policy cannot enable the expiring-memory eviction default', async () => {
    const memory = loadedMemory(2, { maxEntries: 2, retentionDays: 7 });
    Object.assign(memory.metadata, { onFull: 'evict-oldest' });
    const before = memory.serialize();
    await expect(memory.addEntry('Rejected')).rejects.toThrow('Memory is full');
    expect(memory.serialize()).toBe(before);
  });

  it('policy follows edited retention and explicit metadata without losing entries', async () => {
    const memory = loadedMemory(2, { maxEntries: 2, retentionDays: 7 });
    Object.assign(memory.metadata, { retentionDays: 999999 });
    await expect(memory.addEntry('Rejected')).rejects.toThrow('Memory is full');
    Object.assign(memory.metadata, { onFull: 'evict_oldest' });
    await expect(memory.addEntry('Explicit cache entry')).resolves.toBeDefined();
    expect(memory.getAllEntries()).toHaveLength(2);
  });
});
