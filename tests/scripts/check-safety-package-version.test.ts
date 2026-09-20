import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CheckResult {
  status: 'new-version' | 'published-identical';
  version: string;
  gitHead?: string;
}

interface SafetyVersionModule {
  checkSafetyPackageVersion(options: {
    cwd: string;
    runNpm: (args: string[]) => CommandResult;
    log: () => void;
  }): CheckResult;
}

const helperUrl = pathToFileURL(
  join(process.cwd(), 'scripts', 'check-safety-package-version.mjs')
).href;
const { checkSafetyPackageVersion } = await import(helperUrl) as SafetyVersionModule;

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function registryResult(payload: unknown, status = 0, stream: 'stdout' | 'stderr' = 'stdout'): CommandResult {
  return {
    status,
    stdout: stream === 'stdout' ? JSON.stringify(payload) : '',
    stderr: stream === 'stderr' ? JSON.stringify(payload) : '',
  };
}

describe('check-safety-package-version', () => {
  let repo: string;
  let publishedGitHead: string;
  let trustedMainHead: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'safety-version-check-'));
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['config', 'user.name', 'Safety Check Test']);
    git(repo, ['config', 'user.email', 'safety-check@example.test']);

    await mkdir(join(repo, 'packages', 'safety', 'src'), { recursive: true });
    await writeFile(
      join(repo, 'packages', 'safety', 'package.json'),
      JSON.stringify({ name: '@dollhousemcp/safety', version: '1.0.2' })
    );
    await writeFile(join(repo, 'packages', 'safety', 'src', 'index.ts'), 'export const safe = true;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'publish safety package']);
    publishedGitHead = git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'README.md'), 'trusted main history\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'advance trusted main']);
    trustedMainHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', trustedMainHead]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('allows an exact published version when its trusted source tree is identical', () => {
    const result = checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version: '1.0.2', gitHead: publishedGitHead }),
      log: () => undefined,
    });

    expect(result).toEqual({
      status: 'published-identical',
      version: '1.0.2',
      gitHead: publishedGitHead,
    });
  });

  it('allows a genuinely new version only for a structured E404 response', () => {
    const result = checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({
        error: {
          code: 'E404',
          summary: 'No match found for version 1.0.2',
        },
      }, 1, 'stderr'),
      log: () => undefined,
    });

    expect(result).toEqual({ status: 'new-version', version: '1.0.2' });
  });

  it('fails closed when the safety tree differs from the published commit', async () => {
    await writeFile(join(repo, 'packages', 'safety', 'src', 'index.ts'), 'export const safe = false;\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'change safety source']);

    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version: '1.0.2', gitHead: publishedGitHead }),
      log: () => undefined,
    })).toThrow('Safety package source changed');
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-commit'],
  ])('rejects a %s published gitHead', (_label, gitHead) => {
    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version: '1.0.2', gitHead }),
      log: () => undefined,
    })).toThrow('invalid or missing gitHead');
  });

  it('rejects a published source commit outside trusted origin/main', async () => {
    git(repo, ['switch', '--create', 'fork-source', publishedGitHead]);
    await writeFile(join(repo, 'fork.txt'), 'untrusted fork history\n');
    git(repo, ['add', 'fork.txt']);
    git(repo, ['commit', '-m', 'fork-only source']);
    const forkGitHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['switch', 'main']);

    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version: '1.0.2', gitHead: forkGitHead }),
      log: () => undefined,
    })).toThrow('is not an ancestor of trusted refs/remotes/origin/main');
  });

  it('fails closed on registry network errors', () => {
    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => ({
        status: 1,
        stdout: '',
        stderr: 'npm error code EAI_AGAIN',
      }),
      log: () => undefined,
    })).toThrow('npm registry returned invalid JSON');
  });

  it('fails closed on structured registry errors other than E404', () => {
    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({
        error: {
          code: 'E500',
          summary: 'Registry unavailable',
        },
      }, 1, 'stderr'),
      log: () => undefined,
    })).toThrow('npm registry lookup failed closed');
  });

  it('fails closed on malformed successful registry responses', () => {
    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => ({
        status: 0,
        stdout: 'not-json',
        stderr: '',
      }),
      log: () => undefined,
    })).toThrow('npm registry returned invalid JSON');
  });

  it('rejects a mismatched version returned by the registry', () => {
    expect(() => checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version: '1.0.1', gitHead: publishedGitHead }),
      log: () => undefined,
    })).toThrow('returned version 1.0.1 for requested version 1.0.2');
  });

  it('wires the workflow to full trusted history and this helper', async () => {
    const workflow = await readFile(
      join(process.cwd(), '.github', 'workflows', 'safety-package-check.yml'),
      'utf8'
    );

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('run: node scripts/check-safety-package-version.mjs');
    expect(workflow).toContain("- 'scripts/check-safety-package-version.mjs'");
  });
});
