/**
 * Unit tests for OwnershipPolicyService (Issue #3153): config + resolver +
 * cache composition, strictest-decision merging and fail-closed behaviour.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { OwnershipPolicyService } from '../../../../../src/handlers/mcp-aql/policies/OwnershipPolicyService.js';
import { OwnershipCache, type OwnershipResolver } from '../../../../../src/handlers/mcp-aql/policies/OwnershipLookup.js';
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

  it('allows pushes to branches with no open PR', async () => {
    const { resolver } = fakeResolver({});
    const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
    expect((await service.evaluate('Bash', { command: 'git push origin scratch' }))?.behavior).toBe('allow');
  });

  describe('caching', () => {
    it('caches explicit PR lookups per session and re-resolves current-branch lookups', async () => {
      const { resolver, lookup } = fakeResolver({ '1': resolved('mickdarling'), '@current': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'a' });
      await service.evaluate('Bash', { command: 'gh pr edit 1 --title x' }, { sessionId: 'a' });
      expect(lookup).toHaveBeenCalledTimes(1);

      await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'b' });
      expect(lookup).toHaveBeenCalledTimes(2);

      await service.evaluate('Bash', { command: 'git push' }, { sessionId: 'a' });
      await service.evaluate('Bash', { command: 'git push' }, { sessionId: 'a' });
      expect(lookup).toHaveBeenCalledTimes(4);
    });

    it('does not cache errors, so the next call retries', async () => {
      const authors: Record<string, OwnershipLookupResult | Error> = { '1': { status: 'error', message: 'offline' } };
      const { resolver, lookup } = fakeResolver(authors);
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'a' }))?.behavior).toBe('confirm');
      authors['1'] = resolved('mickdarling');
      expect((await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'a' }))?.behavior).toBe('allow');
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('clears a session\'s cache on request', async () => {
      const { resolver, lookup } = fakeResolver({ '1': resolved('mickdarling') });
      const service = new OwnershipPolicyService({ config: CONFIG, resolver, cache: new OwnershipCache() });
      await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'a' });
      service.clearSession('a');
      await service.evaluate('Bash', { command: 'gh pr merge 1' }, { sessionId: 'a' });
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
