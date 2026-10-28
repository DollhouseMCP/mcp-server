const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = process.env.DOLLHOUSE_GLOBAL_NPM_ROOT || '/usr/local/lib/node_modules/npm';
const fromBundle = createRequire(path.join(root, 'package.json'));
const Policy = fromBundle('http-cache-semantics');
const fetch = fromBundle('npm-registry-fetch');
const cacache = fromBundle('cacache');
const observations = [];
const request = { url: 'https://synthetic-cache.invalid/package', method: 'GET', headers: {} };

function policy(control, shared = false, ageSeconds = 2, extra = {}) {
  const start = Date.now();
  const value = new Policy(request, { status: 200, headers: { date: new Date(start).toUTCString(), 'cache-control': control, ...extra } }, { shared });
  value._responseTime = start;
  value.now = () => start + ageSeconds * 1000;
  return value;
}

for (const { name, control, shared, extra } of [
  { name: 'private no-cache', control: 'no-cache, stale-while-revalidate=100, stale-if-error=100', shared: false, extra: {} },
  { name: 'shared no-cache', control: 'no-cache, stale-while-revalidate=100, stale-if-error=100', shared: true, extra: {} },
  { name: 'nonstorable', control: 'no-store, stale-while-revalidate=100, stale-if-error=100', shared: false, extra: {} },
  { name: 'stale must-revalidate', control: 'max-age=1, must-revalidate, stale-while-revalidate=100, stale-if-error=100', shared: false, extra: {} },
  { name: 'shared proxy-revalidate', control: 'max-age=1, proxy-revalidate, stale-while-revalidate=100, stale-if-error=100', shared: true, extra: {} },
  { name: 'shared s-maxage', control: 'max-age=600, s-maxage=1, stale-while-revalidate=100, stale-if-error=100', shared: true, extra: {} },
  { name: 'shared cookie safeguard', control: 'max-age=600, stale-while-revalidate=100, stale-if-error=100', shared: true, extra: { 'set-cookie': 'synthetic=test' } },
]) {
  test(`mandatory policy: ${name} cannot be revived by max-stale/SWR/SIE`, () => {
    const value = policy(control, shared, 2, extra);
    assert.equal(value.satisfiesWithoutRevalidation({ ...request, headers: { 'cache-control': 'max-stale=1000' } }), false);
    assert.equal(value.useStaleWhileRevalidate(), false);
    assert.equal(value._useStaleIfError(), false);
    assert.equal(value.revalidatedPolicy(request, { status: 503, headers: {} }).policy === value, false);
  });
}

for (const { name, control, shared, extra } of [
  { name: 'ordinary fresh', control: 'max-age=600', shared: false, extra: {} },
  { name: 'fresh must-revalidate', control: 'max-age=600, must-revalidate', shared: false, extra: {} },
  { name: 'private proxy equivalent', control: 'max-age=600, proxy-revalidate', shared: false, extra: {} },
  { name: 'private s-maxage equivalent', control: 'max-age=600, s-maxage=1', shared: false, extra: {} },
  { name: 'public cookie', control: 'public, max-age=600', shared: true, extra: { 'set-cookie': 'synthetic=test' } },
  { name: 'immutable cookie', control: 'immutable, max-age=600', shared: true, extra: { 'set-cookie': 'synthetic=test' } },
  { name: 'private cookie', control: 'max-age=600', shared: false, extra: { 'set-cookie': 'synthetic=test' } },
]) {
  test(`permitted policy: ${name} remains reusable`, () => {
    assert.equal(policy(control, shared, 2, extra).satisfiesWithoutRevalidation(request), true);
  });
}
test('ordinary stale max-stale and SWR/SIE remain available', () => {
  const value = policy('max-age=1, stale-while-revalidate=100, stale-if-error=100');
  assert.equal(value.satisfiesWithoutRevalidation({ ...request, headers: { 'cache-control': 'max-stale=1000' } }), true);
  assert.equal(value.useStaleWhileRevalidate(), true);
  assert.equal(value._useStaleIfError(), true);
  assert.equal(value.revalidatedPolicy(request, { status: 503, headers: {} }).policy === value, true);
});
test('qualified Vary wildcard fix remains present', () => {
  for (const vary of [' * ', '*, accept', 'accept, *']) {
    assert.equal(policy('max-age=600', false, 2, { vary }).satisfiesWithoutRevalidation(request), false);
  }
});

const scenarios = [
  { name: 'no-cache max-stale validates', cc: 'no-cache', headers: { 'cache-control': 'max-stale=1000' }, count: 2, sequence: 2 },
  { name: 'no-cache socket failure rejects', cc: 'no-cache', origin: 'socket', count: 2, error: true },
  { name: 'no-cache HTTP error rejects', cc: 'no-cache, stale-if-error=100', origin: 'http', count: 2, error: true },
  { name: 'no-cache offline refuses', cc: 'no-cache', options: { offline: true }, count: 1, error: 'ENOTCACHED' },
  { name: 'no-cache preferOffline validates', cc: 'no-cache', options: { preferOffline: true }, count: 2, sequence: 2 },
  { name: 'stale must max-stale validates', cc: 'max-age=0, must-revalidate', headers: { 'cache-control': 'max-stale=1000' }, count: 2, sequence: 2 },
  { name: 'stale must socket rejects', cc: 'max-age=0, must-revalidate', origin: 'socket', count: 2, error: true },
  { name: 'stale must offline refuses', cc: 'max-age=0, must-revalidate', options: { offline: true }, count: 1, error: 'ENOTCACHED' },
  { name: 'stale must preferOffline validates', cc: 'max-age=0, must-revalidate', options: { preferOffline: true }, count: 2, sequence: 2 },
  { name: 'fresh must default reuse', cc: 'max-age=600, must-revalidate', count: 1, sequence: 1 },
  { name: 'fresh must offline reuse', cc: 'max-age=600, must-revalidate', options: { offline: true }, count: 1, sequence: 1 },
  { name: 'fresh must preferOffline reuse', cc: 'max-age=600, must-revalidate', options: { preferOffline: true }, count: 1, sequence: 1 },
  { name: 'ordinary max-stale reuse', cc: 'max-age=0', headers: { 'cache-control': 'max-stale=1000' }, count: 1, sequence: 1 },
  { name: 'ordinary stale offline reuse', cc: 'max-age=0', options: { offline: true }, count: 1, sequence: 1 },
  { name: 'ordinary stale preferOffline reuse', cc: 'max-age=0', options: { preferOffline: true }, count: 1, sequence: 1 },
  { name: 'ordinary stale socket fallback', cc: 'max-age=0', origin: 'socket', count: 2, sequence: 1 },
  { name: 'ordinary HTTP stale-if-error fallback', cc: 'max-age=0, stale-if-error=100', origin: 'http', count: 2, sequence: 1 },
  { name: 'no-store is never persisted', cc: 'no-store', headers: { 'cache-control': 'max-stale=1000' }, count: 2, sequence: 2, noEntries: true },
  { name: 'expected integrity mismatch rejects', cc: 'max-age=600', mismatch: true, count: 2, error: true },
];

for (const scenario of scenarios) {
  test(`actual npm-registry-fetch: ${scenario.name}`, async () => {
    let count = 0;
    const server = http.createServer((req, res) => {
      count++;
      if (count > 1 && scenario.origin === 'socket') { req.socket.destroy(); return; }
      res.statusCode = count > 1 && scenario.origin === 'http' ? 503 : 200;
      res.setHeader('cache-control', scenario.cc);
      res.setHeader('etag', '"synthetic"');
      res.setHeader('set-cookie', 'synthetic=not-a-secret');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sequence: count }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/packument`;
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-npm-cache-control-'));
    try {
      const opts = { cache, registry: url, noProxy: '*', fetchRetries: 0, timeout: 3000, headers: {} };
      const first = await fetch(url, opts); await first.json();
      const initialEntries = await cacache.ls(cache);
      const initialMetadataCookie = Object.values(initialEntries).some(entry => Object.hasOwn(entry.metadata?.resHeaders || {}, 'set-cookie'));
      assert.equal(initialMetadataCookie, false, 'persisted first-response metadata must exclude Set-Cookie');
      if (scenario.noEntries) assert.equal(Object.keys(initialEntries).length, 0);
      else assert.ok(Object.keys(initialEntries).length > 0, 'positive actual cache metadata must be inspected');
      let second, result, error;
      const integrity = scenario.mismatch ? `sha512-${createHash('sha512').update('synthetic wrong bytes').digest('base64')}` : undefined;
      try {
        second = await fetch(url, { ...opts, ...scenario.options, headers: scenario.headers || {}, ...(integrity ? { integrity } : {}) });
        result = await second.json();
      } catch (error_) { error = error_.code || error_.name; }
      const entries = await cacache.ls(cache);
      const metadataCookie = Object.values(entries).some(entry => Object.hasOwn(entry.metadata?.resHeaders || {}, 'set-cookie'));
      observations.push({ name: scenario.name, serverRequests: count, sequence: result?.sequence, error, cacheStatus: second?.headers.get('x-local-cache-status'), initialMetadataCookie, initialCacheEntries: Object.keys(initialEntries).length, metadataCookie, cacheEntries: Object.keys(entries).length });
      assert.equal(count, scenario.count, 'actual origin request count');
      if (scenario.error) {
        assert.ok(error, 'mandatory validation/error must not become a cached success');
        if (typeof scenario.error === 'string') assert.equal(error, scenario.error);
      } else {
        assert.equal(error, undefined);
        assert.equal(result.sequence, scenario.sequence);
      }
      assert.equal(metadataCookie, false, 'cache metadata must not retain Set-Cookie');
      if (scenario.noEntries) assert.equal(Object.keys(entries).length, 0);
      if (result?.sequence === 1) {
        assert.ok(Object.keys(entries).length > 0, 'cached response needs an actual persisted entry');
        assert.equal(second.headers.has('set-cookie'), false);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(cache, { recursive: true, force: true });
    }
  });
}
after(async () => {
  if (process.env.DOLLHOUSE_NPM_CACHE_RESULTS) await fs.writeFile(process.env.DOLLHOUSE_NPM_CACHE_RESULTS, JSON.stringify({ node: process.version, npmCliExecuted: false, source: path.basename(root), observations }, null, 2) + '\n');
});
