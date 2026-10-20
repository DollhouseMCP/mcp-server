import { describe, it, expect, afterAll } from '@jest/globals';
import { listCounts, refreshCounts } from '../../helpers/counting/LegacyCounts.js';
import { cacheFixture, TYPES, type Backend } from '../../helpers/counting/CacheFixture.js';
import { cleanupTestElements, closeTestDb, ensureTestUser, TEST_DB_URL } from '../database/test-db-helpers.js';

// Measurements exclude seeding, activation, mutation and cleanup. File scan cooldown
// is zero to exercise manifest validation deterministically, without a timing gate.
afterAll(closeTestDb);

const scenarios = ['initial', 'edit', 'delete'] as const;
const temperatures = ['cold', 'warm'] as const;
for (const mode of ['file', 'db'] as const satisfies readonly Backend[]) {
  describe(`legacy list: ${mode}`, () => {
    it.each(TYPES.flatMap(type => scenarios.flatMap(scenario => temperatures.map(temperature =>
      ({ type, scenario, temperature })))))('$type $scenario $temperature', async ({ type, scenario, temperature }) => {
      const userId = mode === 'db' ? await ensureTestUser() : '';
      if (mode === 'db') await cleanupTestElements(userId);
      const fixture = await cacheFixture(mode, { url: TEST_DB_URL, userId });
      try {
        await fixture.seed(type, 3);
        const primed = await fixture.managers[type].list();
        const deleted = primed.find(element => element.metadata.name === `${type}-01`);
        if (scenario === 'edit') await fixture.put(type, 0, true);
        if (scenario === 'delete') await fixture.remove(type, 1);
        if (temperature === 'cold') fixture.managers[type].clearCache();
        fixture.counter.reset();
        const values = await fixture.managers[type].list();
        expect(values).toHaveLength(scenario === 'delete' ? 2 : 3);
        expect(fixture.counter.snapshot()).toEqual(listCounts(mode, type, scenario, temperature));
        if (mode === 'db' && scenario === 'delete' && temperature === 'warm') {
          // Known stale cache (#2799): a deleted row's previously loaded object stays cached.
          expect(deleted).toBeDefined();
          // Private access deliberately characterizes retained cache state.
          expect(fixture.managers[type]['getCachedElementsForCurrentNamespace']()).toContain(deleted);
        }
      } finally { await fixture.dispose(); }
    });
  });
}

for (const mode of ['file', 'db'] as const) {
  describe(`legacy per-operation policy refresh: ${mode}`, () => {
    it.each(TYPES.flatMap(type => [0, 1, 10].flatMap(count =>
      (count ? scenarios : ['initial'] as const).flatMap(scenario => temperatures.map(temperature =>
        ({ type, count, scenario, temperature, caseName: type === 'personas'
          ? 'records fixed persona identity refresh (#3120)' : 'records legacy refresh' }))))))(
      '$caseName: $type $count active $scenario $temperature', async ({ type, count, scenario, temperature }) => {
        const userId = mode === 'db' ? await ensureTestUser() : '';
        if (mode === 'db') await cleanupTestElements(userId);
        const fixture = await cacheFixture(mode, { url: TEST_DB_URL, userId });
        try {
          await fixture.seed(type, count);
          // Establish the known-row scan and warm manager cache before activation.
          await fixture.managers[type].list();
          await fixture.activate(type, count);
          if (scenario === 'edit') await fixture.put(type, 0, true);
          if (scenario === 'delete') await fixture.remove(type, 0);
          if (temperature === 'cold') {
            for (const manager of Object.values(fixture.managers)) manager.clearCache();
          }
          fixture.counter.reset();
          const values = await fixture.refresh();
          const remaining = count - Number(scenario === 'delete');
          expect(values).toHaveLength(remaining);
          expect(fixture.counter.snapshot()).toEqual(refreshCounts(mode, type, count, scenario, temperature));
        } finally { await fixture.dispose(); }
      });
  });
}
