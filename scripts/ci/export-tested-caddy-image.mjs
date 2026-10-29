import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^(?:sha256:)?[a-f0-9]{64}$/;
const root = fileURLToPath(new URL('../../', import.meta.url));

export function bindSource(rawCommit, checkoutSha, checkoutTree, sourceHead, eventName) {
  for (const value of [checkoutSha, checkoutTree, sourceHead]) assert.match(value, shaPattern);
  const headers = rawCommit.split('\n\n', 1)[0].split('\n');
  const parents = headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7));
  for (const parent of parents) assert.match(parent, shaPattern);
  assert.deepEqual(headers.filter(line => line.startsWith('tree ')), [`tree ${checkoutTree}`]);
  if (eventName === 'pull_request') assert.ok(sourceHead === checkoutSha || parents.includes(sourceHead), 'PR head is not the tested checkout or its direct parent');
  else {
    assert.ok(['push', 'workflow_dispatch'].includes(eventName));
    assert.equal(sourceHead, checkoutSha);
  }
  return { testedCheckoutSha:checkoutSha, testedCheckoutTree:checkoutTree, testedCheckoutParents:parents, sourceHeadSha:sourceHead };
}

export function verifyRuntimeConfig(config, expected) {
  for (const [key, value] of Object.entries(expected)) {
    let actual = config[key] ?? null;
    if (key === 'User' && actual === '') actual = null;
    assert.deepEqual(actual, value, `unexpected runtime config: ${key}`);
  }
}

function command(program, args) {
  return execFileSync(program, args, { encoding:'utf8', timeout:180_000, maxBuffer:4_000_000 }).trim();
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function main() {
  process.umask(0o077);
  const [imageId, localTag, output] = process.argv.slice(2);
  assert.match(imageId ?? '', imagePattern);
  assert.match(localTag ?? '', /^localhost\/dollhouse-caddy:qualification-(?:amd64|arm64)$/);
  assert.ok(output && !fs.existsSync(output), 'artifact directory must be new');
  const platform = process.env.EVIDENCE_PLATFORM;
  assert.ok(['linux/amd64', 'linux/arm64'].includes(platform));
  const checkoutSha = command('git', ['rev-parse', 'HEAD']);
  assert.equal(checkoutSha, process.env.GITHUB_SHA);
  const binding = bindSource(command('git', ['cat-file', 'commit', 'HEAD']), checkoutSha,
    command('git', ['rev-parse', 'HEAD^{tree}']), process.env.EVIDENCE_HEAD_SHA, process.env.GITHUB_EVENT_NAME);
  const inspect = name => JSON.parse(command('docker', ['image', 'inspect', name]))[0];
  const image = inspect(imageId);
  assert.equal(inspect(localTag).Id, image.Id, 'tested tag changed after qualification');
  assert.equal(image.Id.replace(/^sha256:/, ''), imageId.replace(/^sha256:/, ''));
  assert.equal(image.Os, 'linux');
  assert.equal(`linux/${image.Architecture}`, platform);
  const info = JSON.parse(command('docker', ['info', '--format', '{{json .}}']));
  const reported = info.Architecture ?? info.host?.arch ?? info.Host?.Arch;
  const native = { aarch64:'arm64', arm64:'arm64', x86_64:'amd64', amd64:'amd64' }[reported];
  assert.equal(native, image.Architecture, 'artifact must have passed on a matching native daemon');
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'docker/caddy/approved-runtime-config.json'), 'utf8'));
  verifyRuntimeConfig(image.Config, expected);
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], checkoutSha);
  assert.equal(image.Config.Labels['org.dollhousemcp.caddy.distribution'], 'source-rebuilt-security-candidate');
  fs.mkdirSync(output, { mode:0o700 });
  const archiveName = `caddy-production-${image.Architecture}.docker.tar`;
  const archive = path.join(output, archiveName);
  // Save the pristine final IMAGE, never a runtime container or builder.
  command('docker', ['image', 'save', '--output', archive, imageId]);
  fs.chmodSync(archive, 0o600);
  const archiveSha256 = await hashFile(archive);
  const metadata = { schemaVersion:1, ...binding, testedImageId:image.Id,
    nativeDaemonArchitecture:native, platform, imageConfig:image.Config, rootFs:image.RootFS,
    archiveName, archiveSha256, archiveBytes:fs.statSync(archive).size,
    workflowRunId:process.env.GITHUB_RUN_ID, workflowRunAttempt:process.env.GITHUB_RUN_ATTEMPT,
    capturedAt:new Date().toISOString(), productionContainerStateIncluded:false };
  const metadataFile = path.join(output, 'metadata.json');
  fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + '\n', { mode:0o600 });
  const metadataSha = await hashFile(metadataFile);
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${archiveSha256}  ${archiveName}\n${metadataSha}  metadata.json\n`, { mode:0o600 });
  console.log(JSON.stringify({ archiveSha256, archiveBytes:metadata.archiveBytes, platform, ...binding }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
