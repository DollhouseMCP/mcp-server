import { FileStateTable, type ScanOutcome } from '../../../src/storage/FileStateTable.js';
import type { ElementIndexEntry } from '../../../src/storage/types.js';

const entry = (filePath = 'a.md', name = 'A', mtimeMs = 1): ElementIndexEntry => ({
  filePath, name, mtimeMs, sizeBytes: 1, description: '', author: '', tags: [], version: '1',
});
const failure = { name: 'Error', code: 'EACCES', reason: 'denied' };
const read = (path = 'a.md', mtime = 1): ScanOutcome => ({ status: 'indexed', entry: entry(path, 'A', mtime), mtimeMs: mtime });
function seed(table: FileStateTable, status: string) {
  if (status !== 'none') table.applySaved('a.md', 1, entry());
  if (status === 'recheck') table.applyAbsent('a.md');
  if (status === 'failed') table.applyFailure('a.md', failure);
}

describe('FileStateTable publication', () => {
  it.each(['none', 'indexed', 'recheck', 'failed'])('classifies every outcome from %s', status => {
    for (const kind of ['indexed', 'failed', 'statFailed', 'absent'] as const) {
      const table = new FileStateTable();
      seed(table, status);
      const token = table.beginScan();
      const outcome: ScanOutcome = kind === 'indexed' ? read('a.md', 2)
        : kind === 'absent' ? { status: kind } : { status: kind, failure };
      const { diff } = table.publishScan(token, new Map([['a.md', outcome]]));
      const expected = { added: [] as string[], modified: [] as string[], removed: [] as string[], unchanged: [] as string[] };
      if (kind === 'absent') {
        if (status === 'indexed' || status === 'recheck') expected.removed.push('a.md');
      } else expected[status === 'none' ? 'added' : 'modified'].push('a.md');
      expect(diff).toEqual(expected);
      expect(table.everSucceeded).toBe(true);
      expect(table.isAuthoritative()).toBe(kind === 'indexed' || kind === 'absent');
    }
  });

  it('reports same-mtime indexed files unchanged', () => {
    const table = new FileStateTable(); seed(table, 'indexed');
    expect(table.publishScan(table.beginScan(), new Map([['a.md', { status: 'unchanged', mtimeMs: 1 }]])).diff.unchanged).toEqual(['a.md']);
  });

  it.each(['saved', 'absent', 'failure', 'deleted'])('live %s wins and reports known-at-first-touch', action => {
    for (const known of [false, true]) {
      const table = new FileStateTable(); if (known) seed(table, 'indexed');
      const token = table.beginScan();
      if (action === 'saved') table.applySaved('a.md', 3, entry('a.md', 'New', 3));
      if (action === 'absent') table.applyAbsent('a.md');
      if (action === 'failure') table.applyFailure('a.md', failure);
      if (action === 'deleted') table.applyDeleted('a.md');
      const result = table.publishScan(token, new Map([['a.md', read('a.md', 1)]]));
      const present = action !== 'deleted' && (action !== 'absent' || known);
      expect(result.diff[known ? 'modified' : 'added']).toEqual(present ? ['a.md'] : []);
      if (action === 'saved') {
        expect(table.getPathByName('New')).toBe('a.md');
        expect(table.get('a.md')).toMatchObject({ recheckPending: true });
        expect(table.persistableSnapshot()?.entries).toEqual([]);
        expect(table.needsScan()).toBe(true);
      }
    }
  });

  it('keeps the first-touch classification across repeated notifications', () => {
    const table = new FileStateTable(); const token = table.beginScan();
    table.applySaved('a.md', 1, entry()); table.applyDeleted('a.md'); table.applySaved('a.md', 1, entry());
    expect(table.publishScan(token, new Map([['a.md', read()]])).diff.added).toEqual(['a.md']);
  });

  it('hydrates unknown paths only and marks skipped cached entries dirty', () => {
    const table = new FileStateTable();
    table.applySaved('a.md', 2, entry('a.md', 'New', 2));
    const token = table.beginScan(); table.applyDeleted('b.md');
    table.hydrate([entry(), entry('b.md', 'B'), entry('c.md', 'C')]);
    expect(table.getPathByName('New')).toBe('a.md'); expect(table.get('b.md')).toBeUndefined();
    expect(table.getPathByName('C')).toBe('c.md'); expect(table.hasUnsavedChanges()).toBe(true);
    table.failScan(token); expect(table.entries()).toHaveLength(2);
    expect(table.persistableSnapshot()).toBeNull(); expect(table.isAuthoritative()).toBe(false);
  });

  it('retains invalidation during scan, bypasses cooldown, and retries failures only on normal cooldown', () => {
    const table = new FileStateTable(); const token = table.beginScan(); table.invalidate();
    table.publishScan(token, new Map([['a.md', read()]])); expect(table.needsScan()).toBe(true);
    table.publishScan(table.beginScan(), new Map([['a.md', { status: 'failed', failure }]]));
    expect(table.needsScan()).toBe(false); expect(table.isAuthoritative()).toBe(false);
    table.applyFailure('a.md', failure); expect(table.needsScan()).toBe(true);
    expect(table.everSucceeded).toBe(true);
  });

  it('drops publication and hydration evidence after clear, without acknowledging old writes', () => {
    const table = new FileStateTable(); table.applySaved('a.md', 1, entry());
    const token = table.beginScan(); table.clear();
    expect(table.publishScan(token, new Map([['a.md', read()]])).diff.added).toEqual([]);
    expect(table.entries()).toEqual([]); expect(table.everSucceeded).toBe(false);
    expect(table.persistableSnapshot()).toBeNull(); table.markPersisted(0); expect(table.hasUnsavedChanges()).toBe(false);
  });

  it('missing directories remove indexed/recheck records but silently discard failed records and never persist', () => {
    const table = new FileStateTable();
    table.applySaved('a.md', 1, entry()); table.applySaved('b.md', 1, entry('b.md', 'B')); table.applyAbsent('b.md');
    table.applyFailure('c.md', failure);
    expect(table.publishMissingDirectory(table.beginScan()).diff.removed.sort()).toEqual(['a.md', 'b.md']);
    expect(table.persistableSnapshot()).toBeNull();
  });

  it('derives duplicate ownership from rank, blocks failed/recheck owners, and agrees with listing', () => {
    const table = new FileStateTable();
    table.applySaved('z.md', 2, entry('z.md', ' A ', 2));
    table.applySaved('a.md', 1, entry('a.md', 'a', 1));
    expect(table.getPathByName('a')).toBe('z.md');
    table.applyFailure('z.md', failure); expect(table.getPathByName('a')).toBeUndefined(); expect(table.ownerEntries()).toEqual([]);
    table.applySaved('a.md', 1, entry('a.md', 'A', 1)); expect(table.getPathByName('A')).toBeUndefined();
    table.applyAbsent('z.md'); expect(table.getPathByName('A')).toBeUndefined();
    table.applyDeleted('z.md'); expect(table.getPathByName('A')).toBe('a.md');
    table.applySaved('z.md', 1, entry('z.md', 'A', 1)); expect(table.getPathByName('A')).toBe('z.md');
    expect(table.ownerEntries().map(value => value.filePath)).toEqual(['z.md']);
  });

  it('acknowledges only the generation actually written', () => {
    const table = new FileStateTable(); table.publishScan(table.beginScan(), new Map([['a.md', read()]]));
    const snapshot = table.persistableSnapshot()!; table.applySaved('b.md', 1, entry('b.md', 'B'));
    table.markPersisted(snapshot.generation); expect(table.hasUnsavedChanges()).toBe(true);
    table.markPersisted(table.persistableSnapshot()!.generation); expect(table.hasUnsavedChanges()).toBe(false);
  });

  it('matches a reference model over deterministic randomized operation sequences', () => {
    const table = new FileStateTable();
    const model = new Map<string, 'indexed' | 'recheck' | 'failed'>();
    let random = 918273;
    for (let step = 0; step < 500; step++) {
      random = (random * 1664525 + 1013904223) >>> 0;
      const path = `${random % 7}.md`; const operation = (random >>> 8) % 6;
      if (operation === 0) { table.applySaved(path, step, entry(path, path, step)); model.set(path, 'indexed'); }
      if (operation === 1) { table.applyAbsent(path); if (model.has(path)) model.set(path, 'recheck'); }
      if (operation === 2) { table.applyFailure(path, failure); model.set(path, 'failed'); }
      if (operation === 3) { table.applyDeleted(path); model.delete(path); }
      if (operation === 4) { table.clear(); model.clear(); }
      if (operation === 5) {
        const before = model.get(path); const outcomes = new Map<string, ScanOutcome>();
        for (const [key, status] of model) {
          outcomes.set(key, status === 'indexed' ? { status: 'unchanged', mtimeMs: table.get(key)!.mtimeMs! } : { status: 'failed', failure });
        }
        outcomes.set(path, read(path, step));
        const diff = table.publishScan(table.beginScan(), outcomes).diff;
        expect(diff[before ? 'modified' : 'added']).toContain(path);
        for (const [key, status] of model) if (status !== 'indexed') model.set(key, 'failed');
        model.set(path, 'indexed');
      }
      expect(table.entries().map(value => value.filePath).sort()).toEqual([...model].filter(([, status]) => status === 'indexed').map(([key]) => key).sort());
      expect([...table.unindexed().keys()].sort()).toEqual([...model].filter(([, status]) => status === 'failed').map(([key]) => key).sort());
      for (const [key, status] of model) expect(table.get(key)?.status).toBe(status);
    }
  });
});

describe('persisted duplicate ownership', () => {
  it.each(['failed', 'recheck', 'pending'])('restores a %s newest owner as a blocking recheck', status => {
    const table = new FileStateTable();
    table.applySaved('old.md', 1, entry('old.md', 'Shared', 1));
    table.applySaved('new.md', 2, entry('new.md', ' shared ', 2));
    table.publishScan(table.beginScan(), new Map([
      ['old.md', { status: 'unchanged', mtimeMs: 1 }],
      ['new.md', { status: 'unchanged', mtimeMs: 2 }],
    ]));
    if (status === 'failed') table.applyFailure('new.md', failure);
    if (status === 'recheck') table.applyAbsent('new.md');
    if (status === 'pending') {
      const token = table.beginScan();
      table.applySaved('new.md', 2, entry('new.md', 'Shared', 2));
      table.publishScan(token, new Map([
        ['old.md', { status: 'unchanged', mtimeMs: 1 }],
        ['new.md', { status: 'unchanged', mtimeMs: 1 }],
      ]));
    }
    const snapshot = table.persistableSnapshot()!;
    expect(snapshot.entries.map(value => value.filePath)).toEqual(['old.md']);
    expect(snapshot.blocked).toEqual({ 'new.md': { nameKey: 'shared', mtimeMs: 2 } });
    const restarted = new FileStateTable();
    const token = restarted.beginScan();
    restarted.hydrate(snapshot.entries, snapshot.blocked);
    expect(restarted.getPathByName('Shared')).toBeUndefined();
    expect(restarted.ownerEntries()).toEqual([]);
    expect(restarted.get('new.md')?.status).toBe('recheck');
    const diff = restarted.publishScan(token, new Map([
      ['old.md', { status: 'unchanged', mtimeMs: 1 }],
      ['new.md', { status: 'failed', failure }],
    ])).diff;
    expect(diff.modified).toEqual(['new.md']);
    expect(restarted.getPathByName('Shared')).toBeUndefined();
    expect(restarted.persistableSnapshot()?.blocked).toEqual(snapshot.blocked);
    restarted.markPersisted(restarted.persistableSnapshot()!.generation);
    restarted.applyFailure('new.md', failure);
    expect(restarted.hasUnsavedChanges()).toBe(false);
  });

  it('reports a deleted hydrated blocker as removed and restores the older owner', () => {
    const table = new FileStateTable(); const token = table.beginScan();
    table.hydrate([entry('old.md', 'Shared', 1)], { 'new.md': { nameKey: 'shared', mtimeMs: 2 } });
    const diff = table.publishScan(token, new Map([['old.md', { status: 'unchanged', mtimeMs: 1 }]])).diff;
    expect(diff.removed).toEqual(['new.md']);
    expect(table.getPathByName('Shared')).toBe('old.md');
    expect(table.persistableSnapshot()?.blocked).toEqual({});
    expect(table.hasUnsavedChanges()).toBe(true);
  });
});


it('classifies mixed additions, changes, removals and unchanged entries in one publication', () => {
  const table = new FileStateTable();
  for (const file of ['a.md', 'b.md', 'c.md']) table.applySaved(file, 1, entry(file, file));
  const diff = table.publishScan(table.beginScan(), new Map([
    ['a.md', { status: 'unchanged', mtimeMs: 1 }],
    ['b.md', read('b.md', 2)], ['d.md', read('d.md', 2)],
  ])).diff;
  expect(diff).toEqual({ added: ['d.md'], modified: ['b.md'], removed: ['c.md'], unchanged: ['a.md'] });
  expect(table.get('c.md')).toBeUndefined();
  table.clear();
  expect(table.publishScan(table.beginScan(), new Map([['a.md', read()]])).diff.added).toEqual(['a.md']);
});

describe.each(['Σημειώσεις', 'Історія'])('single-pass name identity: %s', name => {
  it('agrees across raw lookup, owner views and blocked hydration', () => {
    const table = new FileStateTable();
    table.applySaved('a.md', 100, entry('a.md', name, 100));
    table.applySaved('b.md', 200, entry('b.md', name, 200));
    expect(table.ownerEntries().map(value => value.filePath)).toEqual(['b.md']);
    expect(table.getPathByName(name)).toBe('b.md');
    table.publishScan(table.beginScan(), new Map([
      ['a.md', { status: 'unchanged', mtimeMs: 100 }],
      ['b.md', { status: 'failed', failure, mtimeMs: 300 }],
    ]));
    table.applySaved('a.md', 250, entry('a.md', name, 250));
    expect(table.ownerEntries()).toEqual([]);
    expect(table.getPathByName(name)).toBeUndefined();
    const snapshot = table.persistableSnapshot()!;
    expect(snapshot.blocked['b.md'].mtimeMs).toBe(300);
    const restarted = new FileStateTable(); restarted.beginScan();
    restarted.hydrate(snapshot.entries, snapshot.blocked);
    expect(restarted.ownerEntries()).toEqual([]);
    expect(restarted.getPathByName(name)).toBeUndefined();
    restarted.applyDeleted('b.md');
    expect(restarted.getPathByName(name)).toBe('a.md');
    expect(restarted.ownerEntries().map(value => value.filePath)).toEqual(['a.md']);
  });

  it.each(['save', 'failure', 'delete', 'absent'])('keeps duplicate ownership after a concurrent %s', action => {
    const table = new FileStateTable();
    table.applySaved('a.md', 100, entry('a.md', name, 100));
    table.applySaved('b.md', 200, entry('b.md', name, 200));
    const token = table.beginScan();
    if (action === 'save') table.applySaved('a.md', 300, entry('a.md', name, 300));
    if (action === 'failure') table.applyFailure('b.md', failure, 300);
    if (action === 'delete') table.applyDeleted('b.md');
    if (action === 'absent') table.applyAbsent('b.md');
    table.publishScan(token, new Map([
      ['a.md', { status: 'unchanged', mtimeMs: 100 }],
      ['b.md', { status: 'unchanged', mtimeMs: 200 }],
    ]));
    const expected = action === 'save' || action === 'delete' ? ['a.md'] : [];
    expect(table.ownerEntries().map(value => value.filePath)).toEqual(expected);
    expect(table.getPathByName(name)).toBe(expected[0]);
  });
});

it('distinguishes initial publication from unsaved content and releases missing directories', () => {
  const table = new FileStateTable();
  expect(table.hasUnsavedChanges()).toBe(false);
  table.publishScan(table.beginScan(), new Map());
  expect(table.needsInitialWrite()).toBe(true);
  expect(table.hasUnsavedChanges()).toBe(false);
  table.markPersisted(table.persistableSnapshot()!.generation);
  expect(table.needsInitialWrite()).toBe(false);
  table.applySaved('a.md', 1, entry());
  expect(table.hasUnsavedChanges()).toBe(true);
  table.publishMissingDirectory(table.beginScan());
  expect(table.hasUnsavedChanges()).toBe(false);
  expect(table.needsInitialWrite()).toBe(false);
  table.clear(); table.applyFailure('a.md', failure);
  expect(table.hasUnsavedChanges()).toBe(true);
});
