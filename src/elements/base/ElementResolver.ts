/**
 * ElementResolver - Name and storage-reference resolution for element managers.
 *
 * Owns resolveDefinition() (the one name rule: path-shaped refusal, certification, then the
 * constructed filenames on the file backend), findByName(), find() and findMany(). Receives a
 * host for the utilities that stay on BaseElementManager (getElementFilename, the reference
 * validator, load and list).
 */

import { IElement } from '../../types/elements/IElement.js';
import { IStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import { evictChangedReferences, type ElementCache } from './ElementCache.js';
import { ElementMissingError, ElementIndeterminateError, ambiguousNameError, elementReadFailure } from './ElementReadError.js';
import { acceptsDirectDefinition, acceptsLoadedDefinition, callerNamesOf, certifyNamedReference, evictingNameEvidence, type NameEvidenceSource } from './ElementNameEvidence.js';
import { ValidationError } from '../../security/errors.js';
import { PathValidator } from '../../security/pathValidator.js';

/**
 * What caller text addresses: a storage reference, a name, or a name-only lookup (path-shaped text,
 * 'CI/CD Helper' or 'Save 50%25 Now'), which selects only by exact or case-folded name and never by
 * filename.
 */
export type CallerTextKind = 'reference' | 'name' | 'name-only';

/**
 * Host interface: the resolver calls back into BaseElementManager for
 * utilities that stay on the base class.
 */
export interface ElementResolverHost<T extends IElement> {
  /** Read a selected storage reference through the loader; it is never classified as caller text again. */
  loadReference(reference: string): Promise<T>;
  /** The type's places for a filename the index does not hold (memory sub-folders); defaults to the filename. */
  fallbackCandidates?(filename: string): Promise<string[]>;
  list(options?: { includePublic?: boolean }): Promise<T[]>;
  getElementFilename(name: string): string;
  getFileExtension(): string;
  /** Reject caller reference syntax before it is read as a path; the validator's error surfaces directly. */
  validateReference(reference: string): Promise<void>;
  /** The shared caller-text classifier: refuses path syntax that is not a storage reference, before any lookup. */
  classifyCallerText(text: string): Promise<CallerTextKind>;
  /** Rescan the collection, evicting what changed: a selection the index made has proven stale. */
  refreshStaleIndex(): Promise<void>;
}

/** The one definition a name selects, with the storage reference it was read from. */
export interface ResolvedDefinition<T> {
  reference: string;
  definition: T;
}

export class ElementResolver<T extends IElement> {
  constructor(
    private readonly host: ElementResolverHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly storageLayer: IStorageLayer,
    /** The manager's evicting name-evidence source: a cold snapshot evicts what it saw change. */
    private readonly nameEvidence: NameEvidenceSource = evictingNameEvidence(storageLayer, cache),
  ) {}

  /**
   * `refreshed` is the caller's word that it refreshed this collection in the same call (an
   * enforcement scan, a policy refresh); a miss is then answered without observing it again.
   */
  async findByName(identifier: string, options: { refreshed?: boolean } = {}): Promise<T | undefined> {
    return (await this.resolveDefinition(identifier, undefined, options))?.definition;
  }

  /**
   * Resolve a name or storage reference without loading the collection. The shared caller-text
   * classifier refuses path syntax that is not a storage reference first, bare, on both backends,
   * before any read and whatever the index holds. Everything else may be a stored name ('..',
   * 'Q&A', 'My Skill') or an exact reference and certifies through the index first; on the file
   * backend a certified miss then tries the constructed filenames, slug first, then the raw form.
   * A definition that vanished before it loaded (ENOENT) is absent. Every read is classified.
   *
   * `load` is the one definition read of the call; by default the cached instance or a
   * cache-publishing load, a caller needing fresh bytes (recovery) supplies its own.
   */
  async resolveDefinition(identifier: string, load?: (reference: string) => Promise<T>,
    options: { refreshed?: boolean } = {}): Promise<ResolvedDefinition<T> | undefined> {
    const kind = await this.host.classifyCallerText(identifier);
    const read = load ?? ((reference: string) => this.host.loadReference(reference));
    const first = await this.readSelection(identifier, read, options.refreshed);
    if (first?.resolved) return first.resolved;
    if (first) {
      // The selected definition went, or now carries another name: the index is stale. It is
      // rescanned once and the name certified again; a selection that still does not hold is refused.
      await this.classified(identifier, () => this.host.refreshStaleIndex());
      const second = await this.readSelection(identifier, read, true);
      if (second?.resolved) return second.resolved;
      if (second?.mismatched) {
        throw new ElementIndeterminateError('Element identity could not be determined', {
          failures: [{ reference: second.reference, reason: 'Stored definition does not carry the requested name' }],
        });
      }
    }
    // Absence is certified by the index; on the file backend a not-yet-indexed file may still answer,
    // except for a separated name, which is never turned into a filename.
    if (isWritableStorageLayer(this.storageLayer) || kind === 'name-only') return undefined;
    const candidates = await this.directLoadCandidates(identifier);
    return this.classified(identifier, () => this.loadAccepted(identifier, candidates, read));
  }

  /**
   * The filenames a certified-absent name could still be stored under: the slug form always; the
   * raw form only when it is valid reference syntax (a display name with characters the reference
   * policy refuses simply has no raw file).
   */
  private async directLoadCandidates(identifier: string): Promise<string[]> {
    const filenames = await this.directFilenames(identifier);
    // Each filename may live where the type keeps unindexed definitions (memory sub-folders).
    const expanded = await Promise.all(filenames.map(filename =>
      this.host.fallbackCandidates?.(filename) ?? Promise.resolve([filename])));
    return [...new Set(expanded.flat())];
  }

  private async directFilenames(identifier: string): Promise<string[]> {
    const slug = this.host.getElementFilename(identifier);
    const direct = this.directReference(identifier);
    // A raw form that is path syntax ('C:alpha.md') can only address a location: never read it.
    if (direct === slug || PathValidator.isPathSyntax(direct, this.host.getFileExtension())) return [slug];
    try {
      await this.host.validateReference(direct);
      return [slug, direct];
    } catch (error) {
      if (error instanceof ValidationError) return [slug];
      throw error;
    }
  }

  private async classified<R>(identifier: string, read: () => R | Promise<R>): Promise<R> {
    try {
      return await read();
    } catch (cause) {
      throw elementReadFailure(cause, identifier);
    }
  }

  private async loadOrAbsent(reference: string, load: (reference: string) => Promise<T>): Promise<T | undefined> {
    try {
      return await load(reference);
    } catch (error) {
      if (!(error instanceof ElementMissingError)) throw error;
      return undefined;
    }
  }

  private directReference(identifier: string): string {
    const extension = this.host.getFileExtension();
    return identifier.endsWith(extension) ? identifier : `${identifier}${extension}`;
  }

  /**
   * Read the definition the index selects for the text: undefined when it selects none; the
   * resolved definition when the read carries the selected name; otherwise the stale selection,
   * with whether its read carried another name (true) or found nothing (false).
   */
  private async readSelection(identifier: string, read: (reference: string) => Promise<T>, rescanned = false):
    Promise<{ resolved?: ResolvedDefinition<T>; reference: string; mismatched: boolean } | undefined> {
    const certified = await this.certifiedSelection(identifier, rescanned);
    if (!certified) return undefined;
    const { reference } = certified;
    const definition = await this.classified(identifier, () => this.loadOrAbsent(reference, read));
    // The read must carry the name the index selected it for; anything else is never returned.
    if (definition && acceptsLoadedDefinition(identifier, reference, definition.metadata.name,
      callerNamesOf(this.storageLayer, identifier))) {
      return { resolved: { reference, definition }, reference, mismatched: false };
    }
    return { reference, mismatched: definition !== undefined };
  }

  /**
   * The certified selection for the text, by every name the storage layer says it addresses.
   * Before a miss answered from the warm index is returned, the storage layer observes its
   * collection once, as a listing would (observeCollectionChange): rows it applied are evicted
   * through the one eviction rule, and if it saw a change the text is certified once more from a
   * fresh read. On an unchanged observation the miss is answered from the warm index, as beta did:
   * the observation only finds changes and is not proof of absence. A miss certified from a
   * collection read in this call, or just after a rescan, is not observed again.
   */
  private async certifiedSelection(identifier: string, rescanned = false): Promise<{ reference: string } | undefined> {
    const first = await this.classified(identifier, () => this.certifyName(identifier));
    if (first.selected) return { reference: first.selected.reference };
    if (rescanned || first.fromCollection) return undefined;
    const observed = await this.classified(identifier, async () => await this.storageLayer.observeCollectionChange?.());
    if (observed?.diff) evictChangedReferences(this.cache, observed.diff);
    if (!observed?.changed) return undefined;
    const second = await this.classified(identifier, () => this.certifyName(identifier));
    return second.selected ? { reference: second.selected.reference } : undefined;
  }

  /** One selector on both branches; the evidence source evicts what a cold snapshot reports changed. */
  private certifyName(identifier: string) {
    return certifyNamedReference(this.nameEvidence, identifier);
  }

  /**
   * Every fallback candidate is read; the one the acceptance rule accepts is the answer. Several
   * accepted (two separator-only memories in different folders, both deriving 'unnamed.yaml') are
   * the shared selector's tie: ambiguous, never the first one found.
   */
  private async loadAccepted(identifier: string, candidates: readonly string[],
    load: (reference: string) => Promise<T>): Promise<ResolvedDefinition<T> | undefined> {
    // The candidates are few (the slug and raw filenames, and a memory's folders), so they are read together.
    const definitions = await Promise.all(candidates.map(reference => this.loadOrAbsent(reference, load)));
    const accepted = candidates.flatMap((reference, index) => {
      const definition = definitions[index];
      return definition && acceptsDirectDefinition(identifier, reference, definition.metadata.name,
        name => this.host.getElementFilename(name)) ? [{ reference, definition }] : [];
    });
    if (accepted.length > 1) {
      throw ambiguousNameError(accepted.map(({ reference }) => reference));
    }
    return accepted[0];
  }

  /**
   * Find an element by predicate (full list scan).
   */
  async find(predicate: (element: T) => boolean): Promise<T | undefined> {
    const elements = await this.host.list();
    return elements.find(predicate);
  }

  /**
   * Find multiple elements by predicate (full list scan).
   */
  async findMany(predicate: (element: T) => boolean): Promise<T[]> {
    const elements = await this.host.list();
    return elements.filter(predicate);
  }
}
