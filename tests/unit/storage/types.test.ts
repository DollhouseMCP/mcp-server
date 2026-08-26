import { describe, expect, it } from '@jest/globals';
import {
  mergeManifestDiffResults,
  type ManifestDiffResult,
} from '../../../src/storage/types.js';

const emptyDiff = (): ManifestDiffResult => ({
  added: [],
  modified: [],
  removed: [],
  unchanged: [],
});

function diff(category: keyof ManifestDiffResult, filePath = 'policy.md'): ManifestDiffResult {
  const result = emptyDiff();
  result[category].push(filePath);
  return result;
}

describe('mergeManifestDiffResults', () => {
  it.each([
    ['added', 'unchanged', 'added'],
    ['added', 'modified', 'added'],
    ['added', 'removed', 'removed'],
    ['modified', 'unchanged', 'modified'],
    ['modified', 'modified', 'modified'],
    ['modified', 'removed', 'removed'],
    ['removed', 'added', 'modified'],
    ['removed', 'modified', 'modified'],
    ['unchanged', 'modified', 'modified'],
    ['unchanged', 'removed', 'removed'],
    ['unchanged', 'unchanged', 'unchanged'],
  ] as const)('merges %s -> %s as %s', (first, second, expected) => {
    const result = mergeManifestDiffResults(diff(first), diff(second));

    expect(result[expected]).toEqual(['policy.md']);
    expect(Object.values(result).flat()).toEqual(['policy.md']);
  });

  it('preserves deterministic first-seen order and disjoint categories', () => {
    const first: ManifestDiffResult = {
      added: ['new.md'],
      modified: ['changed.md'],
      removed: [],
      unchanged: ['steady.md'],
    };
    const second: ManifestDiffResult = {
      added: ['replacement.md'],
      modified: ['steady.md'],
      removed: ['new.md'],
      unchanged: ['changed.md'],
    };

    expect(mergeManifestDiffResults(first, second)).toEqual({
      added: ['replacement.md'],
      modified: ['changed.md', 'steady.md'],
      removed: ['new.md'],
      unchanged: [],
    });
  });
});
