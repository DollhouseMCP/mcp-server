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
