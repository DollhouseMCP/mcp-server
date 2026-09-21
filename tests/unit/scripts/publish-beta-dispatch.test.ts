import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

const workflow = load(readFileSync('.github/workflows/publish-beta-release.yml', 'utf8')) as {
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};
const script = workflow.jobs['publish-beta'].steps.find(step => step.name === 'Dispatch and verify beta artifact publishers')?.run;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function run(overrides: Record<string, string> = {}) {
  if (!script) throw new Error('Missing actual dispatch script');
  const directory = mkdtempSync(join(tmpdir(), 'beta-publisher-'));
  directories.push(directory);
  const log = join(directory, 'commands').replaceAll('\\', '/');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `
    gh() {
      printf '%s\\n' "$*" >> "$COMMAND_LOG"
      if [[ "$1" == api ]]; then
        [[ "$*" == *'X-GitHub-Api-Version: 2026-03-10'* && "$*" == *'ref=v2.1.0-beta.2'* ]] || return 99
        [[ "$API_FAIL" != true && "$*" != *"$FAILED_WORKFLOW"* ]] || return 1
        case "$*" in
          *publish-npm.yml/dispatches*) printf '%s\\n' "$NPM_RUN_ID" ;;
          *publish-github-packages.yml/dispatches*) printf '%s\\n' "$PACKAGES_RUN_ID" ;;
          *publish-mcpb.yml/dispatches*) printf '%s\\n' "$MCPB_RUN_ID" ;;
          *) return 99 ;;
        esac
      elif [[ "$1 $2" == 'run watch' ]]; then
        [[ "$3" != "$FAILED_RUN" ]]
      else
        # No workflow dispatch/search fallback can select an unrelated same-SHA run.
        return 99
      fi
    }
    ${script}
  `], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
    GITHUB_REPOSITORY: 'DollhouseMCP/mcp-server', TAG_NAME: 'v2.1.0-beta.2',
    NPM_PUBLISH_COMPLETE: 'false', NPM_RUN_ID: '101', PACKAGES_RUN_ID: '202', MCPB_RUN_ID: '303',
    API_FAIL: 'false', FAILED_WORKFLOW: 'no-matching-workflow', FAILED_RUN: '',
    COMMAND_LOG: log, ...overrides } });
  return { ...result, commands: readFileSync(log, 'utf8').trim().split('\n') };
}

describe('beta publisher dispatch identity', () => {
  it('watches exactly the IDs returned by each dispatch and preserves inputs', () => {
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.commands.filter(command => command.startsWith('run'))).toEqual([
      'run watch 101 --exit-status', 'run watch 202 --exit-status', 'run watch 303 --exit-status'
    ]);
    expect(result.commands[0]).toContain('inputs[dry_run]=false');
    expect(result.commands[2]).toContain('inputs[dry_run]=false');
    expect(result.commands[4]).toContain('inputs[tag_name]=v2.1.0-beta.2');
    expect(result.commands.map(command => command.startsWith('api') ? 'dispatch' : command)).toEqual([
      'dispatch', 'run watch 101 --exit-status', 'dispatch', 'run watch 202 --exit-status',
      'dispatch', 'run watch 303 --exit-status'
    ]);
  });

  it.each(['', 'null', '0', '-1', '101\n999'])('fails closed on ambiguous dispatch ID %j without redispatch/search', NPM_RUN_ID => {
    const result = run({ NPM_RUN_ID });
    expect(result.status).toBe(1);
    expect(result.commands).toHaveLength(1);
  });

  it('does not retry an API failure that may have accepted the request', () => {
    const result = run({ API_FAIL: 'true' });
    expect(result.status).toBe(1);
    expect(result.commands).toHaveLength(1);
  });

  it.each([['101', 2], ['202', 4], ['303', 6]])('stops after publisher %s fails before dispatching another', (FAILED_RUN, commandCount) => {
    const result = run({ FAILED_RUN: String(FAILED_RUN) });
    expect(result.status).toBe(1);
    expect(result.commands).toHaveLength(Number(commandCount));
    expect(result.commands.at(-1)).toBe(`run watch ${FAILED_RUN} --exit-status`);
  });

  it.each([
    [{ FAILED_WORKFLOW: 'publish-github-packages.yml' }, 3, '101'],
    [{ PACKAGES_RUN_ID: '' }, 3, '101'],
    [{ FAILED_WORKFLOW: 'publish-mcpb.yml' }, 5, '202'],
    [{ MCPB_RUN_ID: '' }, 5, '202']
  ] as const)('finishes earlier known publishers before a later dispatch fails: %j', (overrides, count, previousRun) => {
    const result = run(overrides);
    expect(result.status).toBe(1);
    expect(result.commands).toHaveLength(count);
    expect(result.commands.at(-2)).toBe(`run watch ${previousRun} --exit-status`);
    expect(result.commands.at(-1)).toMatch(/^api /);
  });

  it('retries missing artifacts without dispatching completed npm publication', () => {
    const result = run({ NPM_PUBLISH_COMPLETE: 'true' });
    expect(result.status).toBe(0);
    expect(result.commands.some(command => command.includes('publish-npm.yml'))).toBe(false);
    expect(result.commands.filter(command => command.startsWith('run'))).toEqual([
      'run watch 202 --exit-status', 'run watch 303 --exit-status'
    ]);
  });
});

describe('beta publisher source safety', () => {
  const guard = workflow.jobs['publish-beta'].steps.find(step => step.name === 'Verify selected and default-branch publisher safety')?.run;
  const selectedSha = '0123456789abcdef0123456789abcdef01234567';
  const workflows = ['publish-npm.yml', 'publish-github-packages.yml', 'publish-mcp-registry.yml'];

  function check(overrides: Record<string, string> = {}) {
    if (!guard) throw new Error('Missing actual publisher safety script');
    return spawnSync('bash', ['-euo', 'pipefail', '-c', `
      git() {
        if [[ "$1" == fetch ]]; then [[ "$FETCH_FAIL" != true ]]; return; fi
        [[ "$1" == show ]] || return 99
        if [[ "$2" == "$MISSING_SOURCE:.github/workflows/$MISSING_WORKFLOW" ]]; then
          printf 'unsafe publisher\\n'
          return 0
        fi
        case "$2" in
          *:'.github/workflows/publish-npm.yml') printf '%s\\n' '--tag "\${DIST_TAG}"' ;;
          *:'.github/workflows/publish-github-packages.yml') printf '%s\\n' 'steps.package_dist_tag.outputs.dist_tag' ;;
          *:'.github/workflows/publish-mcp-registry.yml') printf '%s\\n' 'github.event.release.prerelease != true' ;;
          *) return 99 ;;
        esac
        # Partial stdout must not hide a failed source read under pipefail.
        [[ "$2" != "$FAILED_SOURCE:.github/workflows/publish-npm.yml" ]]
      }
      ${guard}
    `], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
      GITHUB_SHA: selectedSha, MISSING_SOURCE: '', MISSING_WORKFLOW: '', FAILED_SOURCE: '', FETCH_FAIL: 'false', ...overrides } });
  }

  it('requires both exact selected source and main before any release mutation', () => {
    expect(check().status).toBe(0);
    expect(guard).toContain('for source in "${GITHUB_SHA}" origin/main');
    const names = workflow.jobs['publish-beta'].steps.map(step => step.name);
    expect(names.indexOf('Verify selected and default-branch publisher safety')).toBeLessThan(names.indexOf('Create beta tag and GitHub prerelease'));
  });

  it.each([selectedSha, 'origin/main'].flatMap(source => workflows.map(file => [source, file])))('rejects missing guard in %s %s', (MISSING_SOURCE, MISSING_WORKFLOW) => {
    const result = check({ MISSING_SOURCE, MISSING_WORKFLOW });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::error::${MISSING_SOURCE} ${MISSING_WORKFLOW}`);
  });

  it.each([selectedSha, 'origin/main'])('rejects failed reads of %s even with guard-bearing partial stdout', FAILED_SOURCE => {
    expect(check({ FAILED_SOURCE }).status).toBe(1);
  });

  it('rejects a failed main fetch', () => {
    expect(check({ FETCH_FAIL: 'true' }).status).toBe(1);
  });
});
