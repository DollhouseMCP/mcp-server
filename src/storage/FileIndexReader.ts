import type { DirectoryStateCache, ScanState } from './DirectoryStateCache.js';
import { firstIndexedPath, type IndexedPathResult } from './IStorageLayer.js';
import type { MetadataIndex } from './MetadataIndex.js';
import type { ManifestDiffResult } from './types.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

interface FileIndexState extends ScanState {
  index: MetadataIndex;
  hasScanned: boolean;
}

function snapshot(state: FileIndexState, names: readonly string[]): IndexedPathResult {
  return {
    path: firstIndexedPath(names, name => state.index.getPathByName(UnicodeValidator.normalize(name).normalizedContent)),
    indexComplete: state.hasScanned,
    authoritative: state.lastScanTimestamp > 0,
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
  if (state.hasScanned) return readFileIndex(cache, state, names).then(result => result.path);
  return cache.scanAndRead(state, scan, () => snapshot(state, names).path);
}
