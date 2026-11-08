import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { BaseElementManager } from '../../../src/elements/base/BaseElementManager.js';
import { ElementListOperations } from '../../../src/elements/base/ElementListOperations.js';
import { ElementResolver } from '../../../src/elements/base/ElementResolver.js';
import { ElementPersister } from '../../../src/elements/base/ElementPersister.js';
import { databaseNameCandidates, resolveNamedCandidateAmong } from '../../../src/storage/ElementNameKeys.js';
import { certifyNamedCandidate, selectNamedCandidate } from '../../../src/elements/base/ElementNameEvidence.js';
import { ElementMissingError, ElementReadError, GuardedReadConflict, elementReadFailure, indexedReadFailure } from '../../../src/elements/base/ElementReadError.js';
import { resolveActiveReferenceReport } from '../../../src/elements/base/ActiveReferenceResolver.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { ValidationError } from '../../../src/security/errors.js';
import { PathValidator } from '../../../src/security/pathValidator.js';
import { assertExactReferenceEvidence } from '../../../src/elements/base/ElementNameEvidence.js';
import { normalizeElementStorageIdentity } from '../../../src/utils/filesystem.js';

const element = (name: string) => ({ id: name, metadata: { name } });
const emptyDiff = () => ({ added: [], modified: [], removed: [], unchanged: [] });
const coldIndex = () => ({ authoritative: false, failures: new Map(), unindexed: [], indexComplete: false, candidates: [] });
const fileHost = (load: (filePath: string) => Promise<unknown>) => ({ load, loadReference: load, getElementFilename: (name: string) => `${name}.md`,
  getFileExtension: () => '.md', validateReference: async () => {}, classifyCallerText: async () => 'name' });

/** The manager's classifier as the resolver sees it: path-shaped text meets the validator, then is refused. */
const pathShapedRefused = (validateReference: (reference: string) => Promise<void>) => async (text: string) => {
  if (!PathValidator.isPathShaped(text)) return 'name' as const;
  await validateReference(`${text}.md`);
  throw new ValidationError('Invalid skill reference: elements are addressed by name or storage reference, not by path');
};

describe('honest shared reads', () => {
  it.each([false, true])('does not select a filename-only match (unattributed sibling: %s)', async broken => {
    const load = jest.fn(async () => element('Other'));
    const failures = new Map(broken ? [['broken.md', {
      name: 'Error', reason: 'Invalid definition', candidateNames: ['broken'], unattributed: true,
    }]] : []);
    const storage = {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async () => coldIndex(),
      readCollection: async () => ({ entries: [{ name: 'Other', filePath: 'wanted.md' }],
        unindexed: failures, authoritative: true, complete: !broken, includesPublic: false, diff: emptyDiff() }),
    };
    const resolver = new ElementResolver(fileHost(load) as any, { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any, storage as any);
    if (broken) {
      await expect(resolver.findByName('wanted')).rejects.toMatchObject({ kind: 'indeterminate',
        failures: [expect.objectContaining({ reference: 'broken.md' })] });
      expect(load).not.toHaveBeenCalled();
    } else await expect(resolver.findByName('wanted')).resolves.toBeUndefined();
    await expect(resolver.findByName('Other')).resolves.toEqual(element('Other'));
    await expect(resolver.findByName('wanted.md')).resolves.toEqual(element('Other'));
  });

  it('reads a separator-only name through the fallback storage file both share, and no other name through it', async () => {
    const stored: Record<string, string> = { 'unnamed.md': '---', 'other.md': 'Someone Else' };
    const load = jest.fn(async (reference: string) => {
      if (!stored[reference]) throw new ElementMissingError(reference);
      return element(stored[reference]);
    });
    const host = { ...fileHost(load), getElementFilename: (name: string) => `${normalizeElementStorageIdentity(name)}.md` };
    const storage = {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async () => coldIndex(),
      readCollection: async () => ({ entries: Object.entries(stored).map(([filePath, name]) => ({ name, filePath })),
        unindexed: new Map(), authoritative: true, complete: true, includesPublic: false, diff: emptyDiff() }),
    };
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any, storage as any);

    await expect(resolver.findByName('unnamed')).resolves.toEqual(element('---'));
    await expect(resolver.findByName('---')).resolves.toEqual(element('---'));
    // The file is the requested text's own storage file, but its metadata derives another one.
    await expect(resolver.findByName('other')).resolves.toBeUndefined();
  });

  it.each([
    ['cold', false], ['cold', true], ['warm', false], ['warm', true],
  ])('resolves duplicate metadata only with a matching filename on the %s path (tie-break: %s)', async (path, tieBreak) => {
    const entries = [{ name: 'Other', filePath: tieBreak ? 'other.md' : 'first.md' }, { name: 'Other', filePath: 'second.md' }];
    const load = jest.fn(async () => element('Other'));
    const readCollection = jest.fn(async () => ({ entries, unindexed: new Map(), authoritative: true, complete: true, includesPublic: false, diff: emptyDiff() }));
    // The warm index offers the same candidates the cold snapshot lists; the selector runs on both.
    // Its owner hint names the newest duplicate and must never override the selection, on either path.
    const warmIndex = () => ({ path: 'second.md', authoritative: true, failures: new Map(), unindexed: [], indexComplete: true,
      candidates: entries.map(entry => ({ reference: entry.filePath, name: entry.name })) });
    let reads = 0;
    const readIndexedPath = async () => path === 'warm' || reads++ > 0 ? warmIndex() : coldIndex();
    const resolver = new ElementResolver(fileHost(load) as any, { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any,
      { cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true, readIndexedPath, readCollection } as any);
    if (tieBreak) {
      await expect(resolver.findByName('Other')).resolves.toEqual(element('Other'));
      expect(load).toHaveBeenCalledWith('other.md');
    } else {
      await expect(resolver.findByName('Other')).rejects.toMatchObject({ kind: 'indeterminate', failures: [
        expect.objectContaining({ reference: 'first.md' }), expect.objectContaining({ reference: 'second.md' }),
      ] });
      expect(load).not.toHaveBeenCalled();
    }
    expect(readCollection).toHaveBeenCalledTimes(path === 'warm' ? 0 : 1);
  });

  it.each(['file', 'database'])('selects the metadata slug from warm %s candidates and certifies absence from the selection', async backend => {
    const load = jest.fn(async () => element('Foo Bar'));
    const storage = { ...(backend === 'database' ? { writeContent: jest.fn() } : {}),
      cachedInstanceCurrency: backend === 'database' ? 'unverifiable' : 'currency-check',
      isCachedReferenceCurrent: () => backend !== 'database',
      readIndexedPath: async (names: string[]) => ({ path: undefined, authoritative: true, failures: new Map(), unindexed: [], indexComplete: true,
        candidates: names[0] === 'foo-bar' ? [{ reference: 'row-1', name: 'Foo Bar' }] : [] }),
      readCollection: jest.fn() };
    const resolver = new ElementResolver(fileHost(load) as any, { getCachedByPath: () => undefined } as any, storage as any);
    await expect(resolver.findByName('foo-bar')).resolves.toEqual(element('Foo Bar'));
    expect(load).toHaveBeenCalledWith('row-1');
    // A miss with no attributable failure is proven absence on the warm path (file mode also tries the direct filenames).
    load.mockRejectedValue(new ElementMissingError('missing.md'));
    await expect(resolver.findByName('other')).resolves.toBeUndefined();
    expect(storage.readCollection).not.toHaveBeenCalled();
  });

  it('accepts a direct load only when the selector would choose it for the identifier', async () => {
    const files = new Map([['other.md', element('Other')], ['wanted.md', element('Other')], ['foo-bar.md', element('Foo Bar')]]);
    const load = jest.fn(async (filePath: string) => {
      const found = files.get(filePath);
      if (!found) throw new ElementMissingError('missing.md');
      return found;
    });
    const host = { ...fileHost(load), getElementFilename: (name: string) => `${name.toLowerCase().replaceAll(' ', '-')}.md` };
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined } as any, {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async () => ({ path: undefined, authoritative: true, failures: new Map(), unindexed: [], indexComplete: true, candidates: [] }),
    } as any);
    await expect(resolver.findByName('foo-bar')).resolves.toEqual(element('Foo Bar'));
    await expect(resolver.findByName('Other')).resolves.toEqual(element('Other'));
    // An exact storage reference selects; a filename whose metadata names another element does not.
    await expect(resolver.findByName('wanted.md')).resolves.toEqual(element('Other'));
    await expect(resolver.findByName('wanted')).resolves.toBeUndefined();
  });

  it('checks caller reference syntax only once the index has missed, and lets the validator speak', async () => {
    const rejection = new ValidationError('Invalid skill path: Path traversal detected');
    const load = jest.fn(async (reference: string) => reference === 'dots.md' ? element('..') : (() => { throw new ElementMissingError('missing.md'); })());
    const validateReference = jest.fn(async (reference: string) => { if (/\.\.|%|\s|[&']/.test(reference)) throw rejection; });
    const host = { ...fileHost(load), validateReference, classifyCallerText: pathShapedRefused(validateReference),
      getElementFilename: (name: string) => `${name.toLowerCase().replaceAll(/[\s.]+/g, '-')}.md` };
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined } as any, {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async (names: string[]) => ({ path: undefined, authoritative: true, failures: new Map(), unindexed: [], indexComplete: true,
        candidates: names[0] === '..' ? [{ reference: 'dots.md', name: '..' }]
          : names[0] === 'Q&A' ? [{ reference: 'qa.md', name: 'Q&A' }]
            : names[0] === "Sam's Helper" ? [{ reference: 'helper.md', name: "Sam's Helper" }] : [] }),
    } as any);
    load.mockImplementation(async (reference: string) => {
      if (reference === 'dots.md') return element('..');
      if (reference === 'qa.md') return element('Q&A');
      if (reference === 'helper.md') return element("Sam's Helper");
      throw new ElementMissingError('missing.md');
    });
    // A stored name that is not valid path syntax resolves through the index without any syntax check.
    await expect(resolver.findByName('..')).resolves.toEqual(element('..'));
    await expect(resolver.findByName('Q&A')).resolves.toEqual(element('Q&A'));
    await expect(resolver.findByName("Sam's Helper")).resolves.toEqual(element("Sam's Helper"));
    expect(validateReference).not.toHaveBeenCalled();
    load.mockClear();
    // Text that cannot be a name can only be a reference: its syntax is refused bare, before any direct read.
    await expect(resolver.findByName('../outside')).rejects.toBe(rejection);
    expect(load).not.toHaveBeenCalled();
    // Percent-encoded text is an encoded path, validated as a reference on its own syntax.
    await expect(resolver.findByName('%2e%2e%2fetc')).rejects.toBe(rejection);
    expect(load).not.toHaveBeenCalled();
    // A display name tries its slug file first; a raw form that is not reference syntax simply does not exist.
    await expect(resolver.findByName('Code Reviewer')).resolves.toBeUndefined();
    expect(load.mock.calls.map(([reference]) => reference)).toEqual(['code-reviewer.md']);
    await expect(resolver.findByName('plain')).resolves.toBeUndefined();
    expect(load.mock.calls.at(-1)).toEqual(['plain.md']);
    // Database identifiers have no path syntax.
    const database = new ElementResolver(host as any, { getCachedByPath: () => undefined } as any, { writeContent: jest.fn(),
      cachedInstanceCurrency: 'unverifiable', isCachedReferenceCurrent: () => false,
      readIndexedPath: async () => ({ path: undefined, authoritative: true, failures: new Map(), unindexed: [], indexComplete: true, candidates: [] }) } as any);
    // The same classifier runs on the database: path syntax is refused there too, never certified as a name.
    await expect(database.findByName('../outside')).rejects.toBe(rejection);
  });

  it('refuses a warm absence claim that an unattributed failed sibling could contradict, like the cold path', async () => {
    const load = jest.fn();
    const readCollection = jest.fn();
    const failures = new Map([['broken.md', { name: 'Error', reason: 'Invalid definition', candidateNames: ['broken'], unattributed: true }]]);
    const resolver = new ElementResolver(fileHost(load) as any, { getCachedByPath: () => undefined } as any, {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async () => ({ path: undefined, authoritative: true, failures, unindexed: ['broken.md'], indexComplete: true,
        candidates: [{ reference: 'wanted.md', name: 'Other' }] }),
      readCollection,
    } as any);
    await expect(resolver.findByName('wanted')).rejects.toMatchObject({ kind: 'indeterminate',
      failures: [expect.objectContaining({ reference: 'broken.md' })] });
    expect(load).not.toHaveBeenCalled();
    expect(readCollection).not.toHaveBeenCalled();
    // A selection is still served: the failed sibling could not hold the selected name.
    load.mockResolvedValue(element('Other'));
    await expect(resolver.findByName('Other')).resolves.toEqual(element('Other'));
  });

  it('refuses caller text that cannot be a name on its own syntax, even while a failed sibling leaves names indeterminate', async () => {
    const rejection = new ValidationError('Invalid skill path: Path traversal detected');
    const load = jest.fn();
    const validateReference = jest.fn(async (reference: string) => { if (reference.includes('..') || path.isAbsolute(reference) || reference.includes('%')) throw rejection; });
    const failures = new Map([['broken.md', { name: 'Error', reason: 'Invalid definition', candidateNames: ['broken'], unattributed: true }]]);
    const host = { ...fileHost(load), validateReference, classifyCallerText: pathShapedRefused(validateReference) };
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined } as any, {
      cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true,
      readIndexedPath: async () => ({ path: undefined, authoritative: true, failures, unindexed: ['broken.md'], indexComplete: true, candidates: [] }),
    } as any);
    await expect(resolver.findByName(path.join('..', 'outside'))).rejects.toBe(rejection);
    await expect(resolver.findByName(path.resolve('outside'))).rejects.toBe(rejection);
    await expect(resolver.findByName('wanted')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(load).not.toHaveBeenCalled();
  });

  it('lets a healthy exact reference read beside a failed sibling that could hold its name; only its own failure or a collection failure refuses', () => {
    const sibling = { name: 'Error', reason: 'Invalid definition', candidateNames: ['code-review'], unattributed: true };
    expect(() => assertExactReferenceEvidence('code-review.md', true, new Map([['Code Review.md', sibling]]))).not.toThrow();
    expect(() => assertExactReferenceEvidence('code-review.md', true, new Map([['code-review.md', sibling]]))).toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => assertExactReferenceEvidence('code-review.md', true, new Map([['', { name: 'Error', reason: 'Scan failed', candidateNames: [] }]])))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => assertExactReferenceEvidence('code-review.md', false, new Map())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each(['foo.md', 'e7c57dce-d9ae-4b10-9ec7-2c40e6d858a4'])('certifies selected exact reference %s without weakening name refusals', reference => {
    const candidates = [{ reference, name: 'Foo' }];
    const sibling = { name: 'Error', reason: 'Unreadable', candidateNames: ['Foo', reference] };
    const failures = new Map([['bar.md', sibling]]);
    expect(certifyNamedCandidate(reference, candidates, true, failures).selected).toEqual(candidates[0]);
    expect(() => certifyNamedCandidate('Foo', candidates, true, failures)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A slug-tier candidate must not outrank a failed record that could hold the exact name.
    expect(() => certifyNamedCandidate('Foo', [{ reference: 'other.md', name: 'FOO!' }], true, failures))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => certifyNamedCandidate(reference, candidates, true, new Map([[reference, sibling]])))
      .toThrow(expect.objectContaining({ kind: 'unreadable' }));
    expect(() => certifyNamedCandidate(reference, candidates, true, new Map([['', sibling]])))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => certifyNamedCandidate(reference, candidates, false, new Map()))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('never selects by a blank identifier, even against an element named Unnamed', () => {
    expect(selectNamedCandidate('   ', [{ reference: 'unnamed.md', name: 'Unnamed' }])).toBeUndefined();
    expect(selectNamedCandidate('Unnamed', [{ reference: 'unnamed.md', name: 'Unnamed' }])?.reference).toBe('unnamed.md');
  });

  it('keeps definition discovery unpublished, evicts what its snapshot saw change, and reports incomplete evidence', async () => {
    const cached = element('held');
    const cache = { getCachedByPath: jest.fn(() => cached), uncacheByPath: jest.fn(), cacheElement: jest.fn() };
    const storage = { readCollection: async () => ({ entries: [{ filePath: 'held', name: 'held' }],
      unindexed: new Map([['unknown', { name: 'Error', reason: 'Malformed definition', candidateNames: ['unknown'], unattributed: true }]]), authoritative: true, complete: false,
      includesPublic: false, diff: { ...emptyDiff(), modified: ['held'] } }) };
    const operations = new ElementListOperations({} as any, cache as any, storage as any, undefined, undefined);
    const fresh = element('held');
    const report = await operations.discoverReport(async () => fresh);
    expect(report).toMatchObject({ complete: false, failures: [expect.objectContaining({ reference: 'unknown' })] });
    expect(report.items[0]).toBe(fresh);
    expect(cache.getCachedByPath).not.toHaveBeenCalled();
    // Every collection read evicts its diff (ruling #586 item 3): the changed 'held' instance leaves the cache.
    expect(cache.uncacheByPath.mock.calls).toEqual([['held']]);
    expect(cache.cacheElement).not.toHaveBeenCalled();
  });
  it('preserves admission refusal codes and causes on typed read failures', () => {
    const cause = Object.assign(new Error('Admission required'), { code: 'EMEMORYADMISSION' });
    const error = elementReadFailure(cause, 'owned-memory.yaml');
    expect(error).toBeInstanceOf(ElementReadError);
    expect(error).toMatchObject({ code: 'EMEMORYADMISSION', cause });
  });
  it('keeps summary failures typed and includes failed record evidence', async () => {
    const storage = { readCollection: jest.fn(async () => ({ entries: [],
      unindexed: new Map([['broken.md', { name: 'Error', reason: 'Malformed definition', candidateNames: ['broken'], unattributed: true }]]), authoritative: true, complete: false,
      includesPublic: false, diff: emptyDiff() })) };
    const operations = new ElementListOperations({} as any, {} as any, storage as any, undefined, undefined);
    await expect(operations.listSummaries()).rejects.toThrow('broken.md');
    storage.readCollection.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(operations.listSummaries()).rejects.toBeInstanceOf(ElementReadError);
  });
  it.each(['file', 'database'])('reports a failed item and refuses a plain %s list', async backend => {
    const storage = {
      readCollection: jest.fn(async () => ({ entries: [{ filePath: 'good' }, { filePath: 'bad' }],
        unindexed: new Map(), authoritative: true, complete: true, includesPublic: backend === 'database', diff: emptyDiff() })),
    };
    const host = { load: jest.fn(async (name: string) => {
      if (name === 'bad') throw new Error('read failed');
      return element(name);
    }) };
    const operations = new ElementListOperations(host as any, { getCachedByPath: () => undefined } as any,
      storage as any, undefined, undefined);
    const report = await operations.listReport();
    expect(report.items).toEqual([element('good')]);
    expect(report.complete).toBe(false);
    expect(report.failures[0].reference).toBe('bad');
    await expect(operations.list()).rejects.toBeInstanceOf(ElementReadError);
  });

  it('does not serve a cached older copy when an unindexed record makes its name indeterminate', async () => {
    const cache = { getCachedByPath: jest.fn(() => element('older')), getCachedByAbsolutePath: jest.fn(() => element('older')) };
    const storage = { cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true, readIndexedPath: async () => ({ path: 'older', indexComplete: true, candidates: [{ reference: 'older', name: 'policy-memory' }],
      authoritative: true, unindexed: ['newer'], failures: new Map([['newer', {
        name: 'Error', candidateNames: ['policy-memory'], unattributed: false, reason: 'Invalid definition' }]]) }) };
    const resolver = new ElementResolver(fileHost(jest.fn()) as any, cache as any, storage as any);
    await expect(resolver.findByName('policy-memory')).rejects.toThrow('newer');
    expect(cache.getCachedByPath).not.toHaveBeenCalled();
    expect(cache.getCachedByAbsolutePath).not.toHaveBeenCalled();
  });

  it('uses a complete discovery snapshot even when its directory state cannot be retained', async () => {
    const found = element('Readable');
    const readIndexedPath = jest.fn(async () => coldIndex());
    const host = fileHost(async () => found);
    const readCollection = async () => ({ entries: [{ name: 'Readable', filePath: 'readable.md' }],
      unindexed: new Map(), authoritative: true, complete: true, diff: emptyDiff() });
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined, uncacheByPath: jest.fn() } as any, { cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true, readIndexedPath, readCollection } as any);
    expect(await resolver.findByName('Readable')).toBe(found);
    // The pinned snapshot is selected from directly; no second index read can override the selector.
    expect(readIndexedPath).toHaveBeenCalledTimes(1);
  });

  it.each([ElementType.PERSONA, ElementType.SKILL, ElementType.AGENT, ElementType.ENSEMBLE, ElementType.MEMORY])('visits live %s additions, skips deletions, and checks currency around awaited reads', async type => {
    const references = new Set(['first', 'deleted']);
    const calls: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const manager = Object.create(BaseElementManager.prototype);
    Object.assign(manager, { elementType: type,
      resolveActivationSet: () => references,
      _listOps: { scanAndEvict: async () => { calls.push('scan'); } },
      findByName: async (reference: string) => {
        calls.push(reference);
        if (reference === 'first') { started(); await pending; }
        return element(reference);
      },
    });
    const result = manager.resolveActiveReferences({ assertCurrent: () => calls.push('current') });
    await entered;
    references.delete('deleted');
    references.add('added');
    release();
    expect(await result).toEqual([element('first'), element('added')]);
    expect(calls).toEqual(['current', 'scan', 'current', 'first', 'current', 'current', 'added', 'current', 'current']);
  });

  it('reports a failed scan without attempting lookups and checks currency after failure', async () => {
    const currency = jest.fn();
    const resolve = jest.fn();
    const report = await resolveActiveReferenceReport({ references: new Set(['active']),
      scan: async () => { throw new Error('Scan failed'); }, resolve, assertCurrent: currency });
    expect(report).toMatchObject({ complete: false, items: [], failures: [expect.objectContaining({ reference: 'active', error: expect.any(ElementReadError) })] });
    expect(resolve).not.toHaveBeenCalled();
    expect(currency).toHaveBeenCalledTimes(2);
  });

  it('reports a failed post-lookup callback and still visits the healthy reference', async () => {
    const report = await resolveActiveReferenceReport({ references: new Set(['broken', 'healthy']),
      scan: async () => {}, resolve: async name => element(name),
      afterLookup: async value => { if (value.id === 'broken') throw new Error('State failed'); } });
    expect(report).toMatchObject({ complete: false, items: [element('healthy')],
      failures: [expect.objectContaining({ reference: 'broken' })] });
  });

  it('classifies a validator rejection of a stored reference as unreadable with the validator message', async () => {
    const rejection = new ValidationError('Invalid skill path: Path access denied');
    const report = await resolveActiveReferenceReport({ references: new Set(['outside-symlink']),
      scan: async () => {}, resolve: async () => { throw rejection; } });
    expect(report).toMatchObject({ complete: false, items: [], failures: [expect.objectContaining({
      reference: 'outside-symlink',
      error: expect.objectContaining({ kind: 'unreadable', cause: rejection,
        failures: [{ reference: 'outside-symlink', reason: 'Invalid skill path: Path access denied' }] }),
    })] });
    // The classifier never throws: the stored-vs-caller split is drawn at the public entry points.
    expect(elementReadFailure(rejection, 'v1..2.md')).toMatchObject({ kind: 'unreadable',
      failures: [{ reference: 'v1..2.md', reason: 'Invalid skill path: Path access denied' }] });
    // A validator rejection recorded by the scan keeps its client-safe reason through the index.
    expect(indexedReadFailure('v1..2.md', { name: 'ValidationError', reason: 'Path traversal detected', candidateNames: ['v1-2'], unattributed: true }))
      .toMatchObject({ kind: 'unreadable', failures: [{ reference: 'v1..2.md', reason: 'Path traversal detected' }] });
    expect(indexedReadFailure('bad.md', { name: 'YAMLException', reason: 'bad: [bytes', candidateNames: ['bad'], unattributed: true, contentRejected: true }))
      .toMatchObject({ kind: 'unreadable', failures: [{ reference: 'bad.md', reason: 'Definition content could not be read or validated' }] });
  });

  it('keeps guarded conflicts distinct and checks currency at the rejected lookup boundary', async () => {
    const currency = jest.fn();
    const conflict = new GuardedReadConflict('ESTALE', new Error('revision changed'));
    await expect(resolveActiveReferenceReport({ references: new Set(['active']), scan: async () => {},
      resolve: async () => { throw conflict; }, assertCurrent: currency })).rejects.toBe(conflict);
    expect(currency).toHaveBeenCalledTimes(3);
  });

  it('visits every reference after one lookup fails before refusing the result', async () => {
    const references = new Set(['broken', 'healthy']);
    const visited: string[] = [];
    const manager = Object.create(BaseElementManager.prototype);
    Object.assign(manager, { elementType: ElementType.SKILL,
      resolveActivationSet: () => references, _listOps: { scanAndEvict: async () => {} },
      findByName: async (reference: string) => {
        visited.push(reference);
        if (reference === 'broken') throw new Error('unavailable');
        return element(reference);
      },
    });
    await expect(manager.resolveActiveReferences()).rejects.toBeInstanceOf(ElementReadError);
    expect(visited).toEqual(['broken', 'healthy']);
  });
});

describe('persister name selection', () => {
  const index = (candidates: Array<{ reference: string; name: string }>) =>
    ({ path: candidates.length === 1 ? candidates[0].reference : undefined, authoritative: true, failures: new Map(), unindexed: [], indexComplete: true, candidates });

  it('certifies database existence from the selector, never from the owner hint', async () => {
    const candidates = [{ reference: 'id-1', name: 'Foo' }, { reference: 'id-2', name: 'foo' }];
    const storageLayer = { writeContent: jest.fn(), scan: async () => {}, isExactStorageReference: () => false,
      cachedInstanceCurrency: 'unverifiable', isCachedReferenceCurrent: () => false, readIndexedPath: async () => index(candidates) };
    const persister = new ElementPersister({ host: { extractNameFromPath: (reference: string) => reference, getFileExtension: () => '.md', scanEvicting: async () => {} },
      storageLayer, nameEvidence: storageLayer } as any);
    await expect(persister.exists('FOO')).rejects.toMatchObject({ kind: 'indeterminate', failures: [
      expect.objectContaining({ reference: 'id-1' }), expect.objectContaining({ reference: 'id-2' })] });
    candidates.pop();
    await expect(persister.exists('FOO')).resolves.toBe(true);
    candidates.pop();
    await expect(persister.exists('FOO')).resolves.toBe(false);
  });

  /** A database-layer fake: candidates for every caller name, identity by the ranked shared rule, as the real layer does. */
  const databaseFake = (rows: Array<{ reference: string; name: string }>, asked: string[] = []) => {
    const callerNames = (text: string) => databaseNameCandidates(text, '.md');
    const matches = (name: string, row: { name: string }) => name.toLowerCase() === row.name.toLowerCase();
    return { writeContent: jest.fn(), isExactStorageReference: () => false, cachedInstanceCurrency: 'unverifiable', isCachedReferenceCurrent: () => false, callerNames,
      readIndexedPath: async (names: readonly string[]) => {
        asked.push(...names);
        return index(rows.filter(row => names.some(name => callerNames(name).some(candidate => matches(candidate, row)))));
      },
      resolveContentIdentity: async (_type: string, text: string) => {
        const selected = resolveNamedCandidateAmong(callerNames(text), rows).selected;
        return selected ? { id: selected.reference, name: selected.name } : undefined;
      } };
  };

  it('certifies database existence of caller text as written, never stripped to its last segment', async () => {
    const storageLayer = databaseFake([{ reference: 'id-notes', name: 'Notes' }, { reference: 'id-pros', name: 'Pros // Cons' }]);
    const persister = new ElementPersister({ host: { scanEvicting: async () => {} }, storageLayer, nameEvidence: storageLayer } as any);
    await expect(persister.exists('team/notes')).resolves.toBe(false);
    await expect(persister.exists('Pros // Cons')).resolves.toBe(true);
    await expect(persister.exists('notes.md')).resolves.toBe(true);
  });

  it('reads a database row by the text as written first, its stripped name only when that selects none', async () => {
    const rows = [{ reference: 'id-bare', name: 'readme' }, { reference: 'id-suffixed', name: 'readme.md' }];
    const host = { ...fileHost(async (reference: string) => element(rows.find(row => row.reference === reference)!.name)) };
    const resolver = new ElementResolver(host as any, { getCachedByPath: () => undefined } as any, databaseFake(rows) as any);
    expect((await resolver.findByName('readme.md'))?.metadata.name).toBe('readme.md');
    expect((await resolver.findByName('readme'))?.metadata.name).toBe('readme');
    rows.pop();
    expect((await resolver.findByName('readme.md'))?.metadata.name).toBe('readme');
  });

  it('selects a database row by the text as written first, its stripped name only when that selects none', async () => {
    expect(databaseNameCandidates('readme.md', '.md')).toEqual(['readme.md', 'readme']);
    expect(databaseNameCandidates('team/notes.md', '.md')).toEqual(['team/notes.md']);
    expect(databaseNameCandidates('readme', '.md')).toEqual(['readme']);
    expect(databaseNameCandidates('.md', '.md')).toEqual(['.md']);
    const rows = [{ reference: 'id-bare', name: 'readme' }, { reference: 'id-suffixed', name: 'readme.md' }];
    const asked: string[] = [];
    const storage = databaseFake(rows, asked);
    const persister = new ElementPersister({ host: { scanEvicting: async () => {} }, storageLayer: storage, nameEvidence: storage } as any);
    await expect(persister.exists('readme.md')).resolves.toBe(true);
    // The persister asks with the caller's text; the layer offers the candidates of all its names.
    expect(asked).toEqual(['readme.md']);
    expect(await persister['resolveDatabaseIdentity'](storage, 'readme.md')).toEqual({ identifier: 'readme.md', identity: { id: 'id-suffixed', name: 'readme.md' } });
    rows.pop();
    await expect(persister.exists('readme.md')).resolves.toBe(true);
    expect(await persister['resolveDatabaseIdentity'](storage, 'readme.md')).toEqual({ identifier: 'readme.md', identity: { id: 'id-bare', name: 'readme' } });
  });

  it('targets a file update through the selector and refuses a duplicate name', async () => {
    const candidates = [{ reference: 'first.md', name: 'Foo' }, { reference: 'second.md', name: 'Foo' }];
    const persister = new ElementPersister({
      host: { elementType: ElementType.SKILL, scanAndEvict: async () => {}, getElementFilename: (name: string) => `${name.toLowerCase()}.md`,
        normalizeAndValidatePath: async (reference: string) => ({ relativePath: reference, absolutePath: reference }) },
      storageLayer: { cachedInstanceCurrency: 'currency-check', isCachedReferenceCurrent: () => true, readIndexedPath: async () => index(candidates) },
      nameEvidence: { readIndexedPath: async () => index(candidates) },
      fileLockManager: { withLock: (_key: string, work: () => Promise<unknown>) => work() },
      fileOperations: { stat: async () => ({ dev: 1, ino: 1 }), readElementFile: async () => 'definition bytes' },
    } as any);
    await expect(persister.resolveUpdateTarget('Foo')).rejects.toMatchObject({ kind: 'indeterminate' });
    candidates.splice(0, 2, { reference: 'other.md', name: 'Foo' });
    expect((await persister.resolveUpdateTarget('Foo'))?.path).toBe('other.md');
    candidates.pop();
    expect((await persister.resolveUpdateTarget('Foo'))?.path).toBe('foo.md');
  });
});
