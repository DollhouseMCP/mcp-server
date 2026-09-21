import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
  jobs: Record<string, { environment: { name: string }; steps: {
    name?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>;
  }[] }>;
}
const workflow = load(readFileSync('.github/workflows/deploy-beta-alpha-vps.yml', 'utf8')) as Workflow;
const steps = workflow.jobs.deploy.steps;
function step(name: string) {
  const found = steps.find(value => value.name === name);
  if (!found) throw new Error(`Missing step ${name}`);
  return found;
}
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function run(name: string, overrides: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'beta-dispatch-'));
  directories.push(directory);
  const output = join(directory, 'output').replaceAll('\\', '/');
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', `
    npm() { printf 'COMMAND=%s\\n' "$*"; }
    ${step(name).run}
  `], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, GITHUB_REF: 'refs/heads/beta', GITHUB_OUTPUT: output,
      INPUT_ACTION: 'update', INPUT_GIT_REF: 'beta', INPUT_LOG_LEVEL: 'info',
      INPUT_DRY_RUN: 'true', INPUT_SKIP_BACKUP: 'false', DOLLHOUSE_REMOTE_SSH_TARGET: 'fixture@example.invalid',
      DOLLHOUSE_ALPHA_SSH_PRIVATE_KEY: 'fixture', DOLLHOUSE_ALPHA_KNOWN_HOSTS: 'fixture',
      DOLLHOUSE_REMOTE_SSH_IDENTITY_FILE: '/fixture/key', DOLLHOUSE_REMOTE_KNOWN_HOSTS_FILE: '/fixture/hosts',
      DOLLHOUSE_HOSTED_HOSTNAME: 'mcp.example.invalid', ...overrides }
  });
  return { ...result, output: result.status === 0 && name === 'Validate deployment request' ? readFileSync(output, 'utf8') : '' };
}

describe('manual beta deployment dispatch', () => {
  it('keeps protected beta source and safe defaults', () => {
    expect(workflow.jobs.deploy.environment.name).toBe('alpha');
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.skip_backup.default).toBe(false);
    expect(step('Checkout workflow source').with?.ref).toBe('${{ github.sha }}');
    expect(step('Run hosted remote deploy').env?.INPUT_GIT_REF).toBe('${{ steps.request.outputs.git_ref }}');
  });

  it.each(['refs/heads/main', 'refs/heads/develop', 'refs/tags/v2.1.0-beta.2'])('rejects workflow source %s', ref => {
    expect(run('Validate deployment request', { GITHUB_REF: ref }).status).toBe(1);
  });

  it.each(['beta', 'refs/heads/beta', 'v2.1.0-beta', 'v2.1.0-beta.2'])('accepts intended deploy ref %s', ref => {
    const result = run('Validate deployment request', { INPUT_GIT_REF: ref });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.output).toBe(`git_ref=${ref.replace('refs/heads/', '')}\n`);
  });

  it.each(['main', 'v2.0.42', '--upload-pack=command'])('rejects deploy ref %s', ref => {
    expect(run('Validate deployment request', { INPUT_GIT_REF: ref }).status).toBe(1);
  });

  it.each(['DOLLHOUSE_REMOTE_SSH_TARGET', 'DOLLHOUSE_ALPHA_SSH_PRIVATE_KEY', 'DOLLHOUSE_ALPHA_KNOWN_HOSTS'])('requires %s even for a dry run', field => {
      expect(run('Validate deployment request', { [field]: '' }).status).toBe(1);
    });

  it('passes dry-run and the normalized ref without skipping backups', () => {
    const result = run('Run hosted remote deploy');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--ref beta --dry-run update');
    expect(result.stdout).not.toContain('--skip-backup');
  });
});
