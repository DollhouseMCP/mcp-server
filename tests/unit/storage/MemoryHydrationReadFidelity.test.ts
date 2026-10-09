import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { createRealMemoryManager } from '../../helpers/di-mocks.js';
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';

const roots: string[] = [];
const managers: MemoryManager[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-read-fidelity-')); roots.push(root);
  const manager = createRealMemoryManager(root); managers.push(manager);
  return { root, manager };
}
function document() {
  return { metadata: { name: ' Legacy Raw Name ', description: '', type: 'memory', version: '1.0.0',
    unique_id: 'stable-legacy-identity', maxEntries: 1000, retentionDays: 999999 },
    extensions: { fraction: 0.5 }, instructions: 'Retain instructions', entries: [
      { id: 'newer-tie', timestamp: '2026-10-08T01:00:00Z', content: 'second insertion', tags: ['tag'], metadata: { confidence: 0.5 } },
      { id: 'older-tie', timestamp: '2026-10-08T01:00:00Z', content: 'first insertion', tags: [], metadata: {} },
    ] };
}
const encode = (value: unknown) => yaml.dump(value, { schema: yaml.JSON_SCHEMA, noRefs: true });

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('actual quiet memory hydration qualification', () => {
  it('retains fractional fields and raw tied order using the actual loader without initialization/storage/cache publication', async () => {
    const { root, manager } = await fixture();
    const listing = jest.spyOn(manager, 'list');
    const load = jest.spyOn(manager, 'load');
    const save = jest.spyOn(manager, 'save');
    const raw = encode(document());
    await expect(manager.assertGuardedReadFidelity(raw, '11111111-1111-4111-8111-111111111111', 'Legacy Raw Name')).resolves.toBeUndefined();
    expect(listing).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    expect(raw).toBe(encode(document()));
  });

  it.each(['invalid', 'quarantined', 'sanitized', 'duplicate', 'reordered'])('refuses %s captured entries instead of accepting loader loss', async kind => {
    const { manager } = await fixture(); const raw = document();
    if (kind === 'invalid') Object.assign(raw.entries[0], { content: null });
    if (kind === 'quarantined') Object.assign(raw.entries[0], { trustLevel: 'quarantined' });
    if (kind === 'sanitized') raw.entries[0].content = '<script>unsafe()</script>body';
    if (kind === 'duplicate') raw.entries[0].id = raw.entries[1].id;
    if (kind === 'reordered') raw.entries[1].timestamp = '2026-10-09T01:00:00Z';
    await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).rejects.toThrow();
  });

  it('refuses archive references, dropped metadata and changed owner naming without mutation', async () => {
    const { manager } = await fixture();
    for (const metadata of [{ volumes: [{ volume: 1 }] }, { extra: { soleCopy: 'value' } }]) {
      const raw = document(); Object.assign(raw.metadata, metadata);
      await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).rejects.toThrow();
    }
    await expect(manager.assertGuardedReadFidelity(encode(document()), 'locator', 'different-owner')).rejects.toThrow('owner name');
  });

  it('refuses metadata instructions omitted by the actual loader rather than assuming the later hook receives them', async () => {
    const { manager } = await fixture();
    const raw = document(); Object.assign(raw.metadata, { instructions: 'Metadata instructions' });
    delete (raw as Partial<typeof raw>).instructions;
    await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).rejects.toThrow();
    raw.instructions = 'Root wins';
    await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).rejects.toThrow();
  });

  it('preserves absent, explicit null and ISO expiries with the actual loader', async () => {
    const { manager } = await fixture();
    for (const expiresAt of [undefined, null, '2027-01-01T00:00:00Z']) {
      const raw = document();
      if (expiresAt !== undefined) Object.assign(raw.entries[0], { expiresAt });
      await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).resolves.toBeUndefined();
    }
    const invalid = document(); Object.assign(invalid.entries[0], { expiresAt: false });
    await expect(manager.assertGuardedReadFidelity(encode(invalid), 'locator', 'Legacy Raw Name')).rejects.toThrow();
  });

  it('accepts absent instructions/extensions constructor defaults in a flat legacy document', async () => {
    const { manager } = await fixture();
    const value = document();
    const raw = { ...value.metadata, name: 'Legacy Raw Name', entries: value.entries };
    await expect(manager.assertGuardedReadFidelity(encode(raw), 'locator', 'Legacy Raw Name')).resolves.toBeUndefined();
  });
});
