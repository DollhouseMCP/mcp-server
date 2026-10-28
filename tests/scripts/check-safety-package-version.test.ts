import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  status: 'new-version' | 'published-identical' | 'published-reviewed-equivalent';
  version: string;
  gitHead?: string;
}

interface RecordedFile {
  path: string;
  published: string;
  beta: string;
}

interface SafetyVersionModule {
  compareRecordedSafetyTree(cwd: string, publishedGitHead: string, files: RecordedFile[]): boolean;
  checkSafetyPackageVersion(options: {
    cwd: string;
    runNpm: (args: string[]) => CommandResult;
    log: () => void;
  }): CheckResult;
}

const helperUrl = pathToFileURL(
  join(process.cwd(), 'scripts', 'check-safety-package-version.mjs')
).href;
const { checkSafetyPackageVersion, compareRecordedSafetyTree } = await import(helperUrl) as SafetyVersionModule;

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    input,
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
  let template: string;
  let templatePublishedGitHead: string;
  let repoRoot: string;
  let repo: string;
  let publishedGitHead: string;
  let recordedFiles: RecordedFile[];

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'safety-version-template-'));
    git(template, ['init', '--initial-branch=main', '--object-format=sha1']);
    // Preserve deterministic authorship and disable detached maintenance for later mutations.
    await appendFile(join(template, '.git', 'config'),
      '\n[user]\n\tname = Safety Check Test\n\temail = safety-check@example.test\n' +
      '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
    const data = (value: string): string => `data ${Buffer.byteLength(value, 'utf8')}\n${value}\n`;
    // Build our two real commits in one Git process, without hooks or project history.
    git(template, ['fast-import', '--quiet', '--export-marks=.git/fixture-marks'], [
      'commit refs/heads/main\nmark :1\n',
      'committer Safety Check Test <safety-check@example.test> 1700000000 +0000\n',
      data('publish safety package'),
      'M 100644 inline packages/safety/package.json\n',
      data(JSON.stringify({ name: '@dollhousemcp/safety', version: '1.0.2' })),
      'M 100644 inline packages/safety/src/index.ts\n',
      data('export const safe = true;\n'),
      '\ncommit refs/heads/main\nmark :2\n',
      'committer Safety Check Test <safety-check@example.test> 1700000001 +0000\n',
      data('advance trusted main'),
      'from :1\nM 100644 inline README.md\n',
      data('trusted main history\n'),
      '\nreset refs/remotes/origin/main\nfrom :2\n\ndone\n',
    ].join(''));
    const marks = new Map((await readFile(join(template, '.git', 'fixture-marks'), 'utf8'))
      .trim().split(/\r?\n/).map(line => {
        const match = /^(:[12]) ([0-9a-f]{40})$/.exec(line);
        if (!match) throw new Error('Fixture import returned an invalid commit mark');
        return [match[1], match[2]] as const;
      }));
    const published = marks.get(':1');
    const trusted = marks.get(':2');
    if (marks.size !== 2 || !published || !trusted) {
      throw new Error('Fixture import did not create both owned commits');
    }
    templatePublishedGitHead = published;
    git(template, ['reset', '--hard', 'HEAD']);
  });

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'safety-version-check-'));
    repo = join(repoRoot, 'repo');
    // Copy complete object files, never hardlinks or alternates shared with another case.
    await cp(template, repo, { recursive: true, errorOnExist: true, force: false });
    publishedGitHead = templatePublishedGitHead;
    recordedFiles = [];
  });

  afterEach(async () => {
    // Bounded retries tolerate transient ENOTEMPTY; exhaustion still rejects cleanup.
    if (repoRoot) await rm(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  afterAll(async () => {
    if (template) await rm(template, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('owns independent Git objects in every fixture copy', async () => {
    let object = join(templatePublishedGitHead.slice(0, 2), templatePublishedGitHead.slice(2));
    try {
      await readFile(join(repo, '.git', 'objects', object));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const pack = (await readdir(join(repo, '.git', 'objects', 'pack')))
        .find(file => file.endsWith('.pack'));
      if (!pack) throw new Error('Owned fixture import did not produce its commit object');
      object = join('pack', pack);
    }
    const copyPath = join(repo, '.git', 'objects', object);
    const templatePath = join(template, '.git', 'objects', object);
    const original = await readFile(templatePath);
    expect(await readFile(copyPath)).toEqual(original);
    await expect(readFile(join(repo, '.git', 'objects', 'info', 'alternates')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const changed = Buffer.from(original);
    changed[0] ^= 0xff;
    await chmod(copyPath, 0o600);
    await writeFile(copyPath, changed);
    expect(await readFile(templatePath)).toEqual(original);
    expect(git(template, ['cat-file', '-t', templatePublishedGitHead])).toBe('commit');
  });

  async function prepareRecordedTree(): Promise<void> {
    // Own every Git object: no network, alternates, or checkout-history dependency.
    // These controls prove structural comparison, not the actual pinned record.
    const safety = join(repo, 'packages', 'safety');
    await writeFile(join(safety, 'package.json'), JSON.stringify({
      name: '@dollhousemcp/safety', version: '1.0.4',
      dependencies: { runtime: '1.0.0' }, exports: { '.': './dist/index.js' },
      files: ['dist'], scripts: { build: 'tsc' },
    }));
    await writeFile(join(safety, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/typescript': { version: '5.9.3' } },
    }));
    await writeFile(join(safety, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    await writeFile(join(safety, 'README.md'), 'owned safety documentation\n');
    git(repo, ['add', 'packages/safety']);
    git(repo, ['commit', '-m', 'own synthetic published tree']);
    publishedGitHead = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', publishedGitHead]);
    const manifestPath = join(safety, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.overrides = { tool: '2.0.0' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const lockPath = join(safety, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.packages['node_modules/tool'] = { version: '2.0.0' };
    await writeFile(lockPath, JSON.stringify(lock));
    const paths = ['packages/safety/package.json', 'packages/safety/package-lock.json'];
    // Both files are already tracked. Commit only these working-tree paths,
    // leaving any unrelated index entries and untracked files out of the fixture.
    git(repo, ['commit', '--only', '-m', 'own synthetic development metadata', '--', ...paths]);
    const blobs = git(repo, ['rev-parse', ...paths.flatMap(path => [
      `${publishedGitHead}:${path}`, `HEAD:${path}`,
    ])]).split(/\r?\n/);
    if (blobs.length !== paths.length * 2 || blobs.some(blob => !/^[0-9a-f]{40}$/.test(blob))) {
      throw new Error('Fixture Git blob lookup did not return four exact object IDs');
    }
    recordedFiles = paths.map((path, index) => {
      return {
        path,
        published: blobs[index * 2],
        beta: blobs[index * 2 + 1],
      };
    });
  }

  function compareRecordedTree(): boolean {
    return compareRecordedSafetyTree(repo, publishedGitHead, recordedFiles);
  }

  function checkSyntheticPublishedVersion(version: string): CheckResult {
    return checkSafetyPackageVersion({
      cwd: repo,
      runNpm: () => registryResult({ version, gitHead: publishedGitHead }),
      log: () => undefined,
    });
  }

  it('compares exact recorded blobs and every remaining tree entry offline', async () => {
    await prepareRecordedTree();
    expect(compareRecordedTree()).toBe(true);
  });

  it.each([
    ['runtime dependency', 'dependencies', { injected: '1.0.0' }],
    ['export', 'exports', { '.': './changed.js' }],
    ['packed files', 'files', ['src']],
    ['build script', 'scripts', { build: 'different-compiler' }],
    ['extra development override', 'overrides', { typescript: '5.0.0' }],
  ])('rejects a %s change to the reviewed manifest', async (_label, field, value) => {
    await prepareRecordedTree();
    const path = join(repo, 'packages', 'safety', 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest[field as string] = value;
    await writeFile(path, JSON.stringify(manifest));
    git(repo, ['commit', '--only', '-m', 'mutate reviewed manifest', '--', 'packages/safety/package.json']);
    expect(compareRecordedTree()).toBe(false);
  });

  it.each(['src/index.ts', 'tsconfig.json', 'README.md'])('rejects any other safety path change: %s', async file => {
    await prepareRecordedTree();
    const path = join(repo, 'packages', 'safety', file);
    await writeFile(path, `${await readFile(path, 'utf8')}\nchanged\n`);
    git(repo, ['add', 'packages/safety']);
    git(repo, ['commit', '-m', 'mutate safety source or build input']);
    expect(compareRecordedTree()).toBe(false);
  });

  it('rejects a changed compiler entry in the standalone lock', async () => {
    await prepareRecordedTree();
    const path = join(repo, 'packages', 'safety', 'package-lock.json');
    const lock = JSON.parse(await readFile(path, 'utf8'));
    lock.packages['node_modules/typescript'].version = '5.0.0';
    await writeFile(path, JSON.stringify(lock));
    git(repo, ['add', 'packages/safety']);
    git(repo, ['commit', '-m', 'change locked compiler']);
    expect(compareRecordedTree()).toBe(false);
  });

  it('rejects a reviewed blob with a changed tree mode', async () => {
    await prepareRecordedTree();
    git(repo, ['update-index', '--chmod=+x', 'packages/safety/package.json']);
    git(repo, ['commit', '-m', 'change reviewed entry mode']);
    expect(compareRecordedTree()).toBe(false);
  });

  it('rejects a deleted reviewed file', async () => {
    await prepareRecordedTree();
    git(repo, ['rm', 'packages/safety/package-lock.json']);
    git(repo, ['commit', '-m', 'remove reviewed lock']);
    expect(compareRecordedTree()).toBe(false);
  });

  it('does not authorize a synthetic record through the production guard', async () => {
    await prepareRecordedTree();
    expect(compareRecordedTree()).toBe(true);
    expect(() => checkSyntheticPublishedVersion('1.0.4')).toThrow('Safety package source changed');
  });

  it('does not authorize another version through the production guard', async () => {
    await prepareRecordedTree();
    const path = join(repo, 'packages', 'safety', 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.version = '1.0.5';
    await writeFile(path, JSON.stringify(manifest));
    git(repo, ['add', 'packages/safety']);
    git(repo, ['commit', '-m', 'change package version']);
    expect(() => checkSyntheticPublishedVersion('1.0.5')).toThrow('Safety package source changed');
  });

  it('fails closed when the recorded commit is unavailable', async () => {
    await prepareRecordedTree();
    expect(() => compareRecordedSafetyTree(repo, 'f'.repeat(40), recordedFiles))
      .toThrow('Reading reviewed safety tree entry failed');
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
