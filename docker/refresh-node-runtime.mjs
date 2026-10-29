// Build-only hybrid refresh. The running helper is the existing reviewed Node.
// Do not execute the candidate binary while authenticating/staging its data.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, lstat, realpath, mkdtemp, rename, rm, chmod, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from '../scripts/ci/prepare-global-npm.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const under = (path, parent) => path === parent || path.startsWith(parent + '/');
const compare = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export function artifactFor(recipe, arch) {
  if (recipe.version !== '24.22.1' || recipe.fromVersion !== '24.21.0' || recipe.npmCore !== '11.19.0' ||
      recipe.nodeModuleVersion !== '137' || !['amd64', 'arm64'].includes(arch)) throw new Error('Unsupported exact Node refresh scope');
  const artifact = recipe.artifacts[arch];
  const nodeArch = arch === 'amd64' ? 'x64' : 'arm64';
  if (!artifact || artifact.nodeArch !== nodeArch || artifact.filename !== `node-v24.22.1-linux-${nodeArch}.tar.gz` ||
      artifact.url !== 'https://nodejs.org/dist/v24.22.1/' + artifact.filename ||
      artifact.opensslArch !== (arch === 'amd64' ? 'linux-x86_64' : 'linux-aarch64') ||
      ![artifact.sha256, artifact.nodeSha256, artifact.headerTreeSha256].every(value => /^[a-f0-9]{64}$/u.test(value)) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || artifact.bytes > 80 * 1024 ** 2 ||
      !Number.isSafeInteger(artifact.nodeBytes) || artifact.nodeBytes <= 0 || artifact.nodeBytes > 128 * 1024 ** 2 ||
      !Number.isSafeInteger(artifact.headerFiles) || artifact.headerFiles <= 0 || artifact.headerFiles > 4096) throw new Error('Unexpected exact Node artifact');
  return artifact;
}

async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export function extractSelected(archive, stage, artifact) {
  const prefix = artifact.filename.slice(0, -7);
  // Full archive bytes are authenticated first. Retained inert review proves
  // the selected immutable members are only regular files/directories.
  // Do not inherit TAR_OPTIONS, GZIP, loaders or an arbitrary executable PATH.
  const command = ['--extract', '--gzip', '--file=' + archive, '--directory=' + stage,
    '--strip-components=1', '--no-same-owner', '--no-same-permissions', '--keep-old-files',
    '--delay-directory-restore', '--', prefix + '/bin/node', prefix + '/include/node'];
  const result = spawnSync('/usr/bin/tar', command, { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', HOME: stage },
    timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('Bounded existing tar data extraction failed');
}

// Call only after the complete staged binary/header checks below. Inherited
// lower/merged directories can refuse rename with EXDEV on overlayfs. Remove
// the old tree, then rename only the newly created staged tree. Errors still
// reject the disposable Docker layer; this is not a transactional host installer.
// The injectable operations are for synthetic inert filesystem fixtures only.
export async function installValidatedHeaders(target, staged, io = { rm, rename }) {
  await io.rm(target, { recursive: true });
  await io.rename(staged, target);
}

export async function refreshNode(root, archiveRoot, recipe, arch, extract = extractSelected) {
  const artifact = artifactFor(recipe, arch);
  root = await realpath(root);
  for (const [name, directory] of [['bin/node', false], ['include/node', true], ['lib/node_modules/npm', true]]) {
    const path = join(root, name); const stat = await lstat(path);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(path) !== path) throw new Error('Unexpected original runtime path');
  }
  if ((await json(join(root, 'lib/node_modules/npm/package.json'))).version !== recipe.npmCore) throw new Error('Original npm core differs');
  const receiptPath = join(root, '.dollhouse-node-runtime-refresh.json');
  try { await lstat(receiptPath); throw new Error('Runtime refresh receipt already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archive = join(archiveRoot, artifact.filename); const stat = await lstat(archive);
  if (!stat.isFile() || stat.size !== artifact.bytes || await realpath(archive) !== resolve(archive)) throw new Error('Unexpected inert archive file');
  if (await fileHash(archive) !== artifact.sha256) throw new Error('Signed artifact checksum mismatch');
  const before = await inventory(root);
  const stage = await mkdtemp(join(root, '.node-refresh-'));
  try {
    await extract(archive, stage, artifact);
    const staged = await inventory(stage);
    if (Object.entries(staged).some(([name, entry]) => !['file', 'directory'].includes(entry.kind) ||
        !(['bin', 'bin/node', 'include', 'include/node'].includes(name) || under(name, 'include/node')))) throw new Error('Unexpected staged path/link');
    if (staged['bin/node']?.kind !== 'file' || staged['bin/node'].sha256 !== artifact.nodeSha256 ||
        (await lstat(join(stage, 'bin/node'))).size !== artifact.nodeBytes) throw new Error('Candidate binary bytes differ');
    const openssl = join(stage, 'include/node/openssl/archs');
    const allHeaders = await inventory(join(stage, 'include/node'));
    const allowed = name => !name.startsWith('openssl/archs/') || under(name, 'openssl/archs/' + artifact.opensslArch);
    for (const [name, entry] of Object.entries(allHeaders)) {
      if (name.startsWith('openssl/archs/') && name.split('/').length === 3 && !allowed(name)) {
        if (entry.kind !== 'directory') throw new Error('Unexpected OpenSSL architecture entry');
        await rm(join(openssl, name.split('/')[2]), { recursive: true });
      }
    }
    const headers = await inventory(join(stage, 'include/node'));
    const headerRows = Object.entries(headers).filter(([, entry]) => entry.kind === 'file')
      .map(([name, entry]) => [name, entry.sha256]).sort(compare);
    if (headerRows.length !== artifact.headerFiles || hash(JSON.stringify(headerRows)) !== artifact.headerTreeSha256) throw new Error('Candidate header tree differs');
    await chmod(join(stage, 'bin/node'), 0o755);
    // All candidate validation precedes replacement. A later error fails the
    // Docker build layer; never invoke this CLI against a host/global prefix.
    await installValidatedHeaders(join(root, 'include/node'), join(stage, 'include/node'));
    await rename(join(stage, 'bin/node'), join(root, 'bin/node'));
  } finally { await rm(stage, { recursive: true, force: true }); }
  const after = await inventory(root);
  const keep = records => Object.fromEntries(Object.entries(records).filter(([name]) => name !== 'bin/node' && !under(name, 'include/node')));
  if (JSON.stringify(keep(before)) !== JSON.stringify(keep(after))) throw new Error('Unexpected change outside Node binary/headers (including npm core)');
  const receipt = { schema: 'signed-node-hybrid-refresh-v1', node: recipe.version, npmCore: recipe.npmCore,
    archive: artifact.filename, archiveSha256: artifact.sha256, nodeSha256: artifact.nodeSha256,
    headerTreeSha256: artifact.headerTreeSha256, headerFiles: artifact.headerFiles,
    unchangedOutsideBinaryHeadersSha256: hash(JSON.stringify(keep(after))),
    officialImageClaim: false, bundledNpm11191Copied: false, candidateExecutedByHelper: false };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arch = process.argv[2];
  if (process.platform !== 'linux' || process.version !== 'v24.21.0' ||
      (arch === 'amd64' ? process.arch !== 'x64' : arch !== 'arm64' || process.arch !== 'arm64') ||
      process.getuid?.() !== 0 || process.execPath !== '/usr/local/bin/node') throw new Error('Refresh CLI requires the exact original container runtime');
  const recipe = await json(new URL('./node-runtime-security-refresh.json', import.meta.url));
  console.log(JSON.stringify(await refreshNode('/usr/local', '/tmp/node-runtime-distributions', recipe, arch)));
}
