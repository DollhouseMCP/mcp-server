import { ElementNotFoundError } from '../../../src/utils/ErrorHandler.js';
import { PolicyUnavailableError } from '../../../src/services/policy/PolicyUnavailableError.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { afterAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ALL_TYPES, cacheFixture, type AllCountedType, type Backend } from '../../helpers/counting/CacheFixture.js';
import { MEMORY_COUNT_MODE, type Scenario, type Temperature } from '../../helpers/counting/LegacyCounts.js';
import { MEASURED_COUNTS } from '../../helpers/counting/MeasuredCounts.js';
import { CHANGED_COUNTS } from '../../helpers/counting/ChangedCounts.js';
import type { OperationCounts } from '../../helpers/counting/OperationCounter.js';
import { cleanupTestElements, closeTestDb, ensureTestUser, TEST_DB_URL } from '../database/test-db-helpers.js';

type Operation = 'list' | 'findByName' | 'details' | 'refresh';
interface Case { backend: Backend; type: AllCountedType; count: number; scenario: Scenario; temperature: Temperature; operation: Operation }
const COLUMNS = ['dataStatements', 'setupStatements', 'otherStatements', 'rawContentBytes',
  'fileReads', 'fileBytes', 'yamlParses', 'indexParses'] as const;
const rows: { key: string; mode: 'record' | 'assert'; counts: OperationCounts }[] = [];
const scenarios: Scenario[] = ['initial', 'edit', 'delete'];
const cases = (types: readonly AllCountedType[], operations: Operation[]): Case[] =>
  (['file', 'db'] as const).flatMap(backend => types.flatMap(type => [0, 1, 10].flatMap(count =>
    (count ? scenarios : ['initial'] as const).flatMap(scenario => (['cold', 'warm'] as const).flatMap(temperature =>
      operations.map(operation => ({ backend, type, count, scenario, temperature, operation })))))));

/**
 * Every asserted row is a literal: beta's MEASURED_COUNTS, or the row this change measures where it
 * differs (CHANGED_COUNTS, which states the beta row and the reason beside each).
 */
function expectedCounts(test: Case, key: string): readonly number[] {
  if (test.type === ElementType.MEMORY) return MEASURED_COUNTS[key];
  return CHANGED_COUNTS[key]?.counts ?? MEASURED_COUNTS[key];
}

/** The definition text an element carries, whichever field its type keeps it in. */
function definitionBody(element: unknown): string {
  const value = element as { instructions?: unknown; content?: unknown } | undefined;
  return [value?.instructions, value?.content].filter(part => typeof part === 'string').join('\n');
}

function record(test: Case, counts: OperationCounts) {
  const key = [test.backend, test.type, test.count, test.scenario, test.temperature, test.operation].join('/');
  const mode = test.type === 'memories' ? MEMORY_COUNT_MODE : 'assert';
  rows.push({ key, mode, counts });
  if (mode === 'assert') {
    const row = expectedCounts(test, key);
    expect(counts).toEqual(Object.fromEntries(COLUMNS.map((column, index) => [column, row?.[index]])));
  }
}

afterAll(async () => {
  await closeTestDb();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dollhouse-counts-'));
  const report = path.join(directory, 'measurements.json');
  await writeFile(report, JSON.stringify(rows, null, 2));
  console.table(rows.filter(row => row.key.includes('/memories/')).map(row => ({ case: row.key, ...row.counts })));
  console.info(`Counting report: ${report}`);
});

describe('six-type manager baseline', () => {
  it.each(cases(ALL_TYPES, ['list', 'findByName', 'details']))(
    '$backend $type $count $scenario $temperature $operation', async test => {
      const userId = test.backend === 'db' ? await ensureTestUser() : '';
      if (test.backend === 'db') await cleanupTestElements(userId);
      const fixture = await cacheFixture(test.backend, { url: TEST_DB_URL, userId }, true);
      try {
        const manager = fixture.managers[test.type];
        await fixture.seed(test.type, test.count);
        await manager.list();
        if (test.scenario === 'edit') await fixture.put(test.type, 0, true);
        if (test.scenario === 'delete') await fixture.remove(test.type, 0);
        if (test.temperature === 'cold') manager.clearCache();
        fixture.counter.reset();
        if (test.operation === 'list') {
          await manager.list();
        } else if (test.operation === 'findByName') {
          const found = await manager.findByName(fixture.name(test.type, 0));
          // The writer edits and deletes without touching the reader's index (another process):
          // a warm database lookup must still answer the current row.
          if (test.backend === 'db' && test.temperature === 'warm' && test.count > 0) {
            if (test.scenario === 'delete') expect(found).toBeUndefined();
            if (test.scenario === 'edit') expect(definitionBody(found)).toContain('Edited café body.');
          }
        } else {
          const details = fixture.details(fixture.name(test.type, 0), test.type);
          // A definition deleted elsewhere is reported absent for every type, a cached persona included.
          if (test.count === 0 || test.scenario === 'delete') {
            await expect(details).rejects.toBeInstanceOf(ElementNotFoundError);
          } else {
            await expect(details).resolves.toHaveProperty('content');
          }
        }
        record(test, fixture.counter.snapshot());
      } finally { await fixture.dispose(); }
    });
});

describe('agent policy refresh baseline', () => {
  it.each(cases([ElementType.AGENT], ['refresh']))('$backend $count $scenario $temperature', async test => {
    const userId = test.backend === 'db' ? await ensureTestUser() : '';
    if (test.backend === 'db') await cleanupTestElements(userId);
    const fixture = await cacheFixture(test.backend, { url: TEST_DB_URL, userId }, true);
    try {
      await fixture.seed(ElementType.AGENT, test.count);
      await fixture.managers.agents.list();
      await fixture.activate(ElementType.AGENT, test.count);
      if (test.scenario === 'edit') await fixture.put(ElementType.AGENT, 0, true);
      if (test.scenario === 'delete') await fixture.remove(ElementType.AGENT, 0);
      if (test.temperature === 'cold') Object.values(fixture.managers).forEach(manager => manager.clearCache());
      fixture.counter.reset();
      const refresh = fixture.refresh();
      if (test.scenario === 'delete') await expect(refresh).rejects.toBeInstanceOf(PolicyUnavailableError);
      else expect(await refresh).toHaveLength(test.count);
      record(test, fixture.counter.snapshot());
    } finally { await fixture.dispose(); }
  });
});
