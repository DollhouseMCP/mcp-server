import { FileStateTable, nameKey, type ScanOutcome } from '../../../src/storage/FileStateTable.js';
import type { ElementIndexEntry, ManifestDiffResult } from '../../../src/storage/types.js';

type ModelRecord = { status: 'indexed' | 'failed' | 'recheck'; key?: string; mtime?: number; pending?: boolean };
const names = ['Shared', 'Σημειώσεις', 'Історія'];
const keys = new Map(names.map(name => [name, nameKey(name)]));
const failure = { name: 'Error', code: 'EACCES', reason: 'denied' };
const entry = (filePath: string, name: string, mtimeMs: number): ElementIndexEntry => ({
  filePath, name, mtimeMs, description: '', author: '', version: '1', tags: [], sizeBytes: 1,
});
const sorted = (diff: ManifestDiffResult): ManifestDiffResult => Object.fromEntries(
  Object.entries(diff).map(([kind, paths]) => [kind, [...paths].sort()]),
) as unknown as ManifestDiffResult;

it('matches an independent classifier and name model with mutations between begin and publish', () => {
  const table = new FileStateTable(); const model = new Map<string, ModelRecord>();
  let random = 827361;
  const pick = (limit: number): number => { random = (random * 1664525 + 1013904223) >>> 0; return (random >>> 8) % limit; };
  const paths = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
  for (let step = 0; step < 250; step++) {
    if (step % 37 === 0) { table.clear(); model.clear(); }
    const outcomes = new Map<string, ScanOutcome>();
    for (const path of paths) {
      const old = model.get(path); const choice = pick(5); const mtime = pick(5); const name = names[pick(names.length)];
      if (choice === 0 && old?.status === 'indexed' && !old.pending) outcomes.set(path, { status: 'unchanged', mtimeMs: old.mtime! });
      else if (choice <= 1) outcomes.set(path, { status: 'indexed', entry: entry(path, name, mtime), mtimeMs: mtime });
      else if (choice === 2) outcomes.set(path, { status: 'failed', failure, mtimeMs: mtime });
      else if (choice === 3) outcomes.set(path, { status: 'statFailed', failure });
      else outcomes.set(path, { status: 'absent' });
    }
    const token = table.beginScan(); const touched = new Map<string, boolean>(); let invalidated = false;
    for (let change = 0; change < 3; change++) {
      const path = paths[pick(paths.length)]; const action = pick(5); const previous = model.get(path);
      if (action === 4) { table.invalidate(); invalidated = true; continue; }
      if (!touched.has(path)) touched.set(path, model.has(path));
      if (action === 0) {
        const name = names[pick(names.length)]; const mtime = pick(5);
        table.applySaved(path, mtime, entry(path, name, mtime));
        model.set(path, { status: 'indexed', key: keys.get(name), mtime });
      }
      if (action === 1) {
        table.applyAbsent(path);
        if (previous) { model.set(path, { status: 'recheck', key: previous.key, mtime: previous.mtime }); invalidated = true; }
      }
      if (action === 2) {
        const mtime = pick(5); table.applyFailure(path, failure, mtime);
        model.set(path, { status: 'failed', key: previous?.key, mtime }); invalidated = true;
      }
      if (action === 3) { table.applyDeleted(path); model.delete(path); }
    }
    const expected: ManifestDiffResult = { added: [], modified: [], removed: [], unchanged: [] };
    for (const [path, outcome] of outcomes) {
      const previous = model.get(path);
      if (touched.has(path)) {
        if (previous) {
          expected[touched.get(path) ? 'modified' : 'added'].push(path);
          if (previous.status === 'indexed' && previous.mtime !== ('mtimeMs' in outcome ? outcome.mtimeMs : undefined)) previous.pending = true;
        }
        continue;
      }
      if (outcome.status === 'absent') {
        if (previous && previous.status !== 'failed') expected.removed.push(path);
        model.delete(path);
      } else if (outcome.status === 'unchanged') expected.unchanged.push(path);
      else {
        expected[previous ? 'modified' : 'added'].push(path);
        if (outcome.status === 'indexed') model.set(path, { status: 'indexed', key: keys.get(outcome.entry.name), mtime: outcome.mtimeMs });
        else model.set(path, { status: 'failed', key: previous?.key, mtime: outcome.mtimeMs ?? previous?.mtime });
      }
    }
    expect(sorted(table.publishScan(token, outcomes).diff)).toEqual(sorted(expected));
    const pending = invalidated || [...model.values()].some(record => record.status === 'recheck' || record.pending);
    expect(table.pendingInvalidation).toBe(pending);
    expect(table.isAuthoritative()).toBe(!pending && [...model.values()].every(record => record.status === 'indexed' && !record.pending));
    expect([...table.unindexed().keys()].sort()).toEqual([...model].filter(([, record]) => record.status === 'failed').map(([path]) => path).sort());
    const servingOwners: string[] = [];
    for (const name of names) {
      const candidates = [...model].filter(([, record]) => record.key === keys.get(name));
      candidates.sort(([a, left], [b, right]) => (right.mtime! - left.mtime!) || (a > b ? -1 : 1));
      const owner = candidates[0]?.[1].status === 'indexed' ? candidates[0][0] : undefined;
      expect(table.getPathByName(name)).toBe(owner);
      if (owner) servingOwners.push(owner);
    }
    expect(table.ownerEntries().map(value => value.filePath).sort()).toEqual(servingOwners.sort());
  }
});
