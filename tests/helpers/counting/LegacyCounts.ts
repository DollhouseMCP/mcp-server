import type { OperationCounts } from './OperationCounter.js';
import type { Backend, CountedType } from './CacheFixture.js';

export type Scenario = 'initial' | 'edit' | 'delete';
export type Temperature = 'cold' | 'warm';

// Observed on beta 20b3b427; persona refresh rows measured with the #3120 persona lookup fix applied.
// Fixed UTF-8 fixture sizes, not values read from the counter.
const BODY_BYTES = { personas: 92, skills: 90, ensembles: 106 } as const;
const EMPTY: OperationCounts = { dataStatements: 0, setupStatements: 0, otherStatements: 0,
  rawContentBytes: 0, fileReads: 0, fileBytes: 0, yamlParses: 0, indexParses: 0 };

export function listCounts(mode: Backend, type: CountedType, scenario: Scenario, temperature: Temperature): OperationCounts {
  const remaining = scenario === 'delete' ? 2 : 3;
  const cold = temperature === 'cold';
  const bodies = cold ? remaining : Number(scenario === 'edit');
  const bytes = bodies * BODY_BYTES[type] - (scenario === 'edit' ? 2 : 0);
  // Cold file listing reads each body twice: manifest discovery then ElementLoader.
  // A warm edit reads just the changed file twice; a warm delete reads no bodies.
  if (mode === 'file') return { ...EMPTY, fileReads: 2 * bodies, fileBytes: 2 * bytes,
    yamlParses: bodies, indexParses: bodies };
  // DB list: scan + summaries + tags = 3 data statements in 2 read transactions.
  // Each uncached body adds a data statement, 4 setup statements, and one parse.
  return { ...EMPTY, dataStatements: 3 + bodies, setupStatements: 8 + 4 * bodies,
    rawContentBytes: bytes, yamlParses: bodies };
}

export function refreshCounts(mode: Backend, type: CountedType, count: number,
  scenario: Scenario, temperature: Temperature): OperationCounts {
  if (mode === 'file') {
    // Invalidation resets only the cooldown: warm manifests still skip unchanged bodies.
    const bodies = temperature === 'cold' ? count - Number(scenario === 'delete') : Number(scenario === 'edit');
    return { ...EMPTY, fileReads: 2 * bodies,
      fileBytes: 2 * (bodies * BODY_BYTES[type] - Number(scenario === 'edit') * 2),
      yamlParses: bodies, indexParses: bodies };
  }
  // Each refresh scans all three manager indexes, even an empty portfolio.
  const bodies = count - Number(scenario === 'delete');
  // #3120: persona identity lookup also queries a deleted activation before name fallback.
  const attempts = type === 'personas' ? count : bodies;
  // Every refresh rereads all remaining active bodies, even warm.
  return { ...EMPTY, dataStatements: 3 + attempts, setupStatements: 12 + 4 * attempts,
    rawContentBytes: bodies * BODY_BYTES[type] - (scenario === 'edit' ? 2 : 0), yamlParses: bodies };
}

// Memory ownership is independent: changing this single mode enables assertions later.
export const MEMORY_COUNT_MODE: 'record' | 'assert' = 'record';
