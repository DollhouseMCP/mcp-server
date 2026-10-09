import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { type Dirent } from 'node:fs';
import { mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupDirectoryReadObservers, observeDirectoryReads } from './fixtures/aggregateDirectoryReadObserver.js';

const roots: string[] = [];
afterEach(() => cleanupDirectoryReadObservers(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function previousJestObserver(owner: { read: () => Promise<Dirent | null> }) {
  const original = owner.read, measured = { attemptedReads: 0, completedCensuses: 0 };
  const spy = jest.spyOn(owner, 'read').mockImplementation(async function(this: object) {
    measured.attemptedReads++;
    const entry = await original.call(this);
    if (!entry) measured.completedCensuses++;
    return entry;
  });
  return { measured, restore: () => spy.mockRestore(), histories: () => ({
    calls: spy.mock.calls.length, contexts: spy.mock.contexts.length, instances: spy.mock.instances.length,
    results: spy.mock.results.length, invocationCallOrder: spy.mock.invocationCallOrder.length,
  }) };
}
describe('aggregate directory read observer contract', () => {
  it.each([['jest', 'aggregate'], ['aggregate', 'jest']] as const)(
    'pairs literal histories and exact aggregate outcomes in %s then %s order', async (...order) => {
      const attempts = 4096, cause = new Error('paired read rejection');
      for (const kind of order) {
        let calls = 0, lastEntry: Dirent | null = null;
        const owner = { async read(): Promise<Dirent | null> {
          expect(this).toBe(owner);
          if (++calls === attempts + 2) throw cause;
          lastEntry = calls <= attempts ? { name: String(calls) } as Dirent : null;
          return lastEntry;
        } };
        const original = Object.getOwnPropertyDescriptor(owner, 'read');
        const observer = kind === 'jest' ? previousJestObserver(owner) : observeDirectoryReads(owner);
        try {
          for (let index = 0; index < attempts; index++) expect(await owner.read()).toBe(lastEntry);
          expect(await owner.read()).toBeNull();
          await expect(owner.read()).rejects.toBe(cause);
          expect(observer.measured).toEqual({ attemptedReads: attempts + 2, completedCensuses: 1 });
          if ('histories' in observer) expect(observer.histories()).toEqual({
            calls: attempts + 2, contexts: attempts + 2, instances: attempts + 2,
            results: attempts + 2, invocationCallOrder: attempts + 2,
          });
          else expect(jest.isMockFunction(owner.read)).toBe(false);
        } finally { observer.restore(); }
        expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
      }
    });
  it.each([['jest', 'aggregate'], ['aggregate', 'jest']] as const)(
    'pairs concurrent out-of-order settlements in %s then %s order', async (...order) => {
      for (const kind of order) {
        const entry = { name: 'exact entry' } as Dirent, cause = new Error('exact rejection');
        let calls = 0;
        const pending = Array.from({ length: 4 }, () => {
          let resolve!: (value: Dirent | null) => void, reject!: (cause: unknown) => void;
          const promise = new Promise<Dirent | null>((accept, refuse) => { resolve = accept; reject = refuse; });
          return { promise, resolve, reject };
        });
        const owner = { read() { expect(this).toBe(owner); return pending[calls++].promise; } };
        const original = Object.getOwnPropertyDescriptor(owner, 'read');
        const observer = kind === 'jest' ? previousJestObserver(owner) : observeDirectoryReads(owner);
        const results = Array.from({ length: 4 }, () => owner.read().then(
          value => ({ status: 'fulfilled', value }), failure => ({ status: 'rejected', value: failure })));
        try {
          expect(observer.measured).toEqual({ attemptedReads: 4, completedCensuses: 0 });
          pending[3].reject(undefined); expect((await results[3]).value).toBeUndefined();
          pending[1].resolve(null); expect((await results[1]).value).toBeNull();
          expect(observer.measured.completedCensuses).toBe(1);
          pending[2].reject(cause); expect((await results[2]).value).toBe(cause);
          pending[0].resolve(entry); expect((await results[0]).value).toBe(entry);
          expect((await Promise.all(results)).map(result => result.status))
            .toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected']);
          expect(observer.measured).toEqual({ attemptedReads: 4, completedCensuses: 1 });
          if ('histories' in observer) expect(observer.histories()).toEqual({
            calls: 4, contexts: 4, instances: 4, results: 4, invocationCallOrder: 4,
          });
        } finally {
          for (const value of pending) value.resolve(null);
          await Promise.all(results); observer.restore();
        }
        expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
      }
    });
  it('delegates real directory reads and EOF with the actual receiver and restores the descriptor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aggregate-directory-read-')); roots.push(root);
    await writeFile(path.join(root, 'one'), 'one');
    const directory = await opendir(root), prototype = Object.getPrototypeOf(directory) as object;
    const original = Object.getOwnPropertyDescriptor(prototype, 'read');
    const observer = observeDirectoryReads(prototype);
    try {
      const entry = await directory.read(); expect(entry?.name).toBe('one');
      expect(await directory.read()).toBeNull();
      expect(observer.measured).toEqual({ attemptedReads: 2, completedCensuses: 1 });
    } finally { observer.restore(); await directory.close(); }
    expect(Object.getOwnPropertyDescriptor(prototype, 'read')).toEqual(original);
    observer.restore();
    expect(Object.getOwnPropertyDescriptor(prototype, 'read')).toEqual(original);
  });
  it('retains the exact fulfilled entry and non-default data descriptor', async () => {
    const entry = { name: 'same-entry' } as Dirent;
    const owner = { marker: 'receiver', async read() { expect(this.marker).toBe('receiver'); return entry; } };
    Object.defineProperty(owner, 'read', { ...Object.getOwnPropertyDescriptor(owner, 'read'), enumerable: false });
    const original = Object.getOwnPropertyDescriptor(owner, 'read'), observer = observeDirectoryReads(owner);
    try { expect(await owner.read()).toBe(entry); expect(observer.measured.completedCensuses).toBe(0); }
    finally { observer.restore(); }
    expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
  });
  it.each([{ cause: null }, { cause: undefined }, { cause: 0 }, { cause: new Error('read rejected') }])(
    'counts a rejected read without replacing its cause ($cause)', async ({ cause }) => {
      const owner = { async read(): Promise<Dirent | null> { throw cause; } };
      const original = Object.getOwnPropertyDescriptor(owner, 'read'), observer = observeDirectoryReads(owner);
      try {
        await expect(owner.read()).rejects.toBe(cause);
        expect(observer.measured).toEqual({ attemptedReads: 1, completedCensuses: 0 });
      } finally { observer.restore(); }
      expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
    });
  it('preserves the previous async observer behavior for a synchronous native-style throw', async () => {
    const cause = Object.assign(new Error('closed directory'), { code: 'ERR_DIR_CLOSED' });
    const owner = { read(): Promise<Dirent | null> { throw cause; } }, observer = observeDirectoryReads(owner);
    try {
      let value!: Promise<Dirent | null>;
      expect(() => { value = owner.read(); }).not.toThrow();
      await expect(value).rejects.toBe(cause);
      expect(observer.measured).toEqual({ attemptedReads: 1, completedCensuses: 0 });
    } finally { observer.restore(); }
  });
  it('isolates a pending old read after restore from a new observer and method descriptor', async () => {
    const first = deferred<Dirent | null>(), second = deferred<Dirent | null>(); let calls = 0;
    const owner = { read() { return ++calls === 1 ? first.promise : second.promise; } };
    const original = Object.getOwnPropertyDescriptor(owner, 'read'), old = observeDirectoryReads(owner);
    const pendingOld = owner.read(); old.restore();
    const next = observeDirectoryReads(owner), installed = Object.getOwnPropertyDescriptor(owner, 'read');
    const pendingNext = owner.read();
    try {
      first.resolve(null); expect(await pendingOld).toBeNull();
      expect(old.measured).toEqual({ attemptedReads: 1, completedCensuses: 1 });
      expect(next.measured).toEqual({ attemptedReads: 1, completedCensuses: 0 });
      old.restore(); expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(installed);
      second.resolve(null); expect(await pendingNext).toBeNull();
      expect(next.measured).toEqual({ attemptedReads: 1, completedCensuses: 1 });
    } finally { first.resolve(null); second.resolve(null); next.restore(); await Promise.allSettled([pendingOld, pendingNext]); }
    expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
  });
  it('refuses to clobber a later wrapper or changed descriptor', () => {
    for (const change of ['wrapper', 'descriptor'] as const) {
      const owner = { async read(): Promise<Dirent | null> { return null; } }, observer = observeDirectoryReads(owner);
      const installed = Object.getOwnPropertyDescriptor(owner, 'read')!;
      Object.defineProperty(owner, 'read', change === 'wrapper'
        ? { ...installed, value: async () => null } : { ...installed, enumerable: !installed.enumerable });
      const foreign = Object.getOwnPropertyDescriptor(owner, 'read');
      try {
        expect(() => observer.restore()).toThrow('no longer owns');
        expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(foreign);
      } finally { Object.defineProperty(owner, 'read', installed); observer.restore(); }
    }
  });
  it('restores active wrappers in reverse order before cleanup without canceling a pending read', async () => {
    const pending = deferred<Dirent | null>(), owner = { read: () => pending.promise };
    const original = Object.getOwnPropertyDescriptor(owner, 'read');
    const first = observeDirectoryReads(owner), second = observeDirectoryReads(owner);
    const reading = owner.read(); let cleaned = false;
    await cleanupDirectoryReadObservers(async () => {
      expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original); cleaned = true;
    });
    expect(cleaned).toBe(true);
    expect(first.measured.completedCensuses).toBe(0); expect(second.measured.completedCensuses).toBe(0);
    pending.resolve(null); await reading;
    expect(first.measured.completedCensuses).toBe(1); expect(second.measured.completedCensuses).toBe(1);
    expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
  });
  it('keeps a foreign wrapper and aggregates restoration and original cleanup failures', async () => {
    const owner = { async read(): Promise<Dirent | null> { return null; } };
    const observer = observeDirectoryReads(owner), foreign = async () => null;
    Object.defineProperty(owner, 'read', { ...Object.getOwnPropertyDescriptor(owner, 'read'), value: foreign });
    let cleaned = false;
    const error = await cleanupDirectoryReadObservers(async () => { cleaned = true; throw undefined; })
      .then(() => undefined, cause => cause);
    expect(cleaned).toBe(true); expect(owner.read).toBe(foreign);
    expect(error.errors).toHaveLength(2); expect(error.errors[0].message).toContain('no longer owns');
    expect(error.errors[1]).toBeUndefined();
    expect(() => observer.restore()).toThrow('no longer owns');
  });
  it('retains an original primitive failure when operation-finally restoration also fails', () => {
    const owner = { async read(): Promise<Dirent | null> { return null; } }, observer = observeDirectoryReads(owner);
    const installed = Object.getOwnPropertyDescriptor(owner, 'read')!;
    Object.defineProperty(owner, 'read', { ...installed, value: async () => null });
    try {
      let failure: unknown;
      try { observer.restore({ cause: undefined }); } catch (cause) { failure = cause; }
      expect((failure as AggregateError).errors[0]).toBeUndefined();
      expect((failure as AggregateError).errors[1].message).toContain('no longer owns');
    } finally { Object.defineProperty(owner, 'read', installed); observer.restore(); }
  });
  it('restores in an operation finally while preserving interruption and paired cleanup errors', async () => {
    const cause = new Error('operation interrupted'), cleanup = new Error('close failed');
    const owner = { async read(): Promise<Dirent | null> { return null; } };
    const original = Object.getOwnPropertyDescriptor(owner, 'read');
    const observer = observeDirectoryReads(owner);
    const operation = async () => {
      try { await owner.read(); throw cause; }
      catch (primary) { throw new AggregateError([primary, cleanup], 'operation and cleanup failed'); }
      finally { observer.restore(); }
    };
    const error = await operation().then(() => undefined, failure => failure);
    expect(error.errors).toEqual([cause, cleanup]);
    expect(Object.getOwnPropertyDescriptor(owner, 'read')).toEqual(original);
    expect(observer.measured).toEqual({ attemptedReads: 1, completedCensuses: 1 });
  });
});
