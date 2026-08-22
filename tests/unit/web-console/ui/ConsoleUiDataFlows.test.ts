import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import yaml from 'js-yaml';

import { drainLogPages, overlappingPollTimestamp } from '../../../../src/web-console/ui/logs';
import {
  forgetPortfolioSyncJob,
  normalizeImportedDraft,
  portfolioRequestSizeProblem,
  readPendingPortfolioSyncJob,
  rememberPortfolioSyncJob,
  serializedJsonByteLength,
} from '../../../../src/web-console/ui/portfolio-authoring';
import { parseMemoryYamlForDetail } from '../../../../src/web-console/ui/portfolio-detail';
import {
  browserSessionTruncationNotice,
  sessionCountLabel,
} from '../../../../src/web-console/ui/sessions';

describe('web console data-flow boundaries', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'jsyaml', { configurable: true, value: yaml });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'jsyaml');
  });

  it('drains every log page in order before returning the incremental batch', async () => {
    const requestedCursors: Array<string | undefined> = [];
    const pages = [
      { status: 200, body: { items: [{ id: 'newest' }], page: { next_cursor: 'page-2' } } },
      { status: 200, body: { items: [{ id: 'middle' }], page: { next_cursor: 'page-3' } } },
      { status: 200, body: { items: [{ id: 'oldest' }], page: { next_cursor: null } } },
    ];

    const items = await drainLogPages(async cursor => {
      requestedCursors.push(cursor);
      const page = pages.shift();
      if (!page) throw new Error('unexpected extra page');
      return page;
    });

    expect(requestedCursors).toEqual([undefined, 'page-2', 'page-3']);
    expect(items).toEqual([{ id: 'newest' }, { id: 'middle' }, { id: 'oldest' }]);
  });

  it('rejects a repeated log cursor instead of polling forever or advancing past a gap', async () => {
    await expect(drainLogPages(async () => ({
      status: 200,
      body: { items: [], page: { next_cursor: 'same-page' } },
    }))).rejects.toThrow('did not advance');
  });

  it('overlaps incremental log polls so late equal-timestamp entries are not skipped', () => {
    expect(overlappingPollTimestamp('2026-06-24T12:00:00.000Z'))
      .toBe('2026-06-24T11:59:59.999Z');
    expect(overlappingPollTimestamp(null)).toBeUndefined();
    expect(overlappingPollTimestamp('not-a-timestamp')).toBe('not-a-timestamp');
  });

  it('measures the serialized UTF-8 portfolio request rather than the source file size', () => {
    expect(serializedJsonByteLength({ content: '\u{1F600}' })).toBeGreaterThan(JSON.stringify({ content: '\u{1F600}' }).length);
    expect(portfolioRequestSizeProblem({ content: 'a'.repeat(1024 * 1024) })).toContain('1 MiB');
    expect(portfolioRequestSizeProblem({ content: 'a'.repeat(900 * 1024) })).toBeNull();
    expect(portfolioRequestSizeProblem({ content: 'a'.repeat(2 * 1024 * 1024) }, 10 * 1024 * 1024)).toBeNull();
    expect(portfolioRequestSizeProblem({ content: 'a'.repeat(11 * 1024 * 1024) }, 10 * 1024 * 1024))
      .toContain('10 MiB');
  });

  it('imports object-valued portable memories from nested data rather than the wrapper', () => {
    const nestedMemory = {
      metadata: { name: 'research-memory', description: 'Research notes' },
      entries: [{ id: 'entry-1', content: 'Nested memory content' }],
    };
    const wrapper = {
      exportVersion: '1.0',
      elementType: 'memories',
      elementName: 'research-memory',
      format: 'json',
      data: nestedMemory,
    };

    const draft = normalizeImportedDraft(
      { record: wrapper, format: 'json' },
      JSON.stringify(wrapper),
      'research-memory.json',
    );

    expect(JSON.parse(draft.content)).toEqual(nestedMemory);
    expect(draft.content).not.toContain('exportVersion');
  });

  it('persists only bounded sync job identifiers and clears the matching terminal job', () => {
    const storage = createMemoryStorage();
    const jobId = '018f3d47-73ae-7f10-a0de-0742618d4fb1';

    expect(rememberPortfolioSyncJob(jobId, storage)).toBe(true);
    expect(readPendingPortfolioSyncJob(storage)).toBe(jobId);
    forgetPortfolioSyncJob('another-job', storage);
    expect(readPendingPortfolioSyncJob(storage)).toBe(jobId);
    forgetPortfolioSyncJob(jobId, storage);
    expect(readPendingPortfolioSyncJob(storage)).toBeNull();

    expect(rememberPortfolioSyncJob('../untrusted/job', storage)).toBe(false);
    expect(readPendingPortfolioSyncJob(storage)).toBeNull();
  });

  it('renders memory YAML above the former 512 KiB detail ceiling up to 10 MiB', () => {
    const notes = 'a'.repeat(600 * 1024);
    const parsed = parseMemoryYamlForDetail(`notes: "${notes}"\n`) as { notes: string } | null;

    expect(parsed?.notes).toHaveLength(notes.length);
    expect(parseMemoryYamlForDetail(`notes: "${'a'.repeat(10 * 1024 * 1024)}"\n`)).toBeNull();
  });

  it('labels browser-session truncation without implying an exact total', () => {
    expect(sessionCountLabel(100, true)).toBe('100+');
    expect(sessionCountLabel(2, false)).toBe('2');
    expect(browserSessionTruncationNotice(true, 100)).toContain('100 most recent');
    expect(browserSessionTruncationNotice(false, 100)).toBe('');
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
