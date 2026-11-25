import { evictChangedReferences, type ElementCache } from './ElementCache.js';
import type { IElement } from '../../types/elements/IElement.js';
import path from 'node:path';
import type { IStorageLayer, UnindexedEntry } from '../../storage/IStorageLayer.js';
import { couldHoldElementName, resolveNamedCandidateAmong, type NamedCandidate } from '../../storage/ElementNameKeys.js';
import { ElementIndeterminateError, READ_FAILURE_REASONS, ambiguousNameError, indexedReadFailure, type ElementReadFailure } from './ElementReadError.js';

export { couldHoldElementName, type NamedCandidate } from '../../storage/ElementNameKeys.js';

/**
 * The reads name evidence needs. A manager passes its evicting source (ElementListOperations
 * readCollectionEvicting), so a collection snapshot read for evidence always evicts what it found
 * changed; no caller can read a collection and drop its diff.
 */
export type NameEvidenceSource = Pick<IStorageLayer, 'readIndexedPath' | 'readCollection' | 'callerNames'>;

/** The names a caller text addresses in this storage layer: the text, plus any the layer adds. */
export function callerNamesOf(storage: Pick<IStorageLayer, 'callerNames'>, text: string): readonly string[] {
  return storage.callerNames?.(text) ?? [text];
}

/** Name evidence whose collection snapshots evict their diff through the cache's one eviction rule. */
export function evictingNameEvidence(storage: NameEvidenceSource, cache: Pick<ElementCache<IElement>, 'uncacheByPath'>): NameEvidenceSource {
  return {
    readIndexedPath: (names, options) => storage.readIndexedPath(names, options),
    callerNames: text => callerNamesOf(storage, text),
    readCollection: async options => {
      const snapshot = await storage.readCollection(options);
      evictChangedReferences(cache, snapshot.diff);
      return snapshot;
    },
  };
}

/** Select healthy metadata; filename evidence alone cannot establish its name. */
export function selectNamedCandidate<T extends NamedCandidate>(identifier: string, candidates: readonly T[],
  names: readonly string[] = [identifier]): T | undefined {
  const { selected, competitors } = resolveNamedCandidateAmong(names, candidates);
  if (competitors.length === 0) return selected;
  throw ambiguousNameError(competitors.map(candidate => candidate.reference));
}

export interface CertifiedReference<T extends NamedCandidate = NamedCandidate> {
  /** The one healthy entry the identifier selects, or undefined when absence is certified. */
  selected: T | undefined;
  path: string | undefined;
  authoritative: boolean;
  failures: ReadonlyMap<string, UnindexedEntry>;
}

/**
 * The single certification step over one set of evidence: select, then certify an exact reference
 * against its own evidence, or a name against every failed record that could hold it. Refuse an
 * absence claim that an unattributed failure could contradict.
 * Every consumer that answers a name, warm or cold, on either backend, goes through it.
 */
export function certifyNamedCandidate<T extends NamedCandidate>(identifier: string, candidates: readonly T[],
  authoritative: boolean, failures: ReadonlyMap<string, UnindexedEntry>, names: readonly string[] = [identifier]): CertifiedReference<T> {
  const selected = selectNamedCandidate(identifier, candidates, names);
  if (selected?.reference === identifier) {
    assertExactReferenceEvidence(identifier, authoritative, failures);
  } else {
    assertNamedReadEvidence(identifier, authoritative, failures, !selected);
  }
  return { selected, path: selected?.reference, authoritative, failures };
}

/**
 * One selector on every path: certify a name against the warm index when it is authoritative,
 * otherwise against one pinned collection snapshot. Ambiguity throws; absence is certified from
 * the selection and the failed-record evidence, identically on both branches. The source's
 * collection read evicts what the cold snapshot reports changed or removed.
 */
export async function certifyNamedReference(storage: NameEvidenceSource, identifier: string):
  Promise<CertifiedReference & { fromCollection: boolean }> {
  const evidence = await namedEvidence(storage, identifier);
  return { ...certifyNamedCandidate(identifier, evidence.candidates, evidence.authoritative, evidence.failures,
    callerNamesOf(storage, identifier)), fromCollection: evidence.fromCollection };
}

/** A failed record that could hold the name, carrying whether its content was rejected (typed provenance). */
function recordFailure(reference: string, failure: UnindexedEntry): ElementReadFailure {
  return { reference, reason: READ_FAILURE_REASONS.recordFailed, ...(failure.contentRejected ? { contentRejected: true as const } : {}) };
}

/**
 * Whether a new element may take this name, on the same evidence as a lookup: the stored name of the
 * definition that already holds it, or undefined when it is free. The name is taken when
 * the selector chooses a stored definition for it (by any tier), and indeterminate when a failed
 * definition could hold it by its own attribution (its filename or last indexed name) or the
 * evidence is not authoritative. A failed definition that could never hold the name does not block
 * the create, as it does not block a read by another name. Availability ranks the text alone: a new
 * name is ranked as written, and the storage layer's caller names (a stripped extension) only pick
 * which taken row the refusal names, so it names the row a read of that text selects.
 */
export async function nameTakenBy(storage: NameEvidenceSource, identifier: string): Promise<string | undefined> {
  const { candidates, authoritative, failures } = await namedEvidence(storage, identifier);
  const holding = [...failures].filter(([reference, failure]) => !reference
    || couldHoldElementName(reference, failure.candidateNames, identifier));
  if (!authoritative || holding.length) {
    throw new ElementIndeterminateError('Element identity could not be determined', {
      failures: holding.map(([reference, failure]) => recordFailure(reference, failure)),
    });
  }
  // Availability ranks the new name as written (a name is not caller text, so no caller names
  // apply, as on files). A taken name is reported as the row a read of the same text selects.
  const taken = selectNamedCandidate(identifier, candidates);
  if (!taken) return undefined;
  const names = callerNamesOf(storage, identifier);
  if (names.length === 1) return taken.name;
  try {
    return (selectNamedCandidate(identifier, candidates, names) ?? taken).name;
  } catch (error) {
    if (error instanceof ElementIndeterminateError && error.ambiguous) return taken.name;
    throw error;
  }
}

/** The warm index when it is authoritative, otherwise one pinned collection snapshot. */
async function namedEvidence(storage: NameEvidenceSource, identifier: string): Promise<{ candidates: NamedCandidate[];
  authoritative: boolean; failures: ReadonlyMap<string, UnindexedEntry>; fromCollection: boolean }> {
  const indexed = await storage.readIndexedPath([identifier]);
  if (indexed.authoritative) return { candidates: [...indexed.candidates], authoritative: true, failures: indexed.failures, fromCollection: false };
  const snapshot = await storage.readCollection();
  // The pinned summaries remain valid evidence even when their idle directory state was evicted.
  return { candidates: snapshot.entries.map(entry => ({ reference: entry.filePath, name: entry.name })),
    authoritative: snapshot.authoritative, failures: snapshot.unindexed, fromCollection: true };
}

/**
 * A definition read outside the index is accepted only when the selector would choose it for the
 * identifier, by any of the names the identifier addresses.
 */
export function acceptsLoadedDefinition(identifier: string, reference: string, name: string,
  names: readonly string[] = [identifier]): boolean {
  return selectNamedCandidate(identifier, [{ reference, name }], names) !== undefined;
}

/**
 * The one acceptance rule for a definition read from a constructed filename (a reference the index
 * did not certify): the selector chooses it by its own name, or the identifier is that file's own
 * stem and the definition's name derives that same file. The second case keeps a name with no
 * filename characters ('---', stored as 'unnamed.md') addressable as 'unnamed'; any other text
 * that merely derives the same fallback file ('中文', '???') never selects it.
 */
export function acceptsDirectDefinition(identifier: string, reference: string, name: string,
  filenameOf: (name: string) => string, names: readonly string[] = [identifier]): boolean {
  if (acceptsLoadedDefinition(identifier, reference, name, names)) return true;
  // The derived filename is compared with the reference's own filename, so a sub-folder copy matches too.
  return identifier === path.basename(reference, path.extname(reference)) && filenameOf(name) === path.basename(reference);
}

/**
 * Exact-reference evidence: an exact reference is tier 0, so the only evidence that refuses it is
 * the record's own failure or pending state, or a collection-level failure (no reference). A
 * failed or pending sibling never outranks it. Without a per-reference pending set the layer's
 * authority stands for every reference.
 */
export function assertExactReferenceEvidence(reference: string, authoritative: boolean,
  failures: ReadonlyMap<string, UnindexedEntry>, unsettled?: ReadonlySet<string>): void {
  const failure = failures.get(reference);
  if (failure) throw indexedReadFailure(reference, failure);
  const unreferenced = [...failures.keys()].filter(key => !key);
  const pending = unsettled ? unsettled.has(reference) : !authoritative;
  if (pending || unreferenced.length) {
    throw new ElementIndeterminateError('Element identity could not be determined', {
      failures: unreferenced.map(key => ({ reference: key, reason: READ_FAILURE_REASONS.recordFailed })),
    });
  }
}

/**
 * The failed-record evidence a name answer must respect. A failure the storage layer says may stand
 * in for a listed name (UnindexedEntry.shadowsSurvivors, absent = may) refuses any answer for a name
 * it could hold, exactly as it hides that name from a listing; one it says cannot (a never-parsed
 * element file) refuses only an absence claim. So a name the listing shows as current reads by name.
 */
export function assertNamedReadEvidence(identifier: string, authoritative: boolean,
  failures: ReadonlyMap<string, UnindexedEntry>, absent = false): void {
  const matching = [...failures].filter(([reference, failure]) => !reference
    || (absent || failure.shadowsSurvivors !== false) && couldHoldElementName(reference, failure.candidateNames, identifier)
    || absent && failure.unattributed);
  if (!authoritative || matching.length) {
    throw new ElementIndeterminateError('Element identity could not be determined', {
      failures: matching.map(([reference, failure]) => recordFailure(reference, failure)),
    });
  }
}
