/**
 * Unit tests for the gh-backed ownership resolver and the per-session cache
 * (Issue #3153). The resolver is driven through an injected runner so no
 * process is ever spawned.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  GhOwnershipResolver,
  OwnershipCache,
  ownershipCacheKey,
  resolveGhBinary,
  type GhCommandResult,
  type GhRunner,
} from '../../../../../src/handlers/mcp-aql/policies/OwnershipLookup.js';
import type { GitHubMutationIntent } from '../../../../../src/handlers/mcp-aql/policies/OwnershipPolicy.js';

function ok(stdout: string): GhCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): GhCommandResult {
  return { stdout: '', stderr, exitCode };
}

function runner(result: GhCommandResult | ((args: readonly string[]) => GhCommandResult)) {
  const fn = jest.fn(async (args: readonly string[]) => (typeof result === 'function' ? result(args) : result));
  return { run: fn as unknown as GhRunner, calls: fn.mock.calls };
}

const PR: GitHubMutationIntent = { kind: 'pull_request', action: 'gh pr merge', selector: '12', source: 'gh pr merge 12' };
const ISSUE: GitHubMutationIntent = { kind: 'issue', action: 'gh issue close', selector: '7', repo: { owner: 'o', name: 'r' }, source: 'gh issue close 7' };
const BRANCH: GitHubMutationIntent = { kind: 'branch', action: 'git push', branch: 'feature/x', source: 'git push origin feature/x' };

describe('GhOwnershipResolver', () => {
  describe('pull requests', () => {
    it('resolves the author of an explicit PR number', async () => {
      const { run, calls } = runner(ok('{"author":{"login":"insomnolence"},"number":12}'));
      const resolver = new GhOwnershipResolver(run);
      await expect(resolver.lookup(PR, { cwd: '/repo' })).resolves.toEqual({ status: 'resolved', authorLogin: 'insomnolence', number: 12 });
      expect(calls[0][0]).toEqual(['pr', 'view', '12', '--json', 'author,number']);
      expect(calls[0][1]).toMatchObject({ cwd: '/repo' });
    });

    it('resolves the current-branch PR when no selector is given', async () => {
      const { run, calls } = runner(ok('{"author":{"login":"mickdarling"},"number":3}'));
      await new GhOwnershipResolver(run).lookup({ ...PR, selector: undefined });
      expect(calls[0][0]).toEqual(['pr', 'view', '--json', 'author,number']);
    });

    it('turns a PR URL into a number plus --repo', async () => {
      const { run, calls } = runner(ok('{"author":{"login":"a"},"number":9}'));
      await new GhOwnershipResolver(run).lookup({ ...PR, selector: 'https://github.com/DollhouseMCP/mcp-server/pull/9' });
      expect(calls[0][0]).toEqual(['pr', 'view', '9', '--json', 'author,number', '--repo', 'DollhouseMCP/mcp-server']);
    });

    it('passes branch selectors and explicit repos through', async () => {
      const { run, calls } = runner(ok('{"author":{"login":"a"},"number":1}'));
      await new GhOwnershipResolver(run).lookup({ ...PR, selector: 'feature/y', repo: { owner: 'o', name: 'r' } });
      expect(calls[0][0]).toEqual(['pr', 'view', 'feature/y', '--json', 'author,number', '--repo', 'o/r']);
    });

    it('refuses selectors that could be parsed as flags (fail closed)', async () => {
      const { run, calls } = runner(ok('{}'));
      const result = await new GhOwnershipResolver(run).lookup({ ...PR, selector: '--repo=evil/evil' });
      expect(result).toMatchObject({ status: 'error' });
      expect(calls).toHaveLength(0);
    });

    it('reports not_found when gh finds no PR for the branch', async () => {
      const { run } = runner(fail('no pull requests found for branch "scratch"'));
      await expect(new GhOwnershipResolver(run).lookup({ ...PR, selector: undefined })).resolves.toEqual({ status: 'not_found' });
    });

    it('reports an error for other gh failures (auth, network, timeout)', async () => {
      const { run } = runner(fail('error connecting to api.github.com', 1));
      const result = await new GhOwnershipResolver(run).lookup(PR);
      expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('gh pr view') });
    });

    it('reports an error when gh is missing', async () => {
      const { run } = runner(fail('gh CLI not found', 127));
      expect(await new GhOwnershipResolver(run).lookup(PR)).toMatchObject({ status: 'error' });
    });

    it('reports an error on malformed or author-less JSON', async () => {
      expect(await new GhOwnershipResolver(runner(ok('not json')).run).lookup(PR)).toMatchObject({ status: 'error' });
      expect(await new GhOwnershipResolver(runner(ok('{"number":1}')).run).lookup(PR)).toMatchObject({ status: 'error' });
      expect(await new GhOwnershipResolver(runner(ok('{"author":{"login":"bad login"}}')).run).lookup(PR)).toMatchObject({ status: 'error' });
    });
  });

  describe('issues', () => {
    it('uses gh api with the explicit repo', async () => {
      const { run, calls } = runner(ok('{"number":7,"user":{"login":"stranger"}}'));
      await expect(new GhOwnershipResolver(run).lookup(ISSUE)).resolves.toEqual({ status: 'resolved', authorLogin: 'stranger', number: 7 });
      expect(calls[0][0][0]).toBe('api');
      expect(calls[0][0][1]).toBe('repos/o/r/issues/7');
    });

    it('lets gh fill in the repo placeholders when none is given', async () => {
      const { run, calls } = runner(ok('{"number":7,"user":{"login":"x"}}'));
      await new GhOwnershipResolver(run).lookup({ ...ISSUE, repo: undefined });
      expect(calls[0][0][1]).toBe('repos/{owner}/{repo}/issues/7');
    });

    it('accepts issue URLs and #-prefixed numbers', async () => {
      const { run, calls } = runner(ok('{"number":5,"user":{"login":"x"}}'));
      const resolver = new GhOwnershipResolver(run);
      await resolver.lookup({ ...ISSUE, repo: undefined, selector: 'https://github.com/a/b/issues/5' });
      expect(calls[0][0][1]).toBe('repos/a/b/issues/5');
      await resolver.lookup({ ...ISSUE, selector: '#5' });
      expect(calls[1][0][1]).toBe('repos/o/r/issues/5');
    });

    it('maps HTTP 404 to not_found and rejects non-numeric selectors', async () => {
      expect(await new GhOwnershipResolver(runner(fail('gh: Not Found (HTTP 404)')).run).lookup(ISSUE)).toEqual({ status: 'not_found' });
      expect(await new GhOwnershipResolver(runner(ok('{}')).run).lookup({ ...ISSUE, selector: 'abc' })).toMatchObject({ status: 'error' });
      expect(await new GhOwnershipResolver(runner(ok('{}')).run).lookup({ ...ISSUE, selector: undefined })).toMatchObject({ status: 'error' });
    });
  });

  describe('branches', () => {
    it('finds the open PR whose head is the branch', async () => {
      const { run, calls } = runner(ok('[{"author":{"login":"teammate"},"number":44}]'));
      await expect(new GhOwnershipResolver(run).lookup(BRANCH)).resolves.toEqual({ status: 'resolved', authorLogin: 'teammate', number: 44 });
      expect(calls[0][0]).toEqual(['pr', 'list', '--head', 'feature/x', '--state', 'open', '--json', 'author,number', '--limit', '5']);
    });

    it('reports not_found when no open PR uses the branch', async () => {
      expect(await new GhOwnershipResolver(runner(ok('[]')).run).lookup(BRANCH)).toEqual({ status: 'not_found' });
    });

    it('falls back to the current-branch PR for a bare push', async () => {
      const { run, calls } = runner(ok('{"author":{"login":"me"},"number":2}'));
      await new GhOwnershipResolver(run).lookup({ ...BRANCH, branch: undefined });
      expect(calls[0][0]).toEqual(['pr', 'view', '--json', 'author,number']);
    });

    it('rejects branch names that look like flags', async () => {
      const { run, calls } = runner(ok('[]'));
      expect(await new GhOwnershipResolver(run).lookup({ ...BRANCH, branch: '-f' })).toMatchObject({ status: 'error' });
      expect(calls).toHaveLength(0);
    });

    it('reports an error on non-array output', async () => {
      expect(await new GhOwnershipResolver(runner(ok('{}')).run).lookup(BRANCH)).toMatchObject({ status: 'error' });
    });
  });

  describe('owner identity', () => {
    it('returns the authenticated login', async () => {
      const { run, calls } = runner(ok('mickdarling\n'));
      await expect(new GhOwnershipResolver(run).resolveOwnerLogin()).resolves.toBe('mickdarling');
      expect(calls[0][0]).toEqual(['api', 'user', '--jq', '.login']);
    });

    it('returns undefined when gh is not authenticated or output is invalid', async () => {
      expect(await new GhOwnershipResolver(runner(fail('not logged in', 4)).run).resolveOwnerLogin()).toBeUndefined();
      expect(await new GhOwnershipResolver(runner(ok('not a login!')).run).resolveOwnerLogin()).toBeUndefined();
    });
  });

  it('reports an error for unresolvable intents without calling gh', async () => {
    const { run, calls } = runner(ok(''));
    expect(await new GhOwnershipResolver(run).lookup({ kind: 'unresolvable', action: 'x', source: 'x' })).toMatchObject({ status: 'error' });
    expect(calls).toHaveLength(0);
  });
});

describe('resolveGhBinary', () => {
  it('ignores a relative override and returns undefined when nothing is on an empty PATH', () => {
    // No well-known path is guaranteed on CI, so only assert the shape of the contract.
    const result = resolveGhBinary({ PATH: '', DOLLHOUSE_GH_PATH: 'relative/gh' });
    expect(result === undefined || result.startsWith('/')).toBe(true);
  });
});

describe('OwnershipCache', () => {
  it('never caches current-branch lookups', () => {
    expect(ownershipCacheKey({ ...PR, selector: undefined })).toBeUndefined();
    expect(ownershipCacheKey({ ...BRANCH, branch: undefined })).toBeUndefined();
    expect(ownershipCacheKey({ kind: 'unresolvable', action: 'x', source: 'x' })).toBeUndefined();
    const cache = new OwnershipCache();
    cache.set('s', { ...PR, selector: undefined }, { status: 'resolved', authorLogin: 'me' });
    expect(cache.size).toBe(0);
  });

  it('keys explicit targets by kind, repo and selector', () => {
    expect(ownershipCacheKey(PR)).toBe('pr||12');
    expect(ownershipCacheKey(ISSUE)).toBe('issue|o/r|7');
    expect(ownershipCacheKey(BRANCH)).toBe('branch||feature/x');
  });

  it('returns cached results per session and isolates sessions', () => {
    const cache = new OwnershipCache();
    cache.set('a', PR, { status: 'resolved', authorLogin: 'x' });
    expect(cache.get('a', PR)).toEqual({ status: 'resolved', authorLogin: 'x' });
    expect(cache.get('b', PR)).toBeUndefined();
    cache.clearSession('a');
    expect(cache.get('a', PR)).toBeUndefined();
  });

  it('never caches errors so a failed lookup is retried', () => {
    const cache = new OwnershipCache();
    cache.set('a', PR, { status: 'error', message: 'boom' });
    expect(cache.get('a', PR)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('expires resolved and not_found entries on their own TTLs', () => {
    let now = 1_000;
    const cache = new OwnershipCache({ resolvedTtlMs: 100, notFoundTtlMs: 10, now: () => now });
    cache.set('a', PR, { status: 'resolved', authorLogin: 'x' });
    cache.set('a', BRANCH, { status: 'not_found' });
    now += 11;
    expect(cache.get('a', BRANCH)).toBeUndefined();
    expect(cache.get('a', PR)).toBeDefined();
    now += 100;
    expect(cache.get('a', PR)).toBeUndefined();
  });

  it('bounds sessions and entries per session', () => {
    const cache = new OwnershipCache({ maxSessions: 2, maxEntriesPerSession: 2 });
    cache.set('s1', PR, { status: 'resolved', authorLogin: 'x' });
    cache.set('s2', PR, { status: 'resolved', authorLogin: 'x' });
    cache.set('s3', PR, { status: 'resolved', authorLogin: 'x' });
    expect(cache.get('s1', PR)).toBeUndefined();
    expect(cache.get('s3', PR)).toBeDefined();

    cache.set('s3', ISSUE, { status: 'resolved', authorLogin: 'x' });
    cache.set('s3', BRANCH, { status: 'resolved', authorLogin: 'x' });
    expect(cache.get('s3', PR)).toBeUndefined();
    expect(cache.get('s3', BRANCH)).toBeDefined();
  });
});
