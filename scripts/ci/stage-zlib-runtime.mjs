import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '1:1.3.dfsg+really1.3.1-1+deb13u1';
export const SHA256 = Object.freeze({
  amd64: '8c27c342230503b73dfde629642c3b352e87b554e06d60cf58772f236a305ceb',
  arm64: '0e41b3d7ad8ad7fcd36dd4d61ca91a70018478fc4af652e044f4be770784ddff',
});
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function field(text, name) {
  const rows = [...text.matchAll(new RegExp(String.raw`^${name}: ([^\r\n]+)$`, 'gm'))];
  requireValue(rows.length === 1, `Invalid ${name} field`);
  return rows[0][1];
}
export function validateControl(text, arch) {
  requireValue(Object.hasOwn(SHA256, arch), 'Unsupported architecture');
  requireValue(field(text, 'Package') === 'zlib1g', 'Unexpected package');
  requireValue(field(text, 'Version') === VERSION, 'Unexpected version');
  requireValue(field(text, 'Architecture') === arch, 'Unexpected architecture');
  const source = field(text, 'Source');
  requireValue(source === 'zlib' || source === `zlib (${VERSION})`, 'Unexpected source');
  requireValue(!/^Status:/m.test(text), 'Unexpected status field');
}
export function validateDigest(bytes, arch, expected = SHA256) {
  requireValue(Object.hasOwn(expected, arch) && hash('sha256', bytes) === expected[arch], 'Package digest mismatch');
}
function safeRelative(path) {
  requireValue(path.length <= 512 && /^[A-Za-z0-9+._/-]+$/.test(path) && !path.startsWith('/') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..'), 'Unsafe payload path');
}
export function validatePayload(root, md5sums, arch) {
  const rootReal = realpathSync(root); const files = new Map(); const entries = []; let count = 0; let total = 0;
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name; safeRelative(rel);
      const path = join(dir, entry.name); const st = lstatSync(path);
      requireValue(++count <= 2048, 'Payload entry count exceeded');
      if (!st.isSymbolicLink()) requireValue(!(st.mode & 0o022), 'Unsafe payload mode');
      if (st.isDirectory()) { entries.push({ path: rel, type: 'directory', mode: st.mode & 0o777 }); visit(path, rel); continue; }
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path);
        requireValue(!target.startsWith('/') && !target.split('/').includes('..'), 'Unsafe payload link');
        const actual = realpathSync(path);
        requireValue(actual.startsWith(rootReal + sep), 'Escaping payload link');
        entries.push({ path: rel, type: 'symlink', target });
        continue;
      }
      requireValue(st.isFile() && st.nlink === 1 && st.size <= 16 * 1024 * 1024, 'Unsafe payload file');
      total += st.size; requireValue(total <= 32 * 1024 * 1024, 'Payload too large');
      const bytes = readFileSync(path);
      files.set(rel, hash('md5', bytes));
      entries.push({ path: rel, type: 'file', mode: st.mode & 0o777, size: st.size, sha256: hash('sha256', bytes) });
    }
  }
  visit(rootReal);
  const lines = md5sums.trimEnd().split('\n'); const seen = new Set();
  for (const line of lines) {
    const match = /^([a-f0-9]{32})[ ]{2}([A-Za-z0-9+._/-]+)$/.exec(line);
    requireValue(match, 'Invalid md5 entry'); const [, digest, rel] = match; safeRelative(rel);
    requireValue(!seen.has(rel) && files.get(rel) === digest, 'Payload checksum mismatch'); seen.add(rel);
  }
  requireValue(seen.size === files.size, 'Payload inventory incomplete');
  const triplet = arch === 'amd64' ? 'x86_64-linux-gnu' : 'aarch64-linux-gnu';
  const link = join(rootReal, 'usr', 'lib', triplet, 'libz.so.1');
  requireValue(lstatSync(link).isSymbolicLink() && readlinkSync(link) === 'libz.so.1.3.1', 'Unexpected zlib link');
  const library = realpathSync(link); requireValue(library.startsWith(rootReal + sep), 'Escaping zlib link');
  const bytes = readFileSync(library);
  requireValue(bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
    bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(16) === 3 &&
    bytes.readUInt16LE(18) === (arch === 'amd64' ? 62 : 183), 'Unexpected zlib ELF');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { files: files.size, bytes: total, librarySha256: hash('sha256', bytes), entries };
}
export function stage(archive, arch, overlay, controlDir) {
  const archiveStat = lstatSync(archive);
  requireValue(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1 &&
    archiveStat.size <= 16 * 1024 * 1024, 'Unsafe package file');
  const archiveBytes = readFileSync(archive); validateDigest(archiveBytes, arch);
  const control = execFileSync('/usr/bin/dpkg-deb', ['-f', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  validateControl(control, arch);
  mkdirSync(overlay, { mode: 0o700 }); mkdirSync(controlDir, { mode: 0o700 });
  execFileSync('/usr/bin/dpkg-deb', ['-x', archive, overlay], { stdio: 'inherit' });
  execFileSync('/usr/bin/dpkg-deb', ['-e', archive, controlDir], { stdio: 'inherit' });
  const extractedControl = readFileSync(join(controlDir, 'control'), 'utf8');
  validateControl(extractedControl, arch);
  const md5 = readFileSync(join(controlDir, 'md5sums'), 'utf8');
  const inventory = validatePayload(overlay, md5, arch);
  const status = join(overlay, 'var/lib/dpkg/status.d'); mkdirSync(status, { recursive: true, mode: 0o755 });
  writeFileSync(join(status, 'zlib1g'), extractedControl, { flag: 'wx', mode: 0o644 });
  writeFileSync(join(status, 'zlib1g.md5sums'), md5, { flag: 'wx', mode: 0o644 });
  return { package: 'zlib1g', version: VERSION, source: 'zlib', architecture: arch,
    debSha256: hash('sha256', archiveBytes), ...inventory };
}
export function validateWorkspace(path, owner = 0) {
  const st = lstatSync(path);
  requireValue(st.isDirectory() && !st.isSymbolicLink() && st.uid === owner && (st.mode & 0o7777) === 0o700,
    'Unsafe zlib workspace');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  validateWorkspace('/root/zlib-runtime');
  const arch = execFileSync('/usr/bin/dpkg', ['--print-architecture'], { encoding: 'utf8' }).trim();
  requireValue((process.arch === 'x64' && arch === 'amd64') ||
    (process.arch === 'arm64' && arch === 'arm64'), 'Runtime and package architectures differ');
  const receipt = stage('/root/zlib-runtime/download/zlib.deb', arch, '/root/zlib-runtime/overlay', '/root/zlib-runtime/control');
  const serialized = JSON.stringify(receipt) + '\n';
  requireValue(Buffer.byteLength(serialized) <= 64 * 1024, 'Receipt exceeds limit');
  writeFileSync('/root/zlib-runtime/receipt.json', serialized, { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
