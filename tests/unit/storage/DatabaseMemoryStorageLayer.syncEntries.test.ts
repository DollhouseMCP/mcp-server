import { describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';

interface SyncEntriesSurface {
  syncEntriesInTx(tx: DrizzleTx, memoryElementId: string, yamlContent: string): Promise<void>;
}

function makeLayer(): SyncEntriesSurface {
  return new DatabaseMemoryStorageLayer(
    {} as DatabaseInstance,
    () => '00000000-0000-4000-8000-000000000001',
  ) as unknown as SyncEntriesSurface;
}

function makeDeleteOnlyTransaction() {
  const where = jest.fn(async () => undefined);
  const deleteRow = jest.fn(() => ({ where }));
  return {
    tx: { delete: deleteRow } as unknown as DrizzleTx,
    deleteRow,
    where,
  };
}

describe('DatabaseMemoryStorageLayer entry synchronization', () => {
  it('fails closed before mutating normalized entries when YAML parsing fails', async () => {
    const layer = makeLayer();
    const { tx, deleteRow } = makeDeleteOnlyTransaction();

    await expect(layer.syncEntriesInTx(tx, 'memory-id', 'metadata: [unterminated'))
      .rejects.toThrow();
    expect(deleteRow).not.toHaveBeenCalled();
  });

  it('fails closed before mutating normalized entries when entries is not an array', async () => {
    const layer = makeLayer();
    const { tx, deleteRow } = makeDeleteOnlyTransaction();

    await expect(layer.syncEntriesInTx(tx, 'memory-id', 'name: test\nentries:\n  invalid: object\n'))
      .rejects.toThrow('Memory entries must be an array');
    expect(deleteRow).not.toHaveBeenCalled();
  });

  it('clears normalized entries when a valid replacement omits the entries section', async () => {
    const layer = makeLayer();
    const { tx, deleteRow, where } = makeDeleteOnlyTransaction();

    await expect(layer.syncEntriesInTx(tx, 'memory-id', 'name: test\ndescription: empty\n'))
      .resolves.toBeUndefined();
    expect(deleteRow).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
