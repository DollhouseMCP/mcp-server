/**
 * Unit tests for ElementStorageLayer
 */

import path from 'node:path';
import { MAX_CACHED_DIRECTORY_STATES } from '../../../src/storage/DirectoryStateCache.js';
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import type { IStorageBackend } from '../../../src/storage/IStorageBackend.js';
import type { StorageItemMetadata } from '../../../src/storage/types.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';

function makeMeta(relPath: string, mtimeMs: number, sizeBytes = 100): StorageItemMetadata {
  return { relativePath: relPath, absolutePath: `/elements/${relPath}`, mtimeMs, sizeBytes };
}

function makeContent(name: string, description = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\nauthor: test\n---\nContent of ${name}`;
}

function createMockBackend(overrides: Partial<IStorageBackend> = {}): IStorageBackend {
  return {
    listDirectories: jest.fn<any>().mockResolvedValue([]),
    listFiles: jest.fn<any>().mockResolvedValue([]),
    stat: jest.fn<any>().mockResolvedValue(makeMeta('test.md', 1000)),
    statMany: jest.fn<any>().mockResolvedValue({ stats: new Map(), failures: new Map() }),
    readFile: jest.fn<any>().mockResolvedValue(makeContent('Test')),
    directoryExists: jest.fn<any>().mockResolvedValue(true),
    ...overrides,
  };
}

const dummyFileOps = {} as FileOperationsService;

describe('ElementStorageLayer', () => {
  let backend: IStorageBackend;
  let layer: ElementStorageLayer;

  beforeEach(() => {
    backend = createMockBackend({
      listFiles: jest.fn<any>().mockResolvedValue(['alpha.md', 'beta.md']),
      statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
        ['beta.md', makeMeta('beta.md', 2000)],
      ]), failures: new Map() }),
      readFile: jest.fn<any>().mockImplementation((absPath: string) => {
        if (absPath.includes('alpha')) return Promise.resolve(makeContent('Alpha', 'Alpha desc'));
        if (absPath.includes('beta')) return Promise.resolve(makeContent('Beta', 'Beta desc'));
        return Promise.resolve(makeContent('Unknown'));
      }),
    });

    layer = new ElementStorageLayer(dummyFileOps, {
      elementDir: '/elements',
      fileExtension: '.md',
      scanCooldownMs: 100,
      storageBackend: backend,
    });
  });

  it('reads cold index status without scanning', async () => {
    expect(await layer.readIndexedPath(['Alpha'])).toMatchObject({ path: undefined, indexComplete: false, authoritative: false, unindexed: [] });
    expect(backend.statMany).not.toHaveBeenCalled();
    await layer.scan();
    expect(await layer.readIndexedPath(['Alpha'])).toMatchObject({ path: 'alpha.md', indexComplete: true, authoritative: true, unindexed: [] });
  });

  it.each([false, true])('leaves warm modified diffs for refresh (invalidated: %s)', async invalidate => {
    await layer.scan();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['alpha.md', makeMeta('alpha.md', 3000)],
        ['beta.md', makeMeta('beta.md', 2000)],
      ]), failures: new Map() });
      if (invalidate) layer.invalidate();
      expect(await layer.readIndexedPath(['Alpha'])).toMatchObject({ path: 'alpha.md', indexComplete: true, authoritative: !invalidate });
      const diff = await layer.scan();
      expect(diff.modified).toContain('alpha.md');
    } finally {
      clock.mockRestore();
    }
  });

  describe('cold start scan', () => {
    it('should populate index with all files on first scan', async () => {
      const diff = await layer.scan();

      expect(diff.added).toEqual(['alpha.md', 'beta.md']);
      expect(diff.modified).toEqual([]);
      expect(diff.removed).toEqual([]);

      const summaries = await layer.listSummaries();
      expect(summaries).toHaveLength(2);
      expect(summaries.map(s => s.name).sort()).toEqual(['Alpha', 'Beta']);
    });

    it('should make indexed paths available', async () => {
      const paths = await layer.getIndexedPaths();
      expect(paths.sort()).toEqual(['alpha.md', 'beta.md']);
    });
  });

  describe('cooldown behavior', () => {
    it('reports the directory members a collection read finds now, while unchanged members keep the cooldown', async () => {
      await layer.readCollection();
      expect(backend.statMany).toHaveBeenCalledTimes(1);

      // Unchanged membership inside the cooldown: one enumeration, no re-stat of the members.
      expect((await layer.readCollection()).entries.map(entry => entry.filePath).sort()).toEqual(['alpha.md', 'beta.md']);
      expect(backend.statMany).toHaveBeenCalledTimes(1);

      // A member removed outside this layer leaves the very next collection read.
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['beta.md']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([['beta.md', makeMeta('beta.md', 2000)]]), failures: new Map() });
      const removed = await layer.readCollection();
      expect(removed.entries.map(entry => entry.filePath)).toEqual(['beta.md']);
      expect(removed.diff.removed).toEqual(['alpha.md']);

      // A member added outside this layer joins it.
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['alpha.md', 'beta.md']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)], ['beta.md', makeMeta('beta.md', 2000)],
      ]), failures: new Map() });
      expect((await layer.readCollection()).entries.map(entry => entry.filePath).sort()).toEqual(['alpha.md', 'beta.md']);
    });

    it('keeps concurrent collection reads authoritative when both observe the same membership change', async () => {
      await layer.readCollection();
      const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
      // The second reader's enumeration settles while the first reader's scan is still statting.
      let enumerations = 0;
      (backend.listFiles as jest.Mock<any>).mockImplementation(() => later(++enumerations === 2 ? 20 : 0, ['beta.md']));
      (backend.statMany as jest.Mock<any>).mockImplementation(() => later(40, {
        stats: new Map([['beta.md', makeMeta('beta.md', 2000)]]), failures: new Map() }));

      const snapshots = await Promise.all([layer.readCollection(), layer.readCollection()]);

      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({ authoritative: true, complete: true });
        expect(snapshot.entries.map(entry => entry.filePath)).toEqual(['beta.md']);
      }
      expect((await layer.readIndexedPath(['Beta'])).authoritative).toBe(true);
    });

    it('answers a collection read from the scan it began when a change is signalled during that scan', async () => {
      await layer.readCollection();
      layer.invalidate();
      const stats = { stats: new Map([['alpha.md', makeMeta('alpha.md', 1000)], ['beta.md', makeMeta('beta.md', 2000)]]), failures: new Map() };
      (backend.statMany as jest.Mock<any>).mockImplementationOnce(() => {
        layer.invalidate();
        return Promise.resolve(stats);
      });

      const snapshot = await layer.readCollection();

      expect(snapshot).toMatchObject({ authoritative: true, complete: true });
      expect(snapshot.entries.map(entry => entry.name).sort((a, b) => a.localeCompare(b))).toEqual(['Alpha', 'Beta']);
      expect((await layer.readIndexedPath(['Beta'])).authoritative).toBe(false);
    });

    it('should return empty diff within cooldown period', async () => {
      await layer.scan(); // first scan
      const secondDiff = await layer.scan(); // within cooldown

      expect(secondDiff.added).toEqual([]);
      expect(secondDiff.modified).toEqual([]);
      expect(secondDiff.removed).toEqual([]);
      expect(secondDiff.unchanged).toEqual([]);

      // Backend should only have been called once
      expect(backend.listFiles).toHaveBeenCalledTimes(1);
    });

    it('should scan again after cooldown expires', async () => {
      // Use a very short cooldown
      const shortLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        scanCooldownMs: 1,
        storageBackend: backend,
      });

      await shortLayer.scan();

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 10));

      await shortLayer.scan();

      expect(backend.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidate', () => {
    it('should force next scan to hit disk', async () => {
      await layer.scan();
      layer.invalidate();
      await layer.scan();

      expect(backend.listFiles).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent scan deduplication', () => {
    it('should coalesce concurrent scan calls', async () => {
      const [diff1, diff2, diff3] = await Promise.all([
        layer.scan(),
        layer.scan(),
        layer.scan(),
      ]);

      // All three should get the same result
      expect(diff1).toBe(diff2);
      expect(diff2).toBe(diff3);

      // Backend should only be called once
      expect(backend.listFiles).toHaveBeenCalledTimes(1);
    });

    it('runs one trailing scan for freshness-sensitive callers', async () => {
      await layer.scan();
      layer.invalidate();

      let markOlderScanStarted!: () => void;
      let releaseOlderScan!: () => void;
      const olderScanStarted = new Promise<void>((resolve) => {
        markOlderScanStarted = resolve;
      });
      const olderScanBlocked = new Promise<void>((resolve) => {
        releaseOlderScan = resolve;
      });
      (backend.statMany as jest.Mock<any>)
        .mockImplementationOnce(async () => {
          markOlderScanStarted();
          await olderScanBlocked;
          return { stats: new Map([
            ['alpha.md', makeMeta('alpha.md', 1000)],
            ['beta.md', makeMeta('beta.md', 5000)],
          ]), failures: new Map() };
        })
        .mockResolvedValue({ stats: new Map([
          ['alpha.md', makeMeta('alpha.md', 1000)],
          ['beta.md', makeMeta('beta.md', 5000)],
        ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockImplementation((absPath: string) => {
        if (absPath.includes('alpha')) return Promise.resolve(makeContent('Alpha', 'Alpha desc'));
        if (absPath.includes('beta')) return Promise.resolve(makeContent('Beta Updated', 'New desc'));
        return Promise.resolve(makeContent('Unknown'));
      });

      const olderScan = layer.scan();
      await olderScanStarted;
      const freshScans = [
        layer.scan({ freshAfterInFlight: true }),
        layer.scan({ freshAfterInFlight: true }),
      ];
      releaseOlderScan();
      const [, firstFreshDiff, secondFreshDiff] = await Promise.all([olderScan, ...freshScans]);

      expect(backend.listFiles).toHaveBeenCalledTimes(3);
      expect(firstFreshDiff.modified).toContain('beta.md');
      expect(secondFreshDiff.modified).toContain('beta.md');
      expect(layer.getPathByName('Beta Updated')).toBe('beta.md');
    });
  });

  describe('change detection', () => {
    it('should detect modified files on second scan', async () => {
      await layer.scan();

      // Simulate time passing + mtime change
      await new Promise(resolve => setTimeout(resolve, 10));
      layer.invalidate();

      // Backend now returns modified mtime for beta
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
        ['beta.md', makeMeta('beta.md', 5000)], // changed mtime
      ]), failures: new Map() });
      (backend.readFile as jest.Mock<any>).mockImplementation((absPath: string) => {
        if (absPath.includes('alpha')) return Promise.resolve(makeContent('Alpha', 'Alpha desc'));
        if (absPath.includes('beta')) return Promise.resolve(makeContent('Beta Updated', 'New desc'));
        return Promise.resolve(makeContent('Unknown'));
      });

      const diff = await layer.scan();

      expect(diff.unchanged).toEqual(['alpha.md']);
      expect(diff.modified).toEqual(['beta.md']);

      // Index should reflect the updated name
      const summaries = await layer.listSummaries();
      const betaEntry = summaries.find(s => s.filePath === 'beta.md');
      expect(betaEntry?.name).toBe('Beta Updated');
    });

    it('should detect removed files', async () => {
      await layer.scan();

      await new Promise(resolve => setTimeout(resolve, 10));
      layer.invalidate();

      // Only alpha remains
      (backend.listFiles as jest.Mock<any>).mockResolvedValue(['alpha.md']);
      (backend.statMany as jest.Mock<any>).mockResolvedValue({ stats: new Map([
        ['alpha.md', makeMeta('alpha.md', 1000)],
      ]), failures: new Map() });

      const diff = await layer.scan();

      expect(diff.removed).toEqual(['beta.md']);
      expect(diff.unchanged).toEqual(['alpha.md']);

      const paths = await layer.getIndexedPaths();
      expect(paths).toEqual(['alpha.md']);
    });
  });

  describe('notifySaved', () => {
    it('should update index and manifest for saved file', async () => {
      await layer.scan();

      (backend.stat as jest.Mock<any>).mockResolvedValue(makeMeta('new.md', 9000));
      (backend.readFile as jest.Mock<any>).mockResolvedValue(makeContent('NewElement', 'Fresh'));

      await layer.notifySaved('new.md', '/elements/new.md');

      expect(layer.getPathByName('NewElement')).toBe('new.md');
    });
  });

  describe('notifyDeleted', () => {
    it('should remove entry from index and manifest', async () => {
      await layer.scan();
      expect(layer.getPathByName('Alpha')).toBe('alpha.md');

      layer.notifyDeleted('alpha.md');

      expect(layer.getPathByName('Alpha')).toBeUndefined();
    });
  });

  describe('getPathByName', () => {
    it('should perform case-insensitive lookup', async () => {
      await layer.scan();

      expect(layer.getPathByName('alpha')).toBe('alpha.md');
      expect(layer.getPathByName('ALPHA')).toBe('alpha.md');
      expect(layer.getPathByName('Alpha')).toBe('alpha.md');
    });

    it('should resolve canonical-equivalent Unicode names', async () => {
      const unicodeBackend = createMockBackend({
        listFiles: jest.fn<any>().mockResolvedValue(['cafe.md']),
        statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([
          ['cafe.md', makeMeta('cafe.md', 1000)],
        ]), failures: new Map() }),
        readFile: jest.fn<any>().mockResolvedValue(makeContent('Cafe\u0301', 'Unicode test')),
      });

      const unicodeLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        storageBackend: unicodeBackend,
      });

      await unicodeLayer.scan();

      expect(unicodeLayer.getPathByName('Café')).toBe('cafe.md');
    });

    it('should return undefined for unknown name', () => {
      expect(layer.getPathByName('nonexistent')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should reset all state', async () => {
      await layer.scan();
      layer.clear();

      expect(layer.getPathByName('Alpha')).toBeUndefined();

      // Next scan should re-index everything as added
      const diff = await layer.scan();
      expect(diff.added).toEqual(['alpha.md', 'beta.md']);
    });
  });

  describe('parse failure handling', () => {
    it('should skip files that fail to parse without crashing', async () => {
      const badBackend = createMockBackend({
        listFiles: jest.fn<any>().mockResolvedValue(['good.md', 'bad.md']),
        statMany: jest.fn<any>().mockResolvedValue({ stats: new Map([
          ['good.md', makeMeta('good.md', 1000)],
          ['bad.md', makeMeta('bad.md', 2000)],
        ]), failures: new Map() }),
        readFile: jest.fn<any>().mockImplementation((absPath: string) => {
          if (absPath.includes('bad')) return Promise.reject(new Error('read error'));
          return Promise.resolve(makeContent('Good'));
        }),
      });

      const badLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/elements',
        fileExtension: '.md',
        storageBackend: badBackend,
      });

      const diff = await badLayer.scan();

      expect(diff.added).toEqual(['good.md', 'bad.md']);
      // Only good.md should be in the index
      const paths = await badLayer.getIndexedPaths();
      expect(paths).toEqual(['good.md']);
    });
  });

  describe('reference policy at scan', () => {
    const directory = path.resolve('policy-elements');
    const named = (reference: string, name: string) => ({ reference, name });
    function policyLayer(files: Record<string, string>) {
      const names = Object.keys(files);
      const policyBackend = createMockBackend({
        listFiles: jest.fn<any>().mockResolvedValue(names),
        statMany: jest.fn<any>().mockResolvedValue({ stats: new Map(names.map((file, index) => [file, makeMeta(file, 1000 + index)])), failures: new Map() }),
        readFile: jest.fn<any>().mockImplementation((absPath: string) => Promise.resolve(makeContent(files[path.basename(absPath)]))),
      });
      return { backend: policyBackend, layer: new ElementStorageLayer(dummyFileOps, { elementDir: directory, fileExtension: '.md', storageBackend: policyBackend }) };
    }

    it('audits a definition read through the file service and refuses it under the scan policy', async () => {
      const audit = jest.fn();
      const { backend: readBackend } = policyLayer({ 'healthy.md': 'Healthy' });
      const audited = new ElementStorageLayer({ auditElementRead: audit } as unknown as FileOperationsService,
        { elementDir: directory, fileExtension: '.md', storageBackend: readBackend, elementType: 'skills' });
      expect(await audited.readContent('healthy.md')).toContain('Healthy');
      expect(audit).toHaveBeenCalledWith(path.join(directory, 'healthy.md'), 'skills', 'ElementStorageLayer.readContent');
      await expect(audited.readContent(path.join('..', 'outside.md'))).rejects.toMatchObject({ name: 'ValidationError' });
      expect(audit).toHaveBeenCalledTimes(1);
    });

    it('records a traversal filename as a failed record with the validator reason and keeps the sibling', async () => {
      const { backend: policyBackend, layer: policed } = policyLayer({ 'healthy.md': 'Healthy', 'v1..2.md': 'Traversal' });
      await policed.scan();
      expect(await policed.getIndexedPaths()).toEqual(['healthy.md']);
      // The policy runs before the read, exactly where the loader would refuse the file.
      expect(jest.mocked(policyBackend.readFile).mock.calls.map(([target]) => target)).toEqual([path.join(directory, 'healthy.md')]);
      const refused = await policed.readIndexedPath(['v1-2']);
      expect(refused).toMatchObject({ path: undefined, authoritative: true, unindexed: ['v1..2.md'], candidates: [] });
      expect(refused.failures.get('v1..2.md')).toMatchObject({ name: 'ValidationError', reason: 'Path traversal detected', candidateNames: ['v1-2'], unattributed: true });
      expect(await policed.readIndexedPath(['Healthy'])).toMatchObject({ path: 'healthy.md', candidates: [named('healthy.md', 'Healthy')] });
    });

    it('refuses a stored reference the input sanitiser would rewrite, under its real name', async () => {
      const { backend: policyBackend, layer: policed } = policyLayer({ 'healthy.md': 'Healthy', 'Q&A.md': 'Questions', 'notes(draft).md': 'Draft' });
      await policed.scan();
      expect(await policed.getIndexedPaths()).toEqual(['healthy.md']);
      expect(jest.mocked(policyBackend.readFile).mock.calls.map(([target]) => target)).toEqual([path.join(directory, 'healthy.md')]);
      const refused = await policed.readIndexedPath(['Questions']);
      expect(refused.failures.get('Q&A.md')).toMatchObject({ name: 'ValidationError', reason: expect.stringContaining('not allowed'), candidateNames: ['q-a'] });
      expect(refused.failures.get('notes(draft).md')).toMatchObject({ name: 'ValidationError', candidateNames: ['notes-draft'] });
    });

    it('offers every healthy entry a name could select beside the owner hint', async () => {
      const { layer: duplicates } = policyLayer({ 'first.md': 'Other', 'second.md': 'Other', 'camel.md': 'FooBar' });
      await duplicates.scan();
      expect(await duplicates.readIndexedPath(['Other'])).toMatchObject({ path: 'second.md', candidates: [named('first.md', 'Other'), named('second.md', 'Other')] });
      expect((await duplicates.readIndexedPath(['first.md'])).candidates).toEqual([named('first.md', 'Other')]);
      expect((await duplicates.readIndexedPath(['foo-bar'])).candidates).toEqual([named('camel.md', 'FooBar')]);
      expect((await duplicates.readIndexedPath(['foobar'])).candidates).toEqual([named('camel.md', 'FooBar')]);
      expect((await duplicates.readIndexedPath(['missing', 'Other'])).candidates).toHaveLength(2);
      expect((await duplicates.readIndexedPath(['missing'])).candidates).toEqual([]);
    });
  });

  describe('non-existent directory', () => {
    it('should handle missing directory gracefully', async () => {
      const missingBackend = createMockBackend({
        directoryExists: jest.fn<any>().mockResolvedValue(false),
      });

      const missingLayer = new ElementStorageLayer(dummyFileOps, {
        elementDir: '/missing',
        fileExtension: '.md',
        storageBackend: missingBackend,
      });

      const diff = await missingLayer.scan();

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });
  });
});

describe('bounded directory state', () => {
  it('bounds idle churn, rebuilds evicted directories and retains a flat directory', async () => {
    let dir = '/users/original';
    const backend = createMockBackend();
    const layer = new ElementStorageLayer(dummyFileOps, { elementDir: dir, elementDirResolver: () => dir, fileExtension: '.md', storageBackend: backend });
    const original = layer['getState']();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) await layer.scan();
    expect(layer['dirStates'].size).toBe(1);
    expect(layer['getState']()).toBe(original);
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      dir = `/users/${i}`;
      await layer.scan();
    }
    expect(layer['dirStates'].size).toBe(MAX_CACHED_DIRECTORY_STATES);
    dir = '/users/original';
    expect(layer['getState']()).not.toBe(original);
    await layer.scan();
    expect(layer.hasCompletedScan()).toBe(true);
    const rebuilt = layer['getState']();
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) await layer.scan();
    expect(layer['getState']()).toBe(rebuilt);
  });
  it('pins a scan and its trailing waiter while other directories churn', async () => {
    let dir = '/users/busy';
    let release!: (exists: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { release = resolve; });
    const backend = createMockBackend({ directoryExists: jest.fn<any>().mockImplementation((location: string) => location === '/users/busy' ? waiting : Promise.resolve(false)) });
    const layer = new ElementStorageLayer(dummyFileOps, { elementDir: dir, elementDirResolver: () => dir, fileExtension: '.md', storageBackend: backend });
    const busy = layer['getState']();
    const scan = layer.scan();
    const trailing = layer.scan({ freshAfterInFlight: true });
    for (let i = 0; i < MAX_CACHED_DIRECTORY_STATES + 5; i++) {
      dir = `/users/${i}`;
      await layer.scan();
    }
    dir = '/users/busy';
    expect(layer['getState']()).toBe(busy);
    release(false);
    await Promise.all([scan, trailing]);
    expect(layer['getState']()).toBe(busy);
    expect(layer['dirStates'].size).toBe(MAX_CACHED_DIRECTORY_STATES);
  });
});
