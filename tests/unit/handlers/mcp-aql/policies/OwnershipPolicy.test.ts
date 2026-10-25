/**
 * Unit tests for the authorship-aware GitHub ownership policy (Issue #3153).
 *
 * Covers config parsing, GitHub mutation detection for raw Bash `gh`/`git`
 * and GitHub MCP tools, and the pure allow/confirm/deny decision function.
 */

import { describe, it, expect } from '@jest/globals';
import {
  MAX_TEAMMATES,
  decideOwnership,
  detectGitHubMutations,
  isTrustedAuthor,
  parseOwnershipPolicyConfig,
  parseTeammateList,
  splitShellSegments,
  tokenizeShellWords,
  type GitHubMutationIntent,
  type OwnershipPolicyConfig,
} from '../../../../../src/handlers/mcp-aql/policies/OwnershipPolicy.js';

const OWNER_CONFIG: OwnershipPolicyConfig = { mode: 'deny', ownerLogin: 'mickdarling', teammates: ['insomnolence'] };

function bash(command: string): GitHubMutationIntent[] {
  return detectGitHubMutations('Bash', { command });
}

describe('OwnershipPolicy', () => {
  describe('parseOwnershipPolicyConfig', () => {
    it('defaults to confirm mode with no owner and no teammates', () => {
      const { config, warnings } = parseOwnershipPolicyConfig({});
      expect(config).toEqual({ mode: 'confirm', ownerLogin: undefined, teammates: [] });
      expect(warnings).toEqual([]);
    });

    it('parses mode case-insensitively and warns on unknown modes', () => {
      expect(parseOwnershipPolicyConfig({ mode: 'DENY' }).config.mode).toBe('deny');
      expect(parseOwnershipPolicyConfig({ mode: 'off' }).config.mode).toBe('off');
      const bad = parseOwnershipPolicyConfig({ mode: 'sometimes' });
      expect(bad.config.mode).toBe('confirm');
      expect(bad.warnings[0]).toMatch(/Unknown ownership policy mode 'sometimes'/);
    });

    it('accepts a valid owner login and strips a leading @', () => {
      expect(parseOwnershipPolicyConfig({ ownerLogin: '@mickdarling' }).config.ownerLogin).toBe('mickdarling');
    });

    it('rejects an invalid owner login and keeps the policy fail-closed', () => {
      const { config, warnings } = parseOwnershipPolicyConfig({ ownerLogin: 'not a login!' });
      expect(config.ownerLogin).toBeUndefined();
      expect(warnings[0]).toMatch(/invalid owner login/);
    });

    it('parses teammates from comma, semicolon or whitespace separated lists', () => {
      const { teammates, rejected } = parseTeammateList('insomnolence, todd-d;dependabot[bot]  @someone bad*login');
      expect(teammates).toEqual(['insomnolence', 'todd-d', 'dependabot[bot]', 'someone']);
      expect(rejected).toEqual(['bad*login']);
    });

    it('de-duplicates teammates case-insensitively', () => {
      expect(parseTeammateList('Alice,alice,ALICE').teammates).toEqual(['Alice']);
    });

    it('caps the teammate list at MAX_TEAMMATES and reports the truncation', () => {
      const exactly = Array.from({ length: MAX_TEAMMATES }, (_, i) => `user${i}`).join(',');
      expect(parseTeammateList(exactly)).toMatchObject({ truncated: 0 });
      expect(parseTeammateList(exactly).teammates).toHaveLength(MAX_TEAMMATES);

      const overflow = `${exactly},extra1,extra2`;
      const parsed = parseTeammateList(overflow);
      expect(parsed.teammates).toHaveLength(MAX_TEAMMATES);
      expect(parsed.truncated).toBe(2);
      const { warnings } = parseOwnershipPolicyConfig({ teammates: overflow });
      expect(warnings).toEqual([expect.stringMatching(/exceeds 100 entries; ignoring the last 2/)]);
    });
  });

  describe('isTrustedAuthor', () => {
    it('matches owner and teammates case-insensitively', () => {
      expect(isTrustedAuthor('MickDarling', OWNER_CONFIG)).toBe(true);
      expect(isTrustedAuthor('Insomnolence', OWNER_CONFIG)).toBe(true);
      expect(isTrustedAuthor('stranger', OWNER_CONFIG)).toBe(false);
      expect(isTrustedAuthor('', OWNER_CONFIG)).toBe(false);
    });

    it('trusts nobody when the owner is unknown and no teammates are listed', () => {
      expect(isTrustedAuthor('mickdarling', { mode: 'deny', teammates: [] })).toBe(false);
    });
  });

  describe('shell tokenizing', () => {
    it('splits on command separators but not inside quotes', () => {
      expect(splitShellSegments('git status && gh pr merge 5; echo "a;b" | cat')).toEqual([
        'git status', 'gh pr merge 5', 'echo "a;b"', 'cat',
      ]);
    });

    it('keeps an unclosed quote as a segment rather than dropping it', () => {
      expect(splitShellSegments('gh pr merge 5 --body "unterminated; git push')).toEqual(['gh pr merge 5 --body "unterminated; git push']);
      expect(bash('gh pr merge 5 --body "unterminated; git push')).toHaveLength(1);
    });

    it('exposes sub-shell contents as their own segments', () => {
      expect(splitShellSegments('echo $(gh pr close 7) `gh issue close 8`')).toEqual([
        'echo', 'gh pr close 7', 'gh issue close 8',
      ]);
    });

    it('removes quotes and honours escapes when tokenizing words', () => {
      expect(tokenizeShellWords('gh pr edit 12 --title "New title" -b \'x y\' --repo=o/r')).toEqual([
        'gh', 'pr', 'edit', '12', '--title', 'New title', '-b', 'x y', '--repo=o/r',
      ]);
      expect(tokenizeShellWords('echo a\\ b')).toEqual(['echo', 'a b']);
    });
  });

  describe('detectGitHubMutations — gh pr', () => {
    it.each(['merge', 'update-branch', 'edit', 'close', 'ready', 'reopen', 'lock', 'unlock'])(
      'reports gh pr %s with an explicit number',
      (sub) => {
        const intents = bash(`gh pr ${sub} 3153`);
        expect(intents).toHaveLength(1);
        expect(intents[0]).toMatchObject({ kind: 'pull_request', action: `gh pr ${sub}`, selector: '3153' });
      },
    );

    it('reports the current-branch PR when no selector is given', () => {
      expect(bash('gh pr merge --squash --delete-branch')).toEqual([
        expect.objectContaining({ kind: 'pull_request', action: 'gh pr merge', selector: undefined }),
      ]);
    });

    it('captures --repo and URL/branch selectors', () => {
      expect(bash('gh pr close https://github.com/DollhouseMCP/mcp-server/pull/9 -R DollhouseMCP/mcp-server')[0])
        .toMatchObject({ selector: 'https://github.com/DollhouseMCP/mcp-server/pull/9', repo: { owner: 'DollhouseMCP', name: 'mcp-server' } });
      expect(bash('gh pr ready --repo=o/r feature/x')[0]).toMatchObject({ selector: 'feature/x', repo: { owner: 'o', name: 'r' } });
    });

    it('does not mistake a flag value for the selector', () => {
      expect(bash('gh pr edit --title "Rename" --body "body text"')[0]).toMatchObject({ selector: undefined });
      expect(bash('gh pr edit --add-label bug 42')[0]).toMatchObject({ selector: '42' });
      expect(bash('gh pr edit --add-label bug')[0]).toMatchObject({ kind: 'pull_request', selector: undefined });
    });

    it.each(['gh pr view 1', 'gh pr diff 1', 'gh pr checks 1', 'gh pr comment 1 --body hi', 'gh pr review 1 --approve', 'gh pr create --fill', 'gh pr list', 'gh pr checkout 1'])(
      'does not report %s',
      (command) => {
        expect(bash(command)).toEqual([]);
      },
    );
  });

  describe('detectGitHubMutations — gh issue', () => {
    it.each(['edit', 'close', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin'])(
      'reports gh issue %s',
      (sub) => {
        expect(bash(`gh issue ${sub} 77 --repo o/r`)[0]).toMatchObject({ kind: 'issue', action: `gh issue ${sub}`, selector: '77' });
      },
    );

    it.each(['gh issue comment 77 --body hi', 'gh issue view 77', 'gh issue list', 'gh issue create --title t', 'gh issue develop 77', 'gh issue close'])(
      'does not report %s',
      (command) => {
        expect(bash(command)).toEqual([]);
      },
    );
  });

  describe('detectGitHubMutations — gh api', () => {
    it('reports mutating REST calls against pulls and issues', () => {
      expect(bash('gh api -X PATCH repos/o/r/pulls/5 -f title=x')[0]).toMatchObject({ kind: 'pull_request', selector: '5', repo: { owner: 'o', name: 'r' } });
      expect(bash('gh api --method PUT repos/o/r/pulls/5/merge')[0]).toMatchObject({ kind: 'pull_request', selector: '5' });
      expect(bash('gh api repos/o/r/issues/6 -f state=closed')[0]).toMatchObject({ kind: 'issue', selector: '6' });
      expect(bash('gh api -X DELETE /repos/o/r/issues/6/lock')[0]).toMatchObject({ kind: 'issue' });
    });

    it('treats --input without an explicit method as a POST', () => {
      expect(bash('gh api --input body.json repos/o/r/pulls/5')[0]).toMatchObject({ kind: 'pull_request', selector: '5', action: 'gh api POST pulls/5' });
    });

    it('allows GET requests and comment/review sub-resources', () => {
      expect(bash('gh api repos/o/r/pulls/5')).toEqual([]);
      expect(bash('gh api repos/o/r/issues/6/comments -f body=hi')).toEqual([]);
      expect(bash('gh api -X POST repos/o/r/pulls/5/reviews -f event=APPROVE')).toEqual([]);
    });

    it('reports GraphQL mutations as unresolvable and ignores GraphQL queries', () => {
      expect(bash("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'")[0])
        .toMatchObject({ kind: 'unresolvable', action: 'gh api graphql mutation' });
      expect(bash("gh api graphql -f query='query { viewer { login } }'")).toEqual([]);
    });
  });

  describe('detectGitHubMutations — git push', () => {
    it('reports a bare push as the current branch', () => {
      expect(bash('git push')).toEqual([expect.objectContaining({ kind: 'branch', action: 'git push', branch: undefined })]);
      expect(bash('git push -u origin HEAD')[0]).toMatchObject({ kind: 'branch', branch: undefined });
    });

    it('extracts the destination branch from refspecs', () => {
      expect(bash('git push origin feature/x')[0]).toMatchObject({ branch: 'feature/x' });
      expect(bash('git push origin HEAD:refs/heads/beta')[0]).toMatchObject({ branch: 'beta' });
      expect(bash('git push origin local:remote-branch')[0]).toMatchObject({ branch: 'remote-branch' });
      expect(bash('git push --force-with-lease=main origin main')[0]).toMatchObject({ branch: 'main' });
    });

    it('reports branch deletion and skips tag pushes', () => {
      expect(bash('git push origin --delete feature/x')[0]).toMatchObject({ action: 'git push --delete', branch: 'feature/x' });
      expect(bash('git push origin :feature/old')[0]).toMatchObject({ action: 'git push --delete', branch: 'feature/old' });
      expect(bash('git push origin :refs/heads/feature/old')[0]).toMatchObject({ action: 'git push --delete', branch: 'feature/old' });
      expect(bash('git push origin --tags')).toEqual([]);
      expect(bash('git push origin refs/tags/v1.0.0')).toEqual([]);
    });

    it('handles global git options and env prefixes', () => {
      expect(bash('GIT_SSH_COMMAND="ssh -i k" git -C /repo push origin fix/y')[0]).toMatchObject({ branch: 'fix/y' });
      expect(bash('env git -c user.name=x push')[0]).toMatchObject({ kind: 'branch', branch: undefined });
    });

    it.each(['git status', 'git fetch origin', 'git pull', 'git commit -m "push later"', 'git log --grep push'])(
      'does not report %s',
      (command) => {
        expect(bash(command)).toEqual([]);
      },
    );
  });

  describe('detectGitHubMutations — chained and wrapped commands', () => {
    it('finds mutations after safe commands in the same line', () => {
      const intents = bash('git status && gh pr merge 5 --squash; git push origin feature/z');
      expect(intents.map(i => i.action)).toEqual(['gh pr merge', 'git push']);
    });

    it('finds mutations behind absolute paths', () => {
      expect(bash('/opt/homebrew/bin/gh issue close 9')[0]).toMatchObject({ kind: 'issue', selector: '9' });
    });

    it('returns nothing for empty or non-GitHub commands', () => {
      expect(bash('')).toEqual([]);
      expect(bash('npm test')).toEqual([]);
      expect(detectGitHubMutations('Edit', { file_path: 'x' })).toEqual([]);
    });
  });

  describe('detectGitHubMutations — GitHub MCP tools', () => {
    it('reports PR mutations with pull number', () => {
      expect(detectGitHubMutations('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5 })[0])
        .toMatchObject({ kind: 'pull_request', action: 'mcp:merge_pull_request', selector: '5', repo: { owner: 'o', name: 'r' } });
      expect(detectGitHubMutations('mcp__github__update_pull_request_branch', { owner: 'o', repo: 'r', pull_number: '6' })[0])
        .toMatchObject({ kind: 'pull_request', selector: '6' });
    });

    it('reports issue mutations including consolidated issue_write updates', () => {
      expect(detectGitHubMutations('mcp__github__update_issue', { owner: 'o', repo: 'r', issue_number: 7 })[0])
        .toMatchObject({ kind: 'issue', selector: '7' });
      expect(detectGitHubMutations('mcp__github__issue_write', { owner: 'o', repo: 'r', method: 'update', issue_number: 8 })[0])
        .toMatchObject({ kind: 'issue', selector: '8' });
      expect(detectGitHubMutations('mcp__github__issue_write', { owner: 'o', repo: 'r', method: 'create', title: 't' })).toEqual([]);
    });

    it('reports branch writes', () => {
      expect(detectGitHubMutations('mcp__github__push_files', { owner: 'o', repo: 'r', branch: 'feature/q', files: [] })[0])
        .toMatchObject({ kind: 'branch', branch: 'feature/q' });
    });

    it('marks a mutation with a missing target as unresolvable', () => {
      expect(detectGitHubMutations('mcp__github__merge_pull_request', { owner: 'o', repo: 'r' })[0]).toMatchObject({ kind: 'unresolvable' });
    });

    it('ignores comment, review and read tools, and non-GitHub servers', () => {
      expect(detectGitHubMutations('mcp__github__add_issue_comment', { owner: 'o', repo: 'r', issue_number: 1, body: 'x' })).toEqual([]);
      expect(detectGitHubMutations('mcp__github__create_pull_request_review', { owner: 'o', repo: 'r', pullNumber: 1 })).toEqual([]);
      expect(detectGitHubMutations('mcp__github__get_pull_request', { owner: 'o', repo: 'r', pullNumber: 1 })).toEqual([]);
      expect(detectGitHubMutations('mcp__linear__update_issue', { id: 'LIN-1' })).toEqual([]);
    });
  });

  describe('detectGitHubMutations — Dollhouse integration_request', () => {
    it('reports mutating GitHub REST requests sent through the adapter', () => {
      expect(detectGitHubMutations('integration_request', { provider: 'github', method: 'PATCH', path: '/repos/o/r/pulls/5', body: {} })[0])
        .toMatchObject({ kind: 'pull_request', selector: '5', repo: { owner: 'o', name: 'r' }, action: 'integration_request PATCH pulls/5' });
      expect(detectGitHubMutations('mcp__dollhousemcp__mcp_aql_execute', {
        operation: 'integration_request',
        params: { provider: 'GitHub', method: 'put', path: 'repos/o/r/pulls/5/merge' },
      })[0]).toMatchObject({ kind: 'pull_request', selector: '5' });
    });

    it('ignores reads, comments and non-GitHub providers', () => {
      expect(detectGitHubMutations('integration_request', { provider: 'github', method: 'GET', path: '/repos/o/r/pulls/5' })).toEqual([]);
      expect(detectGitHubMutations('integration_request', { provider: 'github', method: 'POST', path: '/repos/o/r/issues/5/comments', body: {} })).toEqual([]);
      expect(detectGitHubMutations('integration_request', { provider: 'jira', method: 'PATCH', path: '/repos/o/r/pulls/5' })).toEqual([]);
    });
  });

  describe('decideOwnership', () => {
    const pr: GitHubMutationIntent = { kind: 'pull_request', action: 'gh pr merge', selector: '42', source: 'gh pr merge 42' };

    it('allows everything when the mode is off', () => {
      expect(decideOwnership(pr, { status: 'resolved', authorLogin: 'stranger' }, { mode: 'off', ownerLogin: 'me', teammates: [] }).behavior).toBe('allow');
    });

    it('allows mutations to the owner\'s own PR', () => {
      const decision = decideOwnership(pr, { status: 'resolved', authorLogin: 'MickDarling' }, OWNER_CONFIG);
      expect(decision.behavior).toBe('allow');
      expect(decision.policySource).toBe('ownership_policy');
    });

    it('allows mutations to a teammate\'s PR', () => {
      expect(decideOwnership(pr, { status: 'resolved', authorLogin: 'insomnolence' }, OWNER_CONFIG).behavior).toBe('allow');
    });

    it('denies a stranger\'s PR in deny mode and asks in confirm mode', () => {
      const denied = decideOwnership(pr, { status: 'resolved', authorLogin: 'stranger' }, OWNER_CONFIG);
      expect(denied.behavior).toBe('deny');
      expect(denied.reason).toMatch(/authored by 'stranger'/);
      expect(denied.reason).toMatch(/comment or review/);

      const asked = decideOwnership(pr, { status: 'resolved', authorLogin: 'stranger' }, { ...OWNER_CONFIG, mode: 'confirm' });
      expect(asked.behavior).toBe('confirm');
    });

    it('fails closed (confirm) when the lookup errored, even in deny mode', () => {
      const decision = decideOwnership(pr, { status: 'error', message: 'gh exited 1' }, OWNER_CONFIG);
      expect(decision.behavior).toBe('confirm');
      expect(decision.reason).toMatch(/lookup failed \(gh exited 1\)/);
    });

    it('fails closed when the owner identity is unknown', () => {
      const decision = decideOwnership(pr, { status: 'resolved', authorLogin: 'anyone' }, { mode: 'deny', teammates: [] });
      expect(decision.behavior).toBe('confirm');
      expect(decision.reason).toMatch(/not configured or could not be resolved/);
    });

    it('fails closed for unresolvable targets', () => {
      const intent: GitHubMutationIntent = { kind: 'unresolvable', action: 'gh api graphql mutation', source: 'gh api graphql' };
      expect(decideOwnership(intent, { status: 'not_found' }, OWNER_CONFIG).behavior).toBe('confirm');
    });

    it('allows pushes to branches without an open PR', () => {
      const push: GitHubMutationIntent = { kind: 'branch', action: 'git push', branch: 'scratch', source: 'git push origin scratch' };
      const decision = decideOwnership(push, { status: 'not_found' }, OWNER_CONFIG);
      expect(decision.behavior).toBe('allow');
      expect(decision.reason).toMatch(/no pull request or issue found/);
    });

    it('describes the current-branch PR and repo in the reason', () => {
      const intent: GitHubMutationIntent = { kind: 'pull_request', action: 'gh pr merge', repo: { owner: 'o', name: 'r' }, source: 'gh pr merge' };
      expect(decideOwnership(intent, { status: 'resolved', authorLogin: 'x' }, OWNER_CONFIG).reason)
        .toMatch(/the current branch's pull request in o\/r/);
    });
  });
});
