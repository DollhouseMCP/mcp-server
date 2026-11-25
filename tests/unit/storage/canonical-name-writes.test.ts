import { describe, expect, it, jest } from '@jest/globals';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { canonicalElementName } from '../../../src/storage/ElementNameKeys.js';

const TEST_USER = '11111111-1111-4111-8111-111111111111';

/** A drizzle-shaped transaction that records every inserted row and resolves each statement. */
function recordingTransaction() {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'limit', 'returning', 'onConflictDoUpdate', 'onConflictDoNothing', 'set']) {
      value[name] = () => value;
    }
    value.values = (row: Record<string, unknown> | Array<Record<string, unknown>>) => {
      inserted.push(...(Array.isArray(row) ? row : [row]));
      return value;
    };
    value.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return value;
  };
  const written = [{ id: 'row-id', updatedAt: new Date(3) }];
  const tx = {
    execute: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    select: jest.fn(() => chain([])),
    insert: jest.fn(() => chain(written)),
    update: jest.fn(() => chain(written)),
    delete: jest.fn(() => chain([])),
  };
  const transaction = jest.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
  return { inserted, db: { transaction } as never };
}

const metadata = { author: '', version: '1', description: '', tags: [] };

describe('database writes store the canonical element name', () => {
  it.each(['Q&A', "Bob's Notes", "What's New?", `Long ${'x'.repeat(120)}`])('stores %s under the name its hydrated element carries', async name => {
    const { inserted, db } = recordingTransaction();
    const layer = new DatabaseStorageLayer(db, () => TEST_USER, 'skills');
    await layer.writeContent('skills', name, `---\nname: ${JSON.stringify(name)}\n---\nBody`, metadata);
    expect(inserted.find(row => 'name' in row)?.name).toBe(canonicalElementName(name));
  });

  it('keeps a memory under the name it was written with: a memory\'s stored name is its guarded identity', async () => {
    const { inserted, db } = recordingTransaction();
    const layer = new DatabaseMemoryStorageLayer(db, () => TEST_USER);
    await layer.writeContent('memories', 'Q&A', 'metadata:\n  name: "Q&A"\nentries: []', metadata);
    expect(inserted.find(row => 'name' in row)?.name).toBe('Q&A');
  });
});
