/**
 * Unit tests for OwnershipPolicyService (Issue #3153): config + resolver +
 * cache composition, strictest-decision merging and fail-closed behaviour.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { OwnershipPolicyService } from '../../../../../src/handlers/mcp-aql/policies/OwnershipPolicyService.js';
import { GhOwnershipResolver, OwnershipCache, type GhRunner, type OwnershipResolver } from '../../../../../src/handlers/mcp-aql/policies/OwnershipLookup.js';
import type { GitHubMutationIntent, OwnershipLookupResult, OwnershipPolicyConfig } from '../../../../../src/handlers/mcp-aql/policies/OwnershipPolicy.js';

const CONFIG: OwnershipPolicyConfig = { mode: 'deny', ownerLogin: 'mickdarling', teammates: ['insomnolence'] };

/** `ownerLogin: null` simulates gh being unable to report the authenticated user. */
function fakeResolver(authors: Record<string, OwnershipLookupResult | Error>, ownerLogin: string | null | Error = 'mickdarling') {
  const lookup = jest.fn(async (intent: GitHubMutationIntent): Promise<OwnershipLookupResult> => {
    const key = intent.selector ?? intent.branch ?? '@current';
    const result = authors[key];
    if (result instanceof Error) throw result;
    return result ?? { status: 'not_found' };
  });
  const resolveOwnerLogin = jest.fn(async (): Promise<string | undefined> => {
    if (ownerLogin instanceof Error) throw ownerLogin;
    return ownerLogin ?? undefined;
  });
  const resolver: OwnershipResolver = { lookup, resolveOwnerLogin };
  return { resolver, lookup, resolveOwnerLogin };
}

const resolved = (authorLogin: string): OwnershipLookupResult => ({ status: 'resolved', authorLogin });

describe('OwnershipPolicyService', () => {
  it('returns undefined for tool calls that do not modify GitHub state', async () => {
    const { resolver, lookup } = fakeResolver({});
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    expect(await service.evaluate('Bash', { command: 'gh pr view 1' })).toBeUndefined();
    expect(await service.evaluate('Bash', { command: 'gh pr comment 1 --body hi' })).toBeUndefined();
    expect(await service.evaluate('Edit', { file_path: 'x' })).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns undefined when the policy is off, without looking anything up', async () => {
    const { resolver, lookup } = fakeResolver({ '1': resolved('stranger') });
    const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'off' }, resolver, cache: new OwnershipCache() });
    expect(await service.evaluate('Bash', { command: 'gh pr merge 1' })).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allows the owner\'s PR and denies a stranger\'s', async () => {
    const { resolver } = fakeResolver({ '1': resolved('mickdarling'), '2': resolved('stranger') });
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    expect((await service.evaluate('Bash', { command: 'gh pr merge 1' }))?.behavior).toBe('allow');
    expect((await service.evaluate('Bash', { command: 'gh pr merge 2' }))?.behavior).toBe('deny');
  });

  it('passes cwd to the resolver so gh can infer the repo and current branch', async () => {
    const { resolver, lookup } = fakeResolver({ '@current': resolved('mickdarling') });
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    await service.evaluate('Bash', { command: 'git push' }, { cwd: '/work/repo', sessionId: 's' });
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ kind: 'branch' }), { cwd: '/work/repo' });
  });

  it('returns the strictest decision across several mutations in one command', async () => {
    const { resolver } = fakeResolver({ '1': resolved('mickdarling'), 'feature/x': resolved('stranger') });
    const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
    const decision = await service.evaluate('Bash', { command: 'gh pr merge 1 && git push origin feature/x' });
    expect(decision?.behavior).toBe('confirm');
    expect(decision?.reason).toMatch(/feature\/x/);
  });

  it('fails closed when the lookup throws', async () => {
    const { resolver } = fakeResolver({ '1': new Error('socket hang up') });
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    const decision = await service.evaluate('Bash', { command: 'gh pr close 1' });
    expect(decision?.behavior).toBe('confirm');
    expect(decision?.reason).toMatch(/socket hang up/);
  });

  it('fails closed for GraphQL mutations and MCP calls without a target', async () => {
    const { resolver, lookup } = fakeResolver({});
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    expect((await service.evaluate('Bash', { command: "gh api graphql -f query='mutation { x }'" }))?.behavior).toBe('confirm');
    expect((await service.evaluate('mcp__github__merge_pull_request', { owner: 'o', repo: 'r' }))?.behavior).toBe('confirm');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    'cd ../other && gh pr merge 5',
    'pushd ../other; gh pr merge 5',
    'GH_REPO=org/other gh pr merge 5',
    'env GH_REPO=org/other gh pr merge 5',
    'git -C ../other push origin feature/x',
    'git --git-dir=../other/.git push origin feature/x',
    'git --work-tree=../other push origin feature/x',
  ])('never uses a cwd lookup to allow a redirected mutation: %s', async (command) => {
    for (const result of [resolved('mickdarling'), { status: 'not_found' } as const]) {
      const lookup = jest.fn<OwnershipResolver['lookup']>().mockResolvedValue(result);
      const service = new OwnershipPolicyService({
        config: { ...CONFIG, mode: 'confirm' },
        resolver: { lookup, resolveOwnerLogin: async () => 'mickdarling' },
        cache: new OwnershipCache(),
      });
      expect((await service.evaluate('Bash', { command }, { cwd: '/work/original' }))?.behavior).toBe('confirm');
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it('allows pushes to branches with no open PR', async () => {
    const { resolver } = fakeResolver({});
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    expect((await service.evaluate('Bash', { command: 'git push origin scratch' }))?.behavior).toBe('allow');
  });

  describe('bulk, substitution and length regressions', () => {
    it('cannot let an owner-authored first issue authorize an unowned second issue', async () => {
      const { resolver, lookup } = fakeResolver({ '23': resolved('mickdarling'), '34': resolved('stranger') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'gh issue edit 23 34 --add-label bug' }))?.behavior).toBe('confirm');
      expect(lookup).not.toHaveBeenCalled();
    });

    it('checks authorship inside a double-quoted substitution', async () => {
      const { resolver, lookup } = fakeResolver({ '7': resolved('stranger') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'echo "$(gh pr close 7)"' }))?.behavior).toBe('confirm');
      expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ selector: '7' }), { cwd: undefined });
    });

    it('still allows a trusted author inside a resolvable substitution', async () => {
      const { resolver } = fakeResolver({ '7': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'echo "$(gh pr close 7)"' }))?.behavior).toBe('allow');
    });

    it.each(['confirm', 'deny'] as const)('keeps quoted oversized mutations gated in %s mode', async (mode) => {
      const { resolver, lookup } = fakeResolver({ '7': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode }, resolver, cache: new OwnershipCache() });
      const command = '"gh" pr close 7; #' + ' '.repeat(4000);
      expect((await service.evaluate('Bash', { command }))?.behavior).toBe('confirm');
      expect(lookup).not.toHaveBeenCalled();
    });

    it('fails closed without a lookup when a command exceeds the inspection limit', async () => {
      const { resolver, lookup } = fakeResolver({ '7': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: ' '.repeat(4000) + 'gh pr close 7' }))?.behavior).toBe('confirm');
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'commit heredoc', command: "git commit -m \"$(cat <<'EOF'\nSubject\nBody\nEOF\n)\"" },
      { name: 'PR-create heredoc', command: "gh pr create --title t --body \"$(cat <<'EOF'\nSummary\nEOF\n)\"" },
      { name: 'long local script', command: "python - <<'EOF'\n" + 'print(1)\n'.repeat(600) + 'EOF\n' },
      { name: 'long local file write', command: 'cat > example.txt <<"EOF"\n' + 'local data\n'.repeat(600) + 'EOF\n' },
    ])('does not request ownership confirmation for $name', async ({ command }) => {
      const { resolver, lookup, resolveOwnerLogin } = fakeResolver({});
      const service = new OwnershipPolicyService({ config: { mode: 'confirm', teammates: [] }, resolver, cache: new OwnershipCache() });
      expect(await service.evaluate('Bash', { command })).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
      expect(resolveOwnerLogin).not.toHaveBeenCalled();
    });

    it('still confirms executable mutation contents of an unquoted heredoc', async () => {
      const { resolver } = fakeResolver({ '7': resolved('stranger') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'echo "$(cat <<EOF\n$(gh pr close 7)\nEOF\n)"' }))?.behavior).toBe('confirm');
    });

    it('does not guess the repository inherited by a substitution under a repository prefix', async () => {
      const { resolver, lookup } = fakeResolver({ '7': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'GH_REPO=other/repo echo "$(gh pr close 7)"' }))?.behavior).toBe('confirm');
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('resolver boundary regressions', () => {
    it.each([
      'gh pr close https://github.com/actual/target/pull/12 --repo decoy/repo',
      'gh issue close https://github.com/actual/target/issues/12 --repo decoy/repo',
    ])('gates the URL target rather than a trusted or absent decoy: %s', async (command) => {
      for (const decoyIsMissing of [false, true]) {
        const run = jest.fn<GhRunner>().mockImplementation(async args => {
          const actual = args.includes('actual/target') || args.some(arg => arg.includes('repos/actual/target/issues/'));
          if (!actual && decoyIsMissing) return { stdout: '', stderr: 'HTTP 404', exitCode: 1 };
          const login = actual ? 'stranger' : 'mickdarling';
          return { stdout: JSON.stringify({ author: { login }, user: { login }, number: 12 }), stderr: '', exitCode: 0 };
        });
        const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver: new GhOwnershipResolver(run), cache: new OwnershipCache() });
        expect((await service.evaluate('Bash', { command }))?.behavior).toBe('confirm');
      }
    });

    it.each(['gh pr merge 5', 'gh issue close 5', 'git push origin feature/x', 'git push'])('gates an invalid supplied cwd before any lookup: %s', async (command) => {
      const run = jest.fn<GhRunner>().mockResolvedValue({ stdout: '{"author":{"login":"mickdarling"},"number":5}', stderr: '', exitCode: 0 });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver: new GhOwnershipResolver(run), cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command }, { cwd: 'relative/other-checkout' }))?.behavior).toBe('confirm');
      expect(run).not.toHaveBeenCalled();
    });

    it('gates a truncated list of trusted branch authors', async () => {
      const run = jest.fn<GhRunner>().mockResolvedValue({
        stdout: JSON.stringify(Array.from({ length: 5 }, (_, number) => ({ author: { login: 'mickdarling' }, number }))), stderr: '', exitCode: 0,
      });
      const service = new OwnershipPolicyService({ config: { ...CONFIG, mode: 'confirm' }, resolver: new GhOwnershipResolver(run), cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'git push origin feature/x' }))?.behavior).toBe('confirm');
    });
  });

  describe('caching', () => {
    it.each(['gh pr merge 5', 'gh issue close 5', 'git push origin feature/x'])(
      're-resolves implicit repositories across cwd changes without session_id: %s',
      async (command) => {
        const lookup = jest.fn<OwnershipResolver['lookup']>().mockImplementation(async (_intent, context) =>
          resolved(context?.cwd === '/work/repo-a' ? 'mickdarling' : 'stranger'));
        const service = new OwnershipPolicyService({
          config: { ...CONFIG, mode: 'confirm' },
          resolver: { lookup, resolveOwnerLogin: async () => 'mickdarling' },
          cache: new OwnershipCache(),
        });
        expect((await service.evaluate('Bash', { command }, { cwd: '/work/repo-a' }))?.behavior).toBe('allow');
        expect((await service.evaluate('Bash', { command }, { cwd: '/work/repo-b' }))?.behavior).toBe('confirm');
        expect(lookup).toHaveBeenCalledTimes(2);
      },
    );

    it('does not reuse an implicit target even when cwd and session are unchanged', async () => {
      const lookup = jest.fn<OwnershipResolver['lookup']>()
        .mockResolvedValueOnce(resolved('mickdarling'))
        .mockResolvedValueOnce(resolved('stranger'));
      const service = new OwnershipPolicyService({
        config: { ...CONFIG, mode: 'confirm' },
        resolver: { lookup, resolveOwnerLogin: async () => 'mickdarling' },
        cache: new OwnershipCache(),
      });
      const context = { cwd: '/work/repo', sessionId: 'shared' };
      expect((await service.evaluate('Bash', { command: 'gh pr merge 5' }, context))?.behavior).toBe('allow');
      expect((await service.evaluate('Bash', { command: 'gh pr merge 5' }, context))?.behavior).toBe('confirm');
    });

    it('caches explicit PR lookups per session and re-resolves current-branch lookups', async () => {
      const { resolver, lookup } = fakeResolver({ '1': resolved('mickdarling'), '@current': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'a' });
      await service.evaluate('Bash', { command: 'gh pr edit 1 --repo o/r --title x' }, { sessionId: 'a' });
      expect(lookup).toHaveBeenCalledTimes(1);

      await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'b' });
      expect(lookup).toHaveBeenCalledTimes(2);

      await service.evaluate('Bash', { command: 'git push' }, { sessionId: 'a' });
      await service.evaluate('Bash', { command: 'git push' }, { sessionId: 'a' });
      expect(lookup).toHaveBeenCalledTimes(4);
    });

    it('does not cache errors, so the next call retries', async () => {
      const authors: Record<string, OwnershipLookupResult | Error> = { '1': { status: 'error', message: 'offline' } };
      const { resolver, lookup } = fakeResolver(authors);
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'a' }))?.behavior).toBe('confirm');
      authors['1'] = resolved('mickdarling');
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'a' }))?.behavior).toBe('allow');
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('clears a session\'s cache on request', async () => {
      const { resolver, lookup } = fakeResolver({ '1': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'a' });
      service.clearSession('a');
      await service.evaluate('Bash', { command: 'gh pr merge 1 --repo o/r' }, { sessionId: 'a' });
      expect(lookup).toHaveBeenCalledTimes(2);
    });
  });

  describe('owner identity resolution', () => {
    it('resolves the owner from gh once and reuses it', async () => {
      const { resolver, resolveOwnerLogin } = fakeResolver({ '1': resolved('mickdarling'), '2': resolved('mickdarling') }, 'mickdarling');
      const service = new OwnershipPolicyService({ config: { mode: 'deny', teammates: [] }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1' }))?.behavior).toBe('allow');
      expect((await service.evaluate('Bash', { command: 'gh pr merge 2' }))?.behavior).toBe('allow');
      expect(resolveOwnerLogin).toHaveBeenCalledTimes(1);
    });

    it('de-duplicates concurrent owner lookups onto a single gh call', async () => {
      let release: (login: string) => void = () => undefined;
      const resolveOwnerLogin = jest.fn(() => new Promise<string | undefined>((resolve) => { release = resolve; }));
      const lookup = jest.fn(async (): Promise<OwnershipLookupResult> => resolved('mickdarling'));
      const service = new OwnershipPolicyService({ config: { mode: 'deny', teammates: [] }, resolver: { lookup, resolveOwnerLogin }, cache: new OwnershipCache() });
      const pending = Promise.all([
        service.evaluate('Bash', { command: 'gh pr merge 1' }),
        service.evaluate('Bash', { command: 'gh pr merge 2' }),
        service.evaluate('Bash', { command: 'gh pr close 3' }),
      ]);
      await Promise.resolve();
      release('mickdarling');
      const decisions = await pending;
      expect(decisions.map(d => d?.behavior)).toEqual(['allow', 'allow', 'allow']);
      expect(resolveOwnerLogin).toHaveBeenCalledTimes(1);
    });

    it('does not call gh for the owner when one is configured', async () => {
      const { resolver, resolveOwnerLogin } = fakeResolver({ '1': resolved('mickdarling') });
      await new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() }).evaluate('Bash', { command: 'gh pr merge 1' });
      expect(resolveOwnerLogin).not.toHaveBeenCalled();
    });

    it('fails closed when the owner cannot be resolved, and retries next time', async () => {
      const { resolver, resolveOwnerLogin } = fakeResolver({ '1': resolved('mickdarling') }, null);
      const service = new OwnershipPolicyService({ config: { mode: 'deny', teammates: [] }, resolver, cache: new OwnershipCache() });
      const decision = await service.evaluate('Bash', { command: 'gh pr merge 1' });
      expect(decision?.behavior).toBe('confirm');
      expect(decision?.reason).toMatch(/not configured or could not be resolved/);
      await service.evaluate('Bash', { command: 'gh pr merge 1' });
      expect(resolveOwnerLogin).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the owner lookup throws', async () => {
      const { resolver } = fakeResolver({ '1': resolved('mickdarling') }, new Error('keyring locked'));
      const service = new OwnershipPolicyService({ config: { mode: 'deny', teammates: [] }, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1' }))?.behavior).toBe('confirm');
    });

    it('re-resolves the owner after the identity TTL expires', async () => {
      let now = 0;
      const { resolver, resolveOwnerLogin } = fakeResolver({ '1': resolved('mickdarling') }, 'mickdarling');
      const service = new OwnershipPolicyService({ config: { mode: 'deny', teammates: [] }, resolver, cache: new OwnershipCache(), ownerLoginTtlMs: 100, now: () => now });
      await service.evaluate('Bash', { command: 'gh pr merge 1' });
      now = 101;
      await service.evaluate('Bash', { command: 'gh pr merge 1' });
      expect(resolveOwnerLogin).toHaveBeenCalledTimes(2);
    });
  });
});
