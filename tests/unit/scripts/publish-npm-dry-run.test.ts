import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

type Step = { name?: string; run?: string };
const workflow = load(readFileSync(resolve('.github/workflows/publish-npm.yml'), 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};
const dryRun = workflow.jobs['publish-npm'].steps.find(step => step.name === 'Dry run (skip publish)');
if (!dryRun?.run) throw new Error('Server publish dry-run step is missing');
// GitHub expands this display-only expression before invoking the shell.
const script = dryRun.run.replaceAll('${{ steps.package_version.outputs.version }}', 'test-source-version');

function runDryRun(tag: string) {
  // Run the actual workflow shell with a closed npm stub: no package changes or
  // network publication. Execute the real lifecycle channel guard at publish.
  return spawnSync('bash', ['-euo', 'pipefail', '-c', `
    npm() {
      if [[ "$#" == 3 && "$1" == pkg && "$2" == set && "$3" == version=* ]]; then
        export npm_package_version="\${3#version=}"
      elif [[ "$#" == 4 && "$1" == publish && "$2" == --dry-run && "$3" == --tag ]]; then
        export npm_config_tag="$4"
        "$TEST_NODE" "$TEST_GUARD"
        printf 'DRY_RUN_RESULT=%s:%s\\n' "$npm_package_version" "$npm_config_tag"
      else
        echo 'Unexpected npm command' >&2
        return 99
      fi
    }
    ${script}
  `], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      DIST_TAG: tag,
      GITHUB_RUN_ID: '123456789',
      TEST_NODE: process.execPath,
      TEST_GUARD: resolve('scripts/verify-publish-channel.mjs')
    }
  });
}

describe('npm workflow dry-run and lifecycle channel contract', () => {
  it.each([
    ['latest', '0.0.123456789'],
    ['alpha', '0.0.0-alpha.dry-run.123456789'],
    ['beta', '0.0.0-beta.dry-run.123456789'],
    ['rc', '0.0.0-rc.dry-run.123456789']
  ])('keeps the %s channel valid with an unpublished temporary version', (tag, version) => {
    const result = runDryRun(tag);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`DRY_RUN_RESULT=${version}:${tag}`);
  });

  it.each([['rc', 0], ['next', 1], ['latest', 1], ['beta', 1]])('enforces the real RC prepublish guard for tag %s', (tag, status) => {
    const result = spawnSync(process.execPath, [resolve('scripts/verify-publish-channel.mjs')], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, npm_package_version: '2.1.0-rc.1', npm_config_tag: String(tag) }
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status === 0) expect(result.stdout).toContain('Publish channel OK');
    else expect(result.stderr).toContain('npm publish --tag rc');
  });

  it('rejects unsupported channels before invoking npm', () => {
    const result = runDryRun('dry-run');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Unsupported dry-run channel');
    expect(result.stdout).not.toContain('DRY_RUN_RESULT=');
  });
});
