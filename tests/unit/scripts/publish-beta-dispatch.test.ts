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
        [[ "$API_FAIL" != true ]] || return 1
        case "$*" in
          *publish-npm.yml/dispatches*) printf '%s\\n' "$NPM_RUN_ID" ;;
          *publish-github-packages.yml/dispatches*) printf '202\\n' ;;
          *publish-mcpb.yml/dispatches*) printf '303\\n' ;;
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
    NPM_PUBLISH_COMPLETE: 'false', NPM_RUN_ID: '101', API_FAIL: 'false', FAILED_RUN: '',
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
    expect(result.commands[1]).toContain('inputs[dry_run]=false');
    expect(result.commands[2]).toContain('inputs[tag_name]=v2.1.0-beta.2');
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

  it('fails if its own returned run fails, regardless of other same-SHA runs', () => {
    expect(run({ FAILED_RUN: '202' }).status).toBe(1);
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
