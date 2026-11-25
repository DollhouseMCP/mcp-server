import { FileStateTable } from '../../../src/storage/FileStateTable.js';
import { assertNamedReadEvidence, couldHoldElementName } from '../../../src/elements/base/ElementNameEvidence.js';

describe('failed file name evidence', () => {
  it('keeps camel-case name evidence across repeated failures and persisted rechecks', () => {
    const table = new FileStateTable();
    table.applySaved('legacy.md', 1, { filePath: 'legacy.md', name: 'CodeReview',
      mtimeMs: 1, sizeBytes: 1, description: '', author: '', tags: [], version: '1' });
    const reject = (target: FileStateTable) => target.publishScan(target.beginScan(), new Map([['legacy.md', {
      status: 'failed' as const, mtimeMs: 2, failure: { name: 'Error', reason: 'invalid', candidateNames: [], unattributed: true },
    }]]));
    reject(table);
    reject(table);
    expect(() => assertNamedReadEvidence('code-review', true, table.unindexed())).toThrow('legacy.md');
    const persisted = table.persistableSnapshot()!;
    const restarted = new FileStateTable();
    restarted.hydrate(persisted.entries, persisted.blocked);
    reject(restarted);
    expect(() => assertNamedReadEvidence('code-review', true, restarted.unindexed())).toThrow('legacy.md');
    expect(restarted.unindexed().get('legacy.md')?.candidateNames).toContain('CodeReview');
  });

  it('does not equate distinct non-Latin names through an empty filename key', () => {
    expect(couldHoldElementName('broken.md', ['東京'], '北京')).toBe(false);
    expect(couldHoldElementName('broken.md', ['東京'], '東京')).toBe(true);
  });

  it('blocks normalization collisions and collection-level failures without blocking unrelated positive reads', () => {
    const failures = new Map([['nested/foo-bar.md', { name: 'Error', reason: 'invalid',
      candidateNames: ['Foo Bar', 'foo-bar'], elementName: 'Foo Bar', unattributed: false }]]);
    for (const name of ['Foo Bar', 'foo_bar', 'FOO BAR']) {
      expect(() => assertNamedReadEvidence(name, true, failures)).toThrow('nested/foo-bar.md');
    }
    expect(() => assertNamedReadEvidence('Healthy', true, failures)).not.toThrow();
    expect(() => assertNamedReadEvidence('Missing', true, failures, true)).not.toThrow();
    expect(() => assertNamedReadEvidence('Healthy', false, failures)).toThrow('could not be determined');
    expect(() => assertNamedReadEvidence('Healthy', true, new Map([['', failures.values().next().value!]]))).toThrow('could not be determined');
  });
  it('keeps collection authority while attributing a never-parsed dated file', () => {
    const table = new FileStateTable();
    table.publishScan(table.beginScan(), new Map([['2026-10-27/policy-memory.yaml', {
      status: 'failed', mtimeMs: 2, failure: { name: 'Error', reason: 'invalid', candidateNames: [], unattributed: true },
    }]]));
    expect(table.isAuthoritative()).toBe(true);
    expect(table.unindexed().get('2026-10-27/policy-memory.yaml')).toMatchObject({
      candidateNames: ['policy-memory'], unattributed: true,
    });
  });

  it('keeps both the previous name and filename after a rewrite', () => {
    const table = new FileStateTable();
    table.applySaved('renamed.md', 1, { filePath: 'renamed.md', name: 'Original Name',
      mtimeMs: 1, sizeBytes: 1, description: '', author: '', tags: [], version: '1' });
    table.publishScan(table.beginScan(), new Map([['renamed.md', {
      status: 'failed', mtimeMs: 2, failure: { name: 'Error', reason: 'invalid', candidateNames: [], unattributed: true },
    }]]));
    expect(table.unindexed().get('renamed.md')).toMatchObject({
      candidateNames: ['Original Name', 'renamed'], unattributed: false,
    });
    table.publishScan(table.beginScan(), new Map([['renamed.md', {
      status: 'statFailed', failure: { name: 'Error', reason: 'denied', candidateNames: [], unattributed: true },
    }]]));
    expect(table.unindexed().get('renamed.md')?.unattributed).toBe(true);
  });
});
