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
  readonly tagTarget?: string;
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
const packageVersion = (JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
) as { readonly version: string }).version;
const expectedSha = '0123456789abcdef0123456789abcdef01234567';
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Publish Beta Release state validation', () => {
  it('accepts a fresh beta version with no tag, release, or npm publication', () => {
    const result = runScenario({});

    expect(result.status).toBe(0);
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

    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({
      tag_exists: 'true',
      release_exists: 'true',
      npm_publish_complete: 'false',
    });
  });

  it('accepts a matching tag when release creation has not completed yet', () => {
    const result = runScenario({ tagTarget: expectedSha });

    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({
      tag_exists: 'true',
      release_exists: 'false',
      npm_publish_complete: 'false',
    });
  });

  it('rejects release metadata that names a different tag', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ tagName: 'v2.1.0-beta.wrong' }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Release lookup returned tag v2.1.0-beta.wrong');
  });

  it('rejects an existing release that targets another commit', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease({ targetCommitish: 'f'.repeat(40) }),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`not ${expectedSha}`);
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

    expect(result.status).toBe(0);
    expect(result.outputs.npm_publish_complete).toBe('true');
  });

  it('preserves a different valid beta dist-tag while repairing older artifacts', () => {
    const result = runScenario({
      tagTarget: expectedSha,
      release: matchingRelease(),
      npmExists: true,
      npmBetaVersion: '2.1.0-beta.2',
      npmLatestVersion: '2.0.40',
    });

    expect(result.status).toBe(0);
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
} {
  expect(validationScript).toBeDefined();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'beta-release-state-'));
  tempDirectories.push(directory);
  const binDirectory = path.join(directory, 'bin');
  const outputPath = path.join(directory, 'github-output');
  fs.mkdirSync(binDirectory);
  writeExecutable(path.join(binDirectory, 'git'), fakeGitScript);
  writeExecutable(path.join(binDirectory, 'gh'), fakeGhScript);
  writeExecutable(path.join(binDirectory, 'npm'), fakeNpmScript);

  const release = scenario.release;
  const result = spawnSync('/bin/bash', ['-c', validationScript ?? 'exit 99'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      GITHUB_REF_NAME: 'beta',
      GITHUB_SHA: expectedSha,
      GITHUB_OUTPUT: outputPath,
      INPUT_VERSION: packageVersion,
      FAKE_TAG_OBJECT: scenario.tagTarget ? 'a'.repeat(40) : '',
      FAKE_TAG_TARGET: scenario.tagTarget ?? '',
      FAKE_RELEASE_EXISTS: release ? 'true' : 'false',
      FAKE_RELEASE_JSON: release ? JSON.stringify(release) : '',
      FAKE_NPM_EXISTS: scenario.npmExists ? 'true' : 'false',
      FAKE_NPM_BETA_VERSION: scenario.npmBetaVersion ?? '',
      FAKE_NPM_LATEST_VERSION: scenario.npmLatestVersion ?? '',
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outputs: readOutputs(outputPath),
  };
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

const fakeGitScript = `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'refs/tags/'*'^{}'*)
    [[ -z "\${FAKE_TAG_TARGET:-}" ]] || printf '%s refs/tags/tag^{}\n' "\${FAKE_TAG_TARGET}"
    ;;
  *'refs/tags/'*)
    [[ -z "\${FAKE_TAG_OBJECT:-}" ]] || printf '%s refs/tags/tag\n' "\${FAKE_TAG_OBJECT}"
    ;;
  *)
    exit 2
    ;;
esac
`;

const fakeGhScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == 'release' && "$2" == 'view' && "\${FAKE_RELEASE_EXISTS:-false}" == 'true' ]]; then
  printf '%s\n' "\${FAKE_RELEASE_JSON}"
  exit 0
fi
exit 1
`;

const fakeNpmScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'dist-tags.beta'* ]]; then
  [[ -z "\${FAKE_NPM_BETA_VERSION:-}" ]] || printf '%s\n' "\${FAKE_NPM_BETA_VERSION}"
  exit 0
fi
if [[ "$*" == *'dist-tags.latest'* ]]; then
  [[ -z "\${FAKE_NPM_LATEST_VERSION:-}" ]] || printf '%s\n' "\${FAKE_NPM_LATEST_VERSION}"
  exit 0
fi
if [[ "\${FAKE_NPM_EXISTS:-false}" == 'true' ]]; then
  printf '%s\n' "\${INPUT_VERSION}"
  exit 0
fi
exit 1
`;
