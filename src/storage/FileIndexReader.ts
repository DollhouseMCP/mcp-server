import type { DirectoryStateCache, ScanState } from './DirectoryStateCache.js';
import { firstIndexedPath, type IndexedPathResult } from './IStorageLayer.js';
import type { FileStateTable } from './FileStateTable.js';
import type { ElementIndexEntry } from './types.js';

interface FileIndexState extends ScanState {
  table: FileStateTable;
}

type CandidateEntries = () => readonly ElementIndexEntry[];

function snapshot(state: FileIndexState, names: readonly string[], candidates: CandidateEntries): IndexedPathResult {
  return {
    path: firstIndexedPath(names, name => state.table.getPathByName(name)),
    indexComplete: state.table.everSucceeded,
    authoritative: state.table.isAuthoritative(),
    unindexed: [...state.table.unindexed().keys()],
    failures: state.table.unindexed(),
    candidates: candidates().map(entry => ({ reference: entry.filePath, name: entry.name })),
  };
}

/** Read lookup, candidate and completion evidence together, without consuming pending scan diffs. */
export function readFileIndex<T extends FileIndexState>(
  cache: DirectoryStateCache<T>, state: T, names: readonly string[], candidates: CandidateEntries,
): Promise<IndexedPathResult> {
  return cache.use(state, () => Promise.resolve(snapshot(state, names, candidates)));
}
