import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

interface BetaWorkflow {
  readonly jobs: {
    readonly 'publish-beta': {
      readonly steps: readonly WorkflowStep[];
    };
  };
}

interface Scenario {
  readonly sourceRef?: string;
  readonly releaseStatus?: string;
  readonly releaseBody?: string;
  readonly gitFailure?: string;
  readonly npmTagFailure?: string;
  readonly version?: string;
  readonly npmError?: string;
  readonly npmResponse?: string;
  readonly tagTarget?: string;
  readonly branchTarget?: string;
  readonly release?: {
    readonly tagName?: string;
    readonly isPrerelease?: boolean;
    readonly isDraft?: boolean;
    readonly targetCommitish?: string;
  };
  readonly npmExists?: boolean;
  readonly npmBetaVersion?: string;
  readonly npmLatestVersion?: string;
}

const projectRoot = process.cwd();
const workflowPath = path.join(projectRoot, '.github/workflows/publish-beta-release.yml');
const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as BetaWorkflow;
const validationScript = workflow.jobs['publish-beta'].steps
  .find(step => step.name === 'Validate beta release inputs')?.run;
// main stays stable; the manual workflow validates its selected beta checkout.
const packageVersion = '2.1.0-beta.2';
const expectedSha = '0123456789abcdef0123456789abcdef01234567';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Publish Beta Release state validation', () => {
  it.each(['refs/heads/main', 'refs/heads/develop', 'refs/tags/beta', 'refs/tags/v2.1.0-beta.2'])('rejects workflow source %s before external commands', sourceRef => {
    const result = runScenario({ sourceRef });
    expect(result.status).toBe(1);
    expect(result.commands).toEqual([]);
  });

  it.each(['01.2.3-beta', '2.01.3-beta', '2.1.03-beta', '2.1.0-beta.01', '2.1.0-beta..1', '2.1.0-beta.', '2.1.0-beta.+foo', `2.1.0-beta.${'a'.repeat(256)}`])('rejects malformed beta version %s before external commands', version => {
    const result = runScenario({ version });
    expect(result.status).toBe(1);
    expect(result.commands).toEqual([]);
  });

  it.each(['0.0.0-beta', '2.1.0-beta.0', '2.1.0-beta.1.alpha-2', '2.1.0-beta.999999999999999999999999999999'])('accepts valid beta version %s', version => {
    const result = runScenario({ version });
    expectSuccessfulScenario(result);
    expect(result.outputs.version).toBe(version);
  });

  it.each(['E429', 'E401', 'E500', 'ETIMEDOUT', ''])('does not treat npm lookup failure %s as absence', npmError => {
    const result = runScenario({ npmError });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.stdout).toContain('npm exact-version lookup failed');
    expect(result.commands.some(command => /push|create|publish/.test(command))).toBe(false);
  });

  it.each(['null', '{}', '"2.1.0-beta.999"', 'not-json'])('rejects unexpected successful npm response %s', npmResponse => {
    const result = runScenario({ npmExists: true, npmResponse });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
  });

  it.each(['401', '403', '429', '500', '503', ''])('rejects GitHub lookup error %s before npm/state outputs', releaseStatus => {
    const result = runScenario({ releaseStatus });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.stdout).toContain('GitHub release lookup failed');
    expect(result.commands.some(command => command.startsWith('npm'))).toBe(false);
  });

  it.each(['not-json', '{}', 'null'])('rejects malformed GitHub success metadata %s', releaseBody => {
    const result = runScenario({ releaseStatus: '200', releaseBody });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
    expect(result.stdout).toContain('invalid release metadata');
  });

  it.each(['tag', 'target'])('stops on failed git %s lookup even with partial stdout', gitFailure => {
    const result = runScenario({ tagTarget: expectedSha, gitFailure });
    expect(result.status).not.toBe(0);
    expect(result.outputs).toEqual({});
    expect(result.commands.every(command => command.startsWith('git'))).toBe(true);
  });

  it.each(['beta', 'latest'])('rejects npm %s dist-tag lookup failure', npmTagFailure => {
    const result = runScenario({ tagTarget: expectedSha, release: matchingRelease(), npmExists: true,
      npmBetaVersion: packageVersion, npmLatestVersion: '2.0.42', npmTagFailure });
    expect(result.status).toBe(1);
    expect(result.outputs).toEqual({});
  });

  it('accepts explicit npm E404 JSON despite human stderr diagnostics for a fresh version', () => {
    const result = runScenario({});

    expectSuccessfulScenario(result);
    expect(result.outputs).toMatchObject({
      tag_exists: 'false',
      release_exists: 'false',
      npm_publish_complete: 'false',
    });
  });

  it('accepts a matching existing prerelease so missing publishers can retry', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
    });

    expectSuccessfulScenario(result);
    expect(result.outputs).toMatchObject({
      tag_exists: 'true',
      release_exists: 'true',
      npm_publish_complete: 'false',
    });
  });

  it('accepts a matching tag when release creation has not completed yet', () => {
    const result = runScenario({ tagTarget: expectedSha });

    expectSuccessfulScenario(result);
    expect(result.outputs).toMatchObject({
      tag_exists: 'true',
      release_exists: 'false',
      npm_publish_complete: 'false',
    });
  });

  it('rejects a tag that resolves to another commit without mutating release state', () => {
    const result = runScenario({
      tagTarget: 'f'.repeat(40),
      release: matchingRelease({ targetCommitish: 'beta' }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`Tag v${packageVersion} already exists at ${'f'.repeat(40)}`);
    expect(result.commands).toHaveLength(2);
    expect(result.commands.every(command => command.startsWith('git ls-remote --tags '))).toBe(true);
  });

  it('rejects release metadata that names a different tag', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ tagName: 'v2.1.0-beta.wrong' }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Release lookup returned tag v2.1.0-beta.wrong');
  });

  it('accepts a symbolic release target when the immutable tag matches', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      branchTarget: expectedSha,
      release: matchingRelease({ targetCommitish: 'beta' }),
    });

    expectSuccessfulScenario(result);
    expect(result.stdout).toContain('records a different targetCommitish');
    expect(result.outputs.release_exists).toBe('true');
  });

  it('accepts a symbolic release target after the branch advances', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      branchTarget: 'f'.repeat(40),
      release: matchingRelease({ targetCommitish: 'beta' }),
    });

    expectSuccessfulScenario(result);
    expect(result.stdout).toContain(
      `verified tag v${packageVersion} resolves to ${expectedSha}`,
    );
    expect(result.outputs.release_exists).toBe('true');
  });

  it('treats non-authoritative release target metadata as audit-only', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ targetCommitish: 'f'.repeat(40) }),
    });

    expectSuccessfulScenario(result);
    expect(result.stdout).toContain('records a different targetCommitish');
    expect(result.stdout).not.toContain('f'.repeat(40));
  });

  it('rejects a draft or non-prerelease release', () => {
    const draft = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ isDraft: true }),
    });
    const stable = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ isPrerelease: false }),
    });

    expect(draft.status).toBe(1);
    expect(stable.status).toBe(1);
    expect(draft.stdout).toContain('must be a published prerelease');
    expect(stable.stdout).toContain('must be a published prerelease');
  });

  it('marks npm complete only when beta points to the matching published version', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: packageVersion,
      npmLatestVersion: '2.0.40',
    });

    expectSuccessfulScenario(result);
    expect(result.outputs.npm_publish_complete).toBe('true');
  });

  it('preserves a different valid beta dist-tag while repairing older artifacts', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: '2.1.0-beta.3',
      npmLatestVersion: '2.0.40',
    });

    expectSuccessfulScenario(result);
    expect(result.outputs.npm_publish_complete).toBe('true');
    expect(result.stdout).toContain('leaving that channel unchanged');
  });

  it('compares numeric prerelease identifiers without fixed-width overflow', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: '2.1.0-beta.9223372036854775808',
      npmLatestVersion: '2.0.40',
    });

    expectSuccessfulScenario(result);
    expect(result.outputs.npm_publish_complete).toBe('true');
    expect(result.stdout).toContain('leaving that channel unchanged');
  });

  it('rejects an older beta dist-tag rather than treating npm as complete', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: '2.0.99-beta.9',
      npmLatestVersion: '2.0.40',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('points to older beta 2.0.99-beta.9');
  });

  it('rejects skipping npm when latest points to a prerelease', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: packageVersion,
      npmLatestVersion: packageVersion,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('dist-tags.latest must point to a stable SemVer');
  });

  it('rejects an existing npm version when the beta dist-tag is invalid', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: '2.0.40',
      npmLatestVersion: '2.0.40',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('dist-tags.beta is invalid or unset (2.0.40)');
  });

  it('rejects an npm publication that has no matching reusable release', () => {
    const result = runScenario({
      npmExists: true,
      npmBetaVersion: packageVersion,
      npmLatestVersion: '2.0.40',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('exists without a matching reusable GitHub prerelease');
  });
});

function matchingRelease(overrides: Scenario['release'] = {}): NonNullable<Scenario['release']> {
  return {
    tagName: `v${packageVersion}`,
    isPrerelease: true,
    isDraft: false,
    targetCommitish: expectedSha,
    ...overrides,
  };
}

function runScenario(scenario: Scenario): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Readonly<Record<string, string>>;
  readonly commands: readonly string[];
} {
  expect(validationScript).toBeDefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-release-state-'));
  tempDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  const outputPath = path.join(directory, 'github-output');
  const commandLogPath = path.join(directory, 'commands.log');
  fs.mkdirSync(binDirectory);
  for (const file of ['package.json', 'manifest.json']) {
    fs.writeFileSync(path.join(directory, file), JSON.stringify({ version: scenario.version ?? packageVersion }));
  }
  writeExecutable(path.join(binDirectory, 'git'), fakeGitScript);
  writeExecutable(path.join(binDirectory, 'gh'), fakeGhScript);
  writeExecutable(path.join(binDirectory, 'npm'), fakeNpmScript);

  const release = scenario.release;
  const bashExecutable = process.platform === 'win32' ? 'bash' : '/bin/bash';
  const shellPath = (value: string): string => process.platform === 'win32'
    ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
    : value;
  // GHA executes a script file. Long -c arguments can be truncated on Windows.
  const scriptPath = path.join(directory, 'validate-release.sh');
  writeExecutable(scriptPath, `export PATH="$FAKE_BIN_DIRECTORY:$PATH"\n${validationScript ?? 'exit 99'}`);
  const result = spawnSync(bashExecutable, ['-e', '-o', 'pipefail', shellPath(scriptPath)], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_BIN_DIRECTORY: shellPath(binDirectory),
      GITHUB_REF: scenario.sourceRef ?? 'refs/heads/beta',
      GITHUB_REPOSITORY: 'DollhouseMCP/mcp-server',
      FAKE_RELEASE_STATUS: scenario.releaseStatus ?? (release ? '200' : '404'),
      FAKE_GIT_FAILURE: scenario.gitFailure ?? '',
      FAKE_NPM_TAG_FAILURE: scenario.npmTagFailure ?? '',
      GITHUB_SHA: expectedSha,
      GITHUB_OUTPUT: outputPath,
      INPUT_VERSION: scenario.version ?? packageVersion,
      FAKE_NPM_ERROR: scenario.npmError ?? 'E404',
      FAKE_NPM_RESPONSE: scenario.npmResponse ?? JSON.stringify(scenario.version ?? packageVersion),
      FAKE_TAG_OBJECT: scenario.tagTarget ? 'a'.repeat(40) : '',
      FAKE_TAG_TARGET: scenario.tagTarget ?? '',
      FAKE_BRANCH_TARGET: scenario.branchTarget ?? '',
      FAKE_COMMAND_LOG: commandLogPath,
      FAKE_RELEASE_JSON: scenario.releaseBody ?? (release ? JSON.stringify({ tag_name: release.tagName,
        prerelease: release.isPrerelease, draft: release.isDraft, target_commitish: release.targetCommitish }) : '{}'),
      FAKE_NPM_EXISTS: scenario.npmExists ? 'true' : 'false',
      FAKE_NPM_BETA_VERSION: scenario.npmBetaVersion ?? '',
      FAKE_NPM_LATEST_VERSION: scenario.npmLatestVersion ?? '',
    },
  });
  if (result.error) throw result.error;

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readOutputs(outputPath),
    commands: readLines(commandLogPath),
  };
}

// These are closed fake clients: captured output contains fixture data, never credentials.
function expectSuccessfulScenario(result: ReturnType<typeof runScenario>): void {
  if (result.status !== 0) {
    throw new Error(`Expected successful workflow validation, received exit ${result.status}.\n${JSON.stringify({
      stdout: result.stdout, stderr: result.stderr, commands: result.commands,
    }, null, 2)}`);
  }
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o700 });
}

function readOutputs(filePath: string): Readonly<Record<string, string>> {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs.readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function readLines(filePath: string): readonly string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
}

const fakeGitScript = `#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "\${FAKE_COMMAND_LOG}"
case "$*" in
  *'refs/tags/'*'^{}'*)
    [[ "\${FAKE_GIT_FAILURE}" != target ]] || { printf 'partial stdout\\n'; exit 1; }
    [[ -z "\${FAKE_TAG_TARGET:-}" ]] || printf '%s refs/tags/tag^{}\n' "\${FAKE_TAG_TARGET}"
    ;;
  *'refs/tags/'*)
    [[ "\${FAKE_GIT_FAILURE}" != tag ]] || { printf 'partial stdout\\n'; exit 1; }
    [[ -z "\${FAKE_TAG_OBJECT:-}" ]] || printf '%s refs/tags/tag\n' "\${FAKE_TAG_OBJECT}"
    ;;
  *'refs/heads/'*)
    [[ -z "\${FAKE_BRANCH_TARGET:-}" ]] || printf '%s refs/heads/branch\n' "\${FAKE_BRANCH_TARGET}"
    ;;
  *)
    exit 2
    ;;
esac
`;

const fakeGhScript = `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "\${FAKE_COMMAND_LOG}"
[[ "$1" == api && "$2" == --include && "$3" == repos/DollhouseMCP/mcp-server/releases/tags/* ]] || exit 99
if [[ -n "\${FAKE_RELEASE_STATUS}" ]]; then
  printf 'HTTP/2.0 %s fixture\\r\\nContent-Type: application/json\\r\\n\\r\\n%s\\n' "\${FAKE_RELEASE_STATUS}" "\${FAKE_RELEASE_JSON}"
fi
[[ "\${FAKE_RELEASE_STATUS}" == 200 ]] && exit 0
printf 'gh: fixture lookup failure\\n' >&2
exit 1
`;

const fakeNpmScript = `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >> "\${FAKE_COMMAND_LOG}"
if [[ "$*" == *'dist-tags.beta'* ]]; then
  [[ "\${FAKE_NPM_TAG_FAILURE}" != beta ]] || exit 1
  [[ -z "\${FAKE_NPM_BETA_VERSION:-}" ]] || printf '%s\n' "\${FAKE_NPM_BETA_VERSION}"
  exit 0
fi
if [[ "$*" == *'dist-tags.latest'* ]]; then
  [[ "\${FAKE_NPM_TAG_FAILURE}" != latest ]] || exit 1
  [[ -z "\${FAKE_NPM_LATEST_VERSION:-}" ]] || printf '%s\n' "\${FAKE_NPM_LATEST_VERSION}"
  exit 0
fi
if [[ "\${FAKE_NPM_EXISTS:-false}" == 'true' ]]; then
  printf '%s\n' "\${FAKE_NPM_RESPONSE}"
  exit 0
fi
printf 'npm error code %s\\n' "\${FAKE_NPM_ERROR}" >&2
printf '{"error":{"code":"%s"}}\\n' "\${FAKE_NPM_ERROR}"
exit 1
`;
