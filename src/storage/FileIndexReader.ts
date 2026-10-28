import type { DirectoryStateCache, ScanState } from './DirectoryStateCache.js';
import { firstIndexedPath, type IndexedPathResult } from './IStorageLayer.js';
import type { FileStateTable } from './FileStateTable.js';
import type { ManifestDiffResult } from './types.js';

interface FileIndexState extends ScanState {
  table: FileStateTable;
}

function snapshot(state: FileIndexState, names: readonly string[]): IndexedPathResult {
  return {
    path: firstIndexedPath(names, name => state.table.getPathByName(name)),
    indexComplete: state.table.everSucceeded,
    authoritative: state.table.isAuthoritative(),
    unindexed: [...state.table.unindexed().keys()],
  };
}

/** Read lookup and completion evidence together, without consuming pending scan diffs. */
export function readFileIndex<T extends FileIndexState>(
  cache: DirectoryStateCache<T>, state: T, names: readonly string[],
): Promise<IndexedPathResult> {
  return cache.use(state, () => Promise.resolve(snapshot(state, names)));
}

/** Pin a cold bootstrap through its read; warm manifests belong to the invalidation path. */
export function findFileIndexedPath<T extends FileIndexState>(
  cache: DirectoryStateCache<T>, state: T, names: readonly string[], scan: () => Promise<ManifestDiffResult>,
): Promise<string | undefined> {
  if (state.table.everSucceeded) return readFileIndex(cache, state, names).then(result => result.path);
  return cache.scanAndRead(state, scan, () => snapshot(state, names).path);
}
