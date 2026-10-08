#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = '@dollhousemcp/safety';
const PACKAGE_PATH = 'packages/safety';
const TRUSTED_MAIN_REF = 'refs/remotes/origin/main';

// Beta retained these development-tool security pins when trusted main published
// 1.0.4. The qualified beta pack has all 30 non-manifest files byte-identical to
// that published pack, using identical TypeScript and Node type versions. Its
// manifest differs only by ten development overrides; the lock is not packed.
// This record retires automatically on any version, source, blob, or mode change.
// It is not a general exemption for development metadata or build-tool changes.
const REVIEWED_SAFETY_104 = Object.freeze({
  version: '1.0.4',
  gitHead: 'b2b93accf670c8c3dfa884e9f6c379bf93768001',
  files: Object.freeze([
    Object.freeze({
      path: 'packages/safety/package.json',
      published: '27575d44c47cc404ac14dfe5afca3bdbb55d1083',
      beta: '4af547d2bd1cd53e7b3390e5de7b370abd8db516',
    }),
    Object.freeze({
      path: 'packages/safety/package-lock.json',
      published: '1d3f1d55d02095da8ab4851f6923e483f79a6622',
      beta: '210e1c3868d9f1d3274c710b52b85a1b708c02f5',
    }),
  ]),
});

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function outputSummary(result) {
  return [result.stdout, result.stderr]
    .map(value => value?.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);
}

function withDetails(message, details) {
  return details ? `${message}: ${details}` : message;
}

function parseRegistryPayload(result) {
  const candidates = [result.stdout, result.stderr]
    .map(value => value?.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the other stream. npm emits successful JSON on stdout and
      // structured --silent errors on stderr.
    }
  }

  const details = candidates.join('\n').slice(0, 1000);
  throw new Error(withDetails('npm registry returned invalid JSON', details));
}

function assertGitSuccess(result, description) {
  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = outputSummary(result);
    throw new Error(withDetails(`${description} failed`, details));
  }
}

function validateRegistryResult(result, localVersion, log) {
  if (result.error) {
    throw new Error(`npm registry lookup failed: ${result.error.message}`);
  }

  const payload = parseRegistryPayload(result);

  if (result.status !== 0) {
    if (payload?.error?.code === 'E404') {
      log(`Safety package ${localVersion} is not published yet; a new version is ready to publish.`);
      return { status: 'new-version', version: localVersion };
    }

    const details = outputSummary(result);
    throw new Error(withDetails('npm registry lookup failed closed', details));
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('npm registry response must be an object containing version and gitHead');
  }

  if (payload.version !== localVersion) {
    throw new Error(
      `npm registry returned version ${String(payload.version)} for requested version ${localVersion}`
    );
  }

  const publishedGitHead = payload.gitHead;
  if (typeof publishedGitHead !== 'string' || !/^[0-9a-f]{40}$/i.test(publishedGitHead)) {
    throw new Error(`Published ${PACKAGE_NAME}@${localVersion} has an invalid or missing gitHead`);
  }

  return { status: 'published-version', version: localVersion, gitHead: publishedGitHead };
}

function matchesReviewedSafety104(cwd, localVersion, publishedGitHead) {
  if (localVersion !== REVIEWED_SAFETY_104.version
    || publishedGitHead !== REVIEWED_SAFETY_104.gitHead) {
    return false;
  }

  return compareRecordedSafetyTree(cwd, publishedGitHead, REVIEWED_SAFETY_104.files);
}

// Read-only structural comparison for offline Git fixtures. This does not grant
// publication permission: only the production entry point selects the private
// version/head record above, after checking trusted-main ancestry. Synthetic
// tests prove comparison semantics; the full-history workflow proves that actual
// published record against the real safety tree.
export function compareRecordedSafetyTree(cwd, publishedGitHead, files) {
  for (const file of files) {
    for (const [ref, blob] of [[publishedGitHead, file.published], ['HEAD', file.beta]]) {
      const entry = run('git', ['ls-tree', ref, '--', file.path], cwd);
      assertGitSuccess(entry, 'Reading reviewed safety tree entry');
      if (entry.stdout.trim() !== `100644 blob ${blob}\t${file.path}`) {
        return false;
      }
    }
  }

  const remainingTree = run('git', [
    'diff', '--exit-code', publishedGitHead, 'HEAD', '--', PACKAGE_PATH,
    ...files.map(file => `:(exclude)${file.path}`),
  ], cwd);
  if (remainingTree.status === 1 && !remainingTree.error) {
    return false;
  }
  assertGitSuccess(remainingTree, 'Comparing remaining safety package tree');
  return true;
}

export function checkSafetyPackageVersion({
  cwd = process.cwd(),
  runNpm = args => run('npm', args, cwd),
  log = message => console.log(message),
} = {}) {
  const packageJsonPath = resolve(cwd, PACKAGE_PATH, 'package.json');
  let localPackage;

  try {
    localPackage = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${packageJsonPath}: ${error.message}`);
  }

  const localVersion = localPackage.version;
  if (typeof localVersion !== 'string' || localVersion.length === 0) {
    throw new Error(`${packageJsonPath} does not contain a valid version`);
  }

  log(`Local safety version: ${localVersion}`);

  const registryResult = runNpm([
    'view',
    `${PACKAGE_NAME}@${localVersion}`,
    'version',
    'gitHead',
    '--json',
    '--silent',
  ]);

  const registryState = validateRegistryResult(registryResult, localVersion, log);
  if (registryState.status === 'new-version') {
    return registryState;
  }
  const publishedGitHead = registryState.gitHead;

  const trustedMainResult = run(
    'git',
    ['rev-parse', '--verify', `${TRUSTED_MAIN_REF}^{commit}`],
    cwd
  );
  assertGitSuccess(trustedMainResult, `Resolving trusted ${TRUSTED_MAIN_REF}`);

  const ancestryResult = run(
    'git',
    ['merge-base', '--is-ancestor', publishedGitHead, TRUSTED_MAIN_REF],
    cwd
  );
  if (ancestryResult.error) {
    throw new Error(`Checking published gitHead ancestry failed: ${ancestryResult.error.message}`);
  }
  if (ancestryResult.status === 1) {
    throw new Error(
      `Published gitHead ${publishedGitHead} is not an ancestor of trusted ${TRUSTED_MAIN_REF}`
    );
  }
  assertGitSuccess(ancestryResult, 'Checking published gitHead ancestry');

  const treeResult = run(
    'git',
    ['diff', '--exit-code', publishedGitHead, 'HEAD', '--', PACKAGE_PATH],
    cwd
  );
  if (treeResult.error) {
    throw new Error(`Comparing published safety package tree failed: ${treeResult.error.message}`);
  }
  if (treeResult.status === 1) {
    if (matchesReviewedSafety104(cwd, localVersion, publishedGitHead)) {
      log(`Published ${PACKAGE_NAME}@${localVersion} has the exact reviewed beta development-pin divergence; every other safety tree entry is identical.`);
      return {
        status: 'published-reviewed-equivalent',
        version: localVersion,
        gitHead: publishedGitHead,
      };
    }
    throw new Error(
      `Safety package source changed since published ${PACKAGE_NAME}@${localVersion}; bump the package version before merging`
    );
  }
  assertGitSuccess(treeResult, 'Comparing published safety package tree');

  log(
    `Published ${PACKAGE_NAME}@${localVersion} is trusted and packages/safety is unchanged; no version bump is required.`
  );
  return {
    status: 'published-identical',
    version: localVersion,
    gitHead: publishedGitHead,
  };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedAsScript) {
  try {
    checkSafetyPackageVersion();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
