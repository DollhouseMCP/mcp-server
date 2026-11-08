import { describe, expect, it, jest } from '@jest/globals';
import { ElementListOperations } from '../../../src/elements/base/ElementListOperations.js';
import path from 'node:path';
import { collectionReportNotice } from '../../../src/elements/base/CollectionReport.js';
import { PublicElementDiscovery } from '../../../src/collection/shared-pool/PublicElementDiscovery.js';
import { indexedReadFailure } from '../../../src/elements/base/ElementReadError.js';
import { ValidationError } from '../../../src/security/errors.js';

describe('ElementListOperations.scanAndEvict', () => {
  it('reports shared failures using the discovery-owned root-relative reference', async () => {
    const root = path.resolve('private-portfolio-root');
    const reference = path.join(root, 'shared', 'skills', 'broken.md');
    const discovery = new PublicElementDiscovery(path.join(root, 'shared'), { readElementFile: async () => { throw new Error('Invalid definition'); } } as any);
    jest.spyOn(discovery, 'discoverPublicElements').mockResolvedValue([reference]);
    const operations = new ElementListOperations({ elementType: 'skills' } as any, {} as any,
      { readCollection: async () => ({ entries: [], unindexed: new Map(), authoritative: true, complete: true,
        includesPublic: false, diff: { added: [], modified: [], removed: [], unchanged: [] } }) } as any,
      discovery, undefined);
    const report = await operations.listReport({ includePublic: true });
    expect(report.failures).toEqual([expect.objectContaining({ reference: 'shared/skills/broken.md' })]);
    expect(collectionReportNotice(report)).not.toContain(root);
  });
  it('uses database identifiers directly when evicting writable-storage cache entries', async () => {
    const cache = { uncacheByPath: jest.fn() };
    const storageLayer = {
      cachedInstanceCurrency: 'unverifiable',
      invalidate: jest.fn(),
      scan: jest.fn().mockResolvedValue({
        added: [],
        modified: ['modified-uuid'],
        removed: ['removed-uuid'],
        unchanged: [],
      }),
      writeContent: jest.fn(),
      deleteContent: jest.fn(),
      readContent: jest.fn(),
    };
    const operations = new ElementListOperations(
      { elementDir: '/portfolio/skills' } as any,
      cache as any,
      storageLayer as any,
      undefined,
      undefined,
    );

    await operations.scanAndEvict({ freshAfterInFlight: true });

    expect(storageLayer.invalidate).toHaveBeenCalledTimes(1);
    expect(storageLayer.scan).toHaveBeenCalledWith({ freshAfterInFlight: true });
    expect(cache.uncacheByPath.mock.calls).toEqual([
      ['modified-uuid'],
      ['removed-uuid'],
    ]);
  });
});

describe('ElementListOperations failed records', () => {
  it('reports a failed record with the same classified reason a direct load of it gives', async () => {
    const failure = { name: 'ValidationError', reason: 'Path traversal detected', candidateNames: ['v1-2'], unattributed: true };
    const operations = new ElementListOperations({ elementType: 'skills' } as any,
      { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any,
      { readCollection: async () => ({ entries: [], unindexed: new Map([['v1..2.md', failure]]), authoritative: true, complete: false,
        includesPublic: false, diff: { added: [], modified: [], removed: [], unchanged: [] } }) } as any, undefined, undefined);
    const report = await operations.listReport();
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ reference: 'v1..2.md', candidateNames: ['v1-2'] });
    expect(report.failures[0].error).toMatchObject({ kind: 'unreadable', failures: [{ reference: 'v1..2.md', reason: 'Path traversal detected' }] });
    expect(report.failures[0].error.message).toBe(indexedReadFailure('v1..2.md', failure).message);
  });
});

describe('ElementListOperations load-time refusals', () => {
  it('keeps survivors when one stored definition is refused by the path validator at load time', async () => {
    const rejection = new ValidationError('Invalid skill path: Path traversal detected');
    const load = jest.fn(async (reference: string) => {
      if (reference === 'v1..2.md') throw rejection;
      return { metadata: { name: reference === 'healthy.md' ? 'Healthy' : reference } };
    });
    const operations = new ElementListOperations({ elementType: 'skills', load } as any,
      { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any,
      { readCollection: async () => ({ entries: [{ filePath: 'healthy.md', name: 'Healthy' }, { filePath: 'v1..2.md', name: 'Traversal' }],
        unindexed: new Map(), authoritative: true, complete: true, includesPublic: false,
        diff: { added: [], modified: [], removed: [], unchanged: [] } }) } as any, undefined, undefined);
    const report = await operations.listReport();
    expect(report.items.map(item => item.metadata.name)).toEqual(['Healthy']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ reference: 'v1..2.md', elementName: 'Traversal' });
    expect(report.failures[0].error).toMatchObject({ kind: 'unreadable', failures: [{ reference: 'v1..2.md', reason: 'Invalid skill path: Path traversal detected' }] });
    await expect(operations.list()).rejects.toMatchObject({ kind: 'indeterminate', failures: [expect.objectContaining({ reference: 'v1..2.md' })] });
  });
});
