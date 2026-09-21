import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

interface Workflow { jobs: Record<string, { steps: { name?: string; run?: string }[] }> }
function script(file: string, job: string, name: string): string {
  const workflow = load(readFileSync(`.github/workflows/${file}.yml`, 'utf8')) as Workflow;
  const source = workflow.jobs[job].steps.find(step => step.name === name)?.run;
  if (!source) throw new Error(`Missing workflow step: ${name}`);
  return source;
}

// Execute the actual workflow shell. Closed stubs prevent all network access,
// publication and package mutation while supplying a version and release flag.
function run(source: string, env: Record<string, string> = {}) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', `
    node() { printf '%s\\n' "$PACKAGE_VERSION"; }
    gh() { [[ "$1 $2" == 'release view' ]] || return 99; printf '%s\\n' "$RELEASE_PRERELEASE"; }
    npm() {
      if [[ "$1 $2" == 'pkg set' ]]; then
        printf 'VERSION=%s\\n' "$3"
      elif [[ "$1" == publish ]]; then
        printf 'PUBLISH_COMMAND=%s\\n' "$*"
      else
        echo 'Unexpected npm invocation' >&2; return 99
      fi
    }
    ${source}
  `], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GITHUB_OUTPUT: '/dev/stdout', PACKAGE_VERSION: '2.0.42',
      EVENT_NAME: 'release', RELEASE_PRERELEASE: 'false', GITHUB_RUN_ID: '123', ...env }
  });
}

const npmChannel = script('publish-npm', 'publish-npm', 'Resolve npm dist-tag');
const packageChannel = script('publish-github-packages', 'publish-gpr', 'Resolve GitHub Packages dist-tag');
const packageGuard = script('publish-github-packages', 'publish-gpr', 'Guard GitHub Packages release channel');
const bundleGuard = script('publish-mcpb', 'publish-mcpb', 'Guard release channel consistency');
const registryGuard = script('publish-mcp-registry', 'publish', 'Guard stable channel (version string, not just release flag)');

describe('release workflow channel boundaries', () => {
  it.each([
    ['2.0.42', 'latest', 'false'], ['2.1.0-alpha.1', 'alpha', 'true'],
    ['2.1.0-beta', 'beta', 'true'], ['2.1.0-beta.2', 'beta', 'true'],
    ['2.1.0-rc.1', 'next', 'true']
  ])('keeps %s on its intended %s channel', (version, tag, prerelease) => {
    for (const source of [npmChannel, packageChannel]) {
      const result = run(source, { PACKAGE_VERSION: version, RELEASE_PRERELEASE: prerelease });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`dist_tag=${tag}`);
    }
    expect(run(packageGuard, { DIST_TAG: tag, RELEASE_PRERELEASE: prerelease }).status).toBe(0);
  });

  it.each([
    ['2.0.42', 'latest', 'true'], ['2.1.0-beta.2', 'beta', 'false']
  ])('rejects a mislabeled release for %s', (version, tag, prerelease) => {
    expect(run(npmChannel, { PACKAGE_VERSION: version, RELEASE_PRERELEASE: prerelease }).status).toBe(1);
    expect(run(packageGuard, { DIST_TAG: tag, RELEASE_PRERELEASE: prerelease }).status).toBe(1);
  });

  it('rejects unsupported prerelease channels in both package publishers', () => {
    for (const source of [npmChannel, packageChannel]) {
      expect(run(source, { PACKAGE_VERSION: '2.1.0-preview.1' }).status).toBe(1);
    }
  });

  it('derives manual npm publication from the version rather than an absent release flag', () => {
    const result = run(npmChannel, { PACKAGE_VERSION: '2.1.0-beta.2', EVENT_NAME: 'workflow_dispatch' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dist_tag=beta');
  });

  it.each(['release', 'workflow_dispatch'])('permits correctly labeled stable and beta bundles via %s', event => {
    for (const [version, flag] of [['2.0.42', 'false'], ['2.1.0-beta.2', 'true']]) {
      expect(run(bundleGuard, { PACKAGE_VERSION: version, EVENT_NAME: event,
        EVENT_TAG: `v${version}`, RELEASE_PRERELEASE: flag }).status).toBe(0);
    }
  });

  it.each([
    ['2.0.42', 'v2.0.42', 'true'], ['2.1.0-beta.2', 'v2.1.0-beta.2', 'false'],
    ['2.1.0-beta.2', 'v2.0.42', 'true'], ['2.1.0-beta.2', 'v2.1.0-beta.2', 'unknown']
  ])('rejects inconsistent or unresolved bundle destination %s / %s / %s', (version, tag, flag) => {
    expect(run(bundleGuard, { PACKAGE_VERSION: version, EVENT_TAG: tag,
      EVENT_NAME: 'workflow_dispatch', RELEASE_PRERELEASE: flag }).status).toBe(1);
  });

  it.each([
    ['2.1.0-beta.2', 'refs/tags/v2.1.0-beta.2'], ['2.0.42', 'refs/tags/v2.1.0-beta.2'],
    ['2.1.0-beta.2', 'refs/heads/beta']
  ])('rejects prerelease Registry source %s / %s', (version, ref) => {
    expect(run(registryGuard, { PACKAGE_VERSION: version, SOURCE_REF: ref }).status).toBe(1);
  });

  it('preserves stable MCP Registry publication', () => {
    expect(run(registryGuard, { SOURCE_REF: 'refs/tags/v2.0.42' }).status).toBe(0);
  });

  it.each(['latest', 'beta'])('passes the resolved %s tag to both actual publish commands', tag => {
    const npm = run(script('publish-npm', 'publish-npm', 'Publish to npm (with provenance)'), { DIST_TAG: tag });
    expect(npm.status).toBe(0);
    expect(npm.stdout).toContain(`PUBLISH_COMMAND=publish --provenance --access public --tag ${tag} --loglevel verbose`);
    const packages = script('publish-github-packages', 'publish-gpr', 'Publish to GitHub Packages')
      .replaceAll('${{ steps.package_dist_tag.outputs.dist_tag }}', tag);
    const result = run(packages);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`PUBLISH_COMMAND=publish --tag ${tag}`);
  });

  it.each([
    ['latest', '0.0.123'], ['alpha', '0.0.0-alpha.dry-run.123'],
    ['beta', '0.0.0-beta.dry-run.123'], ['next', '0.0.0-rc.dry-run.123']
  ])('dry-runs %s without issuing a publishing command', (tag, version) => {
    const source = script('publish-npm', 'publish-npm', 'Dry run (skip publish)')
      .replaceAll('${{ steps.package_version.outputs.version }}', '2.1.0-beta.2');
    const result = run(source, { DIST_TAG: tag });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`VERSION=version=${version}`);
    expect(result.stdout).toContain(`PUBLISH_COMMAND=publish --dry-run --tag ${tag}`);
  });
});
