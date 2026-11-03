import path from 'node:path';

// Other suites perform only this path check, before app imports or hooks.
const target = process.env.DIAG_TARGET_ROOT;
if (target && path.resolve(expect.getState().testPath ?? '') === path.join(target, 'tests/performance/collection-search-inverted-index.performance.test.ts')) {
const { default: fs } = await import('node:fs');
const { default: v8 } = await import('node:v8');
const { default: os } = await import('node:os');
const { CollectionSearch } = await import(path.join(target, 'src/collection/CollectionSearch.js'));
const { InvertedIndex } = await import(path.join(target, 'src/collection/InvertedIndex.js'));

const output = path.join(process.env.DIAG_OUTPUT, 'phases.json');
const workerBefore = { node: process.version, pid: process.pid, workerId: process.env.JEST_WORKER_ID, availableParallelism: os.availableParallelism(), cpuCount: os.cpus().length, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, resourceUsage: process.resourceUsage(), memory: process.memoryUsage(), heap: v8.getHeapStatistics() };
const records = []; const active = new Set(); const originals = []; let sequence = 0; let incomplete = false; let overlap = false;
function safe(fn, fallback = null) { try { return fn(); } catch { incomplete = true; return fallback; } }
function state(owner) {
  return safe(() => ({ hasIndex: !!owner.invertedIndex, version: owner.lastIndexVersion,
    entries: owner.invertedIndex?.entries?.length ?? 0 }));
}
function begin(method, receiver, args) {
  const queryId = method === 'query' ? ++sequence : active.size === 1 ? [...active][0] : null;
  if (method === 'query') { if (active.size) overlap = true; active.add(queryId); }
  if (method !== 'query' && active.size !== 1) overlap = true;
  return { method, queryId, test: safe(() => expect.getState().currentTestName),
    query: method === 'query' || method === 'search' ? args[0] : null,
    buildLength: method === 'build' ? safe(() => args[0].length) : null,
    before: method === 'query' ? state(receiver) : null,
    started: safe(() => process.hrtime.bigint()), cpu: safe(() => process.cpuUsage()) };
}
function finish(span, receiver, result, outcome) {
  safe(() => {
    const elapsed = process.hrtime.bigint() - span.started; const cpu = process.cpuUsage(span.cpu);
    records.push({ method: span.method, queryId: span.queryId, test: span.test, query: span.query,
      buildLength: span.buildLength, before: span.before, after: span.method === 'query' ? state(receiver) : null,
      wallMs: Number(elapsed) / 1e6, cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
      resultCount: Array.isArray(result) ? result.length : Array.isArray(result?.items) ? result.items.length : null, outcome });
  });
  if (span.method === 'query') active.delete(span.queryId);
}
function wrap(prototype, key, method, asynchronous) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key); originals.push([prototype, key, descriptor]);
  const original = descriptor.value;
  Object.defineProperty(prototype, key, { ...descriptor, value: function (...args) {
    const span = begin(method, this, args); let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { finish(span, this, null, 'threw'); throw error; }
    if (!asynchronous) { finish(span, this, result, 'returned'); return result; }
    return result.then(value => { finish(span, this, value, 'fulfilled'); return value; },
      error => { finish(span, this, null, 'rejected'); throw error; });
  } });
}
wrap(CollectionSearch.prototype, 'searchCollectionWithOptions', 'query', true);
wrap(InvertedIndex.prototype, 'build', 'build', false);
wrap(InvertedIndex.prototype, 'search', 'search', false);
afterAll(() => {
  for (const [prototype, key, descriptor] of originals) Object.defineProperty(prototype, key, descriptor);
  const workerAfter = { node: process.version, pid: process.pid, workerId: process.env.JEST_WORKER_ID, availableParallelism: os.availableParallelism(), cpuCount: os.cpus().length, execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS, resourceUsage: process.resourceUsage(), memory: process.memoryUsage(), heap: v8.getHeapStatistics() };
  fs.writeFileSync(output, JSON.stringify({ incomplete, overlap, active: active.size, records, workerBefore, workerAfter, gcTiming: 'UNKNOWN',
    interpretation: 'Process-wide CPU deltas and nested wall spans are inclusive, not additive or exclusive.' }, null, 2));
});

}
