import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseMemoryReconciliationInspector } from '../../../src/storage/DatabaseMemoryReconciliationInspector.js';
import { MemoryMetadataExtractor, MemoryMetadataExtractionError } from '../../../src/storage/MemoryMetadataExtractor.js';

describe('database memory metadata rejection', () => {
  it('rejects malformed content before starting a transaction', async () => {
    const transaction = jest.fn();
    const layer = new DatabaseMemoryStorageLayer({ transaction } as unknown as DatabaseInstance, () => 'alice');
    await expect(layer.writeContent('memories', 'Broken', 'metadata: [broken', { author: '', version: '1.0.0', tags: [] }))
      .rejects.toBeInstanceOf(MemoryMetadataExtractionError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('classifies an extractor rejection as ambiguous instead of throwing', () => {
    const inspector = new DatabaseMemoryReconciliationInspector({} as DatabaseInstance, () => 'alice');
    const rawContent = 'name: Healthy\nentries: []';
    const parent: Parameters<typeof inspector['classify']>[1] = {
      id: 'memory', name: 'Healthy', rawContent, contentHash: createHash('sha256').update(rawContent).digest('hex'),
      byteSize: Buffer.byteLength(rawContent), storageRevision: 1n, memoryEntriesOutOfSync: false,
      metadata: {}, description: '', version: '1.0.0', author: '', visibility: 'private',
      memoryType: 'user', autoLoad: null, priority: null, hasBodyContent: false, elementCreated: null,
    };
    const extract = jest.spyOn(MemoryMetadataExtractor, 'extractMetadata').mockImplementation(() => {
      throw new MemoryMetadataExtractionError('Healthy', new Error('rejected metadata'));
    });
    try {
      expect(inspector['classify']({ userId: 'alice', memoryId: 'memory' }, parent, [], [], [])).toMatchObject({
        status: 'ambiguous', diagnostics: expect.arrayContaining([{ code: 'metadata_extraction_failed', path: 'rawContent' }]),
      });
    } finally { extract.mockRestore(); }
  });
});
