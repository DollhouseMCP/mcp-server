import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { load } from 'js-yaml';

interface Step { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { if?: string; permissions: Record<string, string>; steps: Step[] }
const workflow = load(readFileSync('.github/workflows/publish-npm.yml', 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> }; release: unknown };
  jobs: Record<string, Job>;
};
const safety = workflow.jobs['publish-safety'];
const server = workflow.jobs['publish-npm'];
function step(job: Job, name: string): Step {
  const found = job.steps.find(value => value.name === name);
  if (!found) throw new Error(`Missing workflow step: ${name}`);
  return found;
}
const guard = step(safety, 'Guard safety-only source');
const sha = 'a'.repeat(40);
function run(source: string, overrides: Record<string, string> = {}) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', `
    git() {
      case "$*" in
        'rev-parse HEAD') printf '%s\\n' "$CHECKOUT_SHA" ;;
        'rev-parse refs/remotes/origin/main') printf '%s\\n' "$MAIN_SHA" ;;
        'fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main') return "$FETCH_STATUS" ;;
        *) return 99 ;;
      esac
    }
    npm() { printf 'NPM_COMMAND=%s\\n' "$*"; }
    ${source}
  `], { encoding: 'utf8', timeout: 10000, env: {
    PATH: process.env.PATH, SAFETY_ONLY: 'true', EVENT_NAME: 'workflow_dispatch',
    SOURCE_REPOSITORY: 'DollhouseMCP/mcp-server', SOURCE_REF: 'refs/heads/main',
    SOURCE_SHA: sha, EXPECTED_SHA: sha, CHECKOUT_SHA: sha, MAIN_SHA: sha, FETCH_STATUS: '0',
    ...overrides,
  } });
}
function enabled(expression: string, event: string, inputs: Record<string, unknown> = {}): boolean {
  return Boolean(runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
    github: { event_name: event, event: { inputs: Object.fromEntries(
      Object.entries(inputs).map(([key, value]) => [key, String(value)]),
    ) } }, inputs, steps: { safety_version: { outputs: { needs_publish: 'true' } } },
  }, { timeout: 1000 }));
}

describe('safety-only manual publisher', () => {
  it('defaults manual dispatch to dry-run and leaves safety-only/debug opt-in', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.dry_run.default).toBe(true);
    expect(inputs.safety_only.default).toBe(false);
    expect(inputs.debug_oidc.default).toBe(false);
    expect(workflow.on.release).toEqual({ types: ['published'] });
    expect(Object.keys(workflow.jobs).sort()).toEqual(['publish-npm', 'publish-safety']);
    expect(safety.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
  });

  it('pins checkout and validates source before setup, package scripts or publication', () => {
    expect(step(safety, 'Checkout code').with).toMatchObject({ ref: '${{ github.sha }}', 'fetch-depth': 0 });
    const index = safety.steps.indexOf(guard);
    for (const name of ['Setup Node.js for npm', 'Install safety package dependencies', 'Build safety package', 'Publish safety package (with provenance)']) {
      expect(index).toBeLessThan(safety.steps.indexOf(step(safety, name)));
    }
    expect(step(safety, 'Setup Node.js for npm').env).toEqual({ NODE_AUTH_TOKEN: '' });
    const result = run(`${guard.run}\nnpm publish`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('NPM_COMMAND=publish');
  });

  it.each([
    { EVENT_NAME: 'release' }, { SOURCE_REPOSITORY: 'untrusted/fork' },
    { SOURCE_REF: 'refs/heads/beta' }, { SOURCE_REF: 'refs/tags/v1.0.3' },
    { EXPECTED_SHA: '' }, { EXPECTED_SHA: 'main' }, { SOURCE_SHA: 'b'.repeat(40) },
    { CHECKOUT_SHA: 'b'.repeat(40) }, { MAIN_SHA: 'b'.repeat(40) }, { FETCH_STATUS: '1' },
  ])('rejects untrusted or stale source before publishing: %j', overrides => {
    const result = run(`${guard.run}\nnpm publish`, overrides);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('NPM_COMMAND=');
  });

  it('preserves ordinary release behavior and skips the entire server job only in manual safety-only mode', () => {
    expect(run(guard.run!, { SAFETY_ONLY: 'false', EVENT_NAME: 'release', EXPECTED_SHA: '' }).status).toBe(0);
    expect(enabled(server.if!, 'workflow_dispatch', { safety_only: true })).toBe(false);
    expect(enabled(server.if!, 'workflow_dispatch', { safety_only: false })).toBe(true);
    expect(enabled(server.if!, 'release')).toBe(true);
  });

  it.each([true, false])('uses only the safety package and respects explicit dry_run=%s', dryRun => {
    const publish = step(safety, 'Publish safety package (with provenance)');
    const dry = step(safety, 'Dry run safety package');
    const inputs = { safety_only: true, dry_run: dryRun };
    expect(enabled(publish.if!, 'workflow_dispatch', inputs)).toBe(!dryRun);
    expect(enabled(dry.if!, 'workflow_dispatch', inputs)).toBe(dryRun);
    expect(publish).toMatchObject({ 'working-directory': 'packages/safety',
      env: { NPM_CONFIG_PROVENANCE: 'true' } });
    expect(dry).toMatchObject({ 'working-directory': 'packages/safety' });
    const result = run(dryRun ? dry.run! : publish.run!, { GITHUB_RUN_ID: '123' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(dryRun ? 'NPM_COMMAND=publish --dry-run --tag dry-run'
      : 'NPM_COMMAND=publish --provenance --access public');
    expect(enabled(publish.if!, 'release')).toBe(true);
  });

  it('only runs sanitized diagnostics when explicitly enabled on a manual dispatch', () => {
    const debug = step(server, 'Debug OIDC Environment');
    expect(enabled(debug.if!, 'workflow_dispatch', { debug_oidc: false })).toBe(false);
    expect(enabled(debug.if!, 'release', { debug_oidc: true })).toBe(false);
    expect(enabled(debug.if!, 'workflow_dispatch', { debug_oidc: true })).toBe(true);
    const result = run(debug.run!, { NODE_AUTH_TOKEN: 'token-sentinel',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://secret-sentinel', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-sentinel' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OIDC request credentials are available.');
    expect(result.stdout).not.toMatch(/token-sentinel|secret-sentinel|oidc-sentinel/);
    expect(debug.run).not.toMatch(/cat .*npmrc|env \|/);
  });
});
