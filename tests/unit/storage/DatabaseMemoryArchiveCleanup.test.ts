import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryVolumeStore } from '../../../src/storage/DatabaseMemoryVolumeStore.js';

const userId = '11111111-1111-4111-8111-111111111111';
const memoryId = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const expected = { backend: 'database' as const, userId, ownerId: memoryId, locator: memoryId, name: 'Memory', revision: '1' };
const receipt = { id, userId, memoryId, volume: 1, sha256: 'a'.repeat(64) };
// Real installed Drizzle builders/session; scripted transport tests SQL and envelope,
// not PostgreSQL locking or commit acknowledgement. Those require integration CI.
function fixture(metadata: Record<string, unknown> = {}, mode = 'success') {
  const raw = JSON.stringify({ metadata, entries: [] });
  const hash = createHash('sha256').update(raw).digest('hex');
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  let selection = 0;
  const responses: unknown[][][] = [
    [['Memory', 1n, false, Buffer.byteLength(raw), Buffer.byteLength(JSON.stringify(metadata))]],
    [[raw, metadata, hash, Buffer.byteLength(raw)]],
    [[0, '0']], [], [[id, receipt.sha256]], [[id]],
  ];
  const client = postgres('postgres://unused:unused@127.0.0.1:1/unused');
  jest.spyOn(client, 'unsafe').mockImplementation(((query: string, valuesInput: unknown[] = []) => {
    statements.push(query);
    parameters.push(valuesInput);
    const values = /^select /iu.test(query) && !query.includes('set_config') ? responses[selection++] :
      /^delete /iu.test(query) ? responses[selection++] : [];
    const task = Promise.resolve(values);
    return Object.assign(task, { values: () => task });
  }) as typeof client.unsafe);
  jest.spyOn(client, 'begin').mockImplementation((async (callback: (value: unknown) => Promise<unknown>) => {
    if (mode === 'begin-failure') throw undefined;
    try {
      const value = await callback(client);
      if (mode === 'commit-failure') throw new Error('commit acknowledgement lost');
      return value;
    } catch (cause) {
      if (mode === 'rollback-failure') throw null;
      throw cause;
    }
  }) as typeof client.begin);
  const store = new DatabaseMemoryVolumeStore(drizzle(client) as DatabaseInstance, () => userId);
  return { store, responses, statements, parameters };
}

describe('protected database archive cleanup envelope', () => {
  it('locks only the current parent and exactly deletes the receipt under READ COMMITTED', async () => {
    const f = fixture();
    expect(await f.store.removeUnreferenced(expected, receipt)).toEqual({ status: 'removed', reason: 'removed' });
    expect(f.statements.find(value => value.includes('for update'))).toContain('"elements"');
    expect(f.statements.filter(value => value.includes('for update'))).toHaveLength(1);
    const deletion = f.statements.find(value => value.startsWith('delete'))!;
    for (const name of ['id', 'user_id', 'memory_id', 'volume', 'sha256']) expect(deletion).toContain(`"${name}"`);
    expect(f.statements.some(value => value.startsWith('lock table'))).toBe(false);
    expect(f.statements.some(value => value.includes('read committed'))).toBe(true);
  });

  it.each(['begin-failure', 'commit-failure', 'rollback-failure'])('keeps %s unknown without a removal claim', async mode => {
    const f = fixture(mode === 'rollback-failure' ? { volumes: 'malformed' } : {}, mode);
    const outcome = await f.store.removeUnreferenced(expected, receipt);
    expect(outcome).toEqual({ status: 'unknown', reason: 'query' });
    expect(Object.hasOwn(outcome, 'cause')).toBe(true);
    expect(Object.keys(outcome)).not.toContain('cause');
  });

  it.each([null, {}, 'wrong', [null], [{ volume: 1 }]])('refuses malformed references %j before deletion', async volumes => {
    const f = fixture({ volumes });
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'unsafe' });
    expect(f.statements.some(value => value.startsWith('delete'))).toBe(false);
  });

  it('refuses a target number reference even with another digest', async () => {
    const f = fixture({ volumes: [{ volume: 1, file: `volumes/${memoryId}/v0001.yaml`, sha256: 'b'.repeat(64),
      entryCount: 0, sealedAt: '1970-01-01T00:00:00.000Z', firstEntryAt: null, lastEntryAt: null }] });
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'referenced' });
    expect(f.statements.some(value => value.startsWith('delete'))).toBe(false);
  });

  it('classifies a same-number replacement as mismatch before receipt matching', async () => {
    const f = fixture(); f.responses[4] = [['44444444-4444-4444-8444-444444444444', receipt.sha256]];
    expect(await f.store.removeUnreferenced(expected, receipt)).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(f.statements.some(value => value.startsWith('delete'))).toBe(false);
  });

  it('returns only current observed absence', async () => {
    const f = fixture(); f.responses[4] = [];
    expect(await f.store.removeUnreferenced(expected, receipt)).toEqual({ status: 'absent', reason: 'absent' });
  });
  it.each([null, NaN, -1, Infinity])('refuses invalid parent size evidence %s before raw fetch', async value => {
    const f = fixture(); f.responses[0][0][3] = value;
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'unsafe' });
    expect(f.statements.some(query => query.includes('"content_hash"'))).toBe(false);
  });

  it.each([['raw', 3, 8 * 1024 * 1024 + 1], ['metadata', 4, 2 * 1024 * 1024 + 1]])('refuses %s overflow before materialization', async (_label, index, size) => {
    const f = fixture(); f.responses[0][0][Number(index)] = size;
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'resource' });
    expect(f.statements.some(query => query.includes('"content_hash"'))).toBe(false);
  });

  it('caps admission rows before aggregation and refuses the overflow sentinel', async () => {
    const f = fixture(); f.responses[2] = [[10_001, '0']];
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'resource' });
    const index = f.statements.findIndex(query => query.includes('count(*)'));
    expect(f.statements[index]).toMatch(/from \(select .* limit \$\d+\) "archive_admission"/su);
    expect(f.parameters[index]).toContain(10_001);
    expect(f.statements.some(query => query.includes('sealedUnrepresentable'))).toBe(false);
    expect(f.statements.some(query => query.startsWith('delete'))).toBe(false);
  });

  it('prechecks complete archive projection size before metadata fetch', async () => {
    const f = fixture(); f.responses[2] = [[0, String(16 * 1024 * 1024 + 1)]];
    expect(await f.store.removeUnreferenced(expected, receipt)).toMatchObject({ status: 'refused', reason: 'resource' });
    expect(f.statements.some(query => query.includes('sealedUnrepresentable'))).toBe(false);
    expect(f.statements.some(query => query.startsWith('delete'))).toBe(false);
  });

  it('supports nonempty unrelated references with exact metadata and nullable endpoints', async () => {
    const reference = { volume: 2, file: `volumes/${memoryId}/v0002.yaml`, sha256: 'b'.repeat(64),
      entryCount: 0, sealedAt: '1970-01-01T00:00:00.000Z', firstEntryAt: null, lastEntryAt: null };
    const f = fixture({ volumes: [reference] });
    f.responses[2] = [[1, '300']];
    f.responses[3] = [['44444444-4444-4444-8444-444444444444', userId, memoryId, 2, reference.sha256,
      0, null, null, new Date(0), false, false, false, 300]];
    expect(await f.store.removeUnreferenced(expected, receipt)).toEqual({ status: 'removed', reason: 'removed' });
  });

  it('does not treat a stale owner/name/revision as current reference authority', async () => {
    const f = fixture();
    expect(await f.store.removeUnreferenced({ ...expected, revision: '2' }, receipt)).toMatchObject({ status: 'refused', reason: 'head' });
    expect(f.statements.some(query => query.startsWith('delete'))).toBe(false);
  });

  it('preserves a replacement seen after zero exact DELETE', async () => {
    const f = fixture(); f.responses[5] = []; f.responses.push([['44444444-4444-4444-8444-444444444444']]);
    expect(await f.store.removeUnreferenced(expected, receipt)).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(f.statements.filter(query => query.startsWith('delete'))).toHaveLength(1);
  });

});
