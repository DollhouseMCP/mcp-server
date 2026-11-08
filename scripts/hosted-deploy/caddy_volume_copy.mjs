/** Copy stopped Caddy volumes into fresh owned volumes without changing originals. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_ENTRIES = 100000;
const MAX_BYTES = 1024 ** 3;
const MAX_FILE = 32 * 1024 ** 2;
const BLOCK = 65536;

function identity(st) {
  return [st.dev, st.ino, st.mode, st.uid, st.gid, st.nlink, st.size, st.mtimeMs, st.ctimeMs].join(':');
}

function checkedDirectory(location) {
  const st = fs.lstatSync(location);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o700) !== 0o700 || (st.mode & 0o022)) {
    throw new Error('Unsafe Caddy volume directory');
  }
  return st;
}

function checkedFile(st) {
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX_FILE || !(st.mode & 0o400) || (st.mode & 0o022)) {
    throw new Error('Unsafe or oversized Caddy volume file');
  }
}

function stableFile(fd, location, before) {
  if (identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(location)) !== identity(before)) {
    throw new Error('Caddy volume file changed');
  }
}

function processFile(source, before, target) {
  checkedFile(before);
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let output;
  try {
    stableFile(input, source, before);
    if (target !== undefined) {
      output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(BLOCK);
    let total = 0;
    while (true) {
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > before.size) throw new Error('Caddy volume file grew');
      digest.update(buffer.subarray(0, count));
      let offset = 0;
      while (output !== undefined && offset < count) {
        const written = fs.writeSync(output, buffer, offset, count - offset);
        if (!written) throw new Error('Short Caddy volume write');
        offset += written;
      }
    }
    if (total !== before.size) throw new Error('Caddy volume file shortened');
    stableFile(input, source, before);
    return digest.digest('hex');
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
}

function countEntry(state, size = 0) {
  state.entries += 1;
  state.bytes += size;
  if (state.entries > MAX_ENTRIES || state.bytes > MAX_BYTES) {
    throw new Error('Caddy volume inventory exceeds bounds');
  }
}

function stableDirectory(location, before, names) {
  if (identity(fs.lstatSync(location)) !== identity(before) ||
      JSON.stringify(fs.readdirSync(location).sort()) !== JSON.stringify(names)) {
    throw new Error('Caddy volume directory changed');
  }
}

function setOwnership(location, stat, uid, gid) {
  fs.chownSync(location, uid, gid);
  fs.chmodSync(location, stat.mode & 0o7777);
}

function copyTree(source, target, prefix, state, uid, gid) {
  const before = checkedDirectory(source);
  checkedDirectory(target);
  const names = fs.readdirSync(source).sort();
  for (const name of names) {
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw new Error('Unsafe Caddy volume path');
    }
    const src = path.join(source, name);
    const dst = path.join(target, name);
    const relative = prefix + '/' + name;
    const st = fs.lstatSync(src);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      countEntry(state);
      fs.mkdirSync(dst, { mode: 0o700 });
      copyTree(src, dst, relative, state, uid, gid);
      setOwnership(dst, st, uid, gid);
      state.rows.push({ path: relative, type: 'directory', mode: st.mode & 0o7777 });
    } else {
      checkedFile(st);
      countEntry(state, st.size);
      const sha256 = processFile(src, st, dst);
      setOwnership(dst, st, uid, gid);
      state.rows.push({ path: relative, type: 'file', mode: st.mode & 0o7777, size: st.size, sha256 });
    }
  }
  stableDirectory(source, before, names);
}

function snapshotTree(root, prefix, state, owner) {
  const before = checkedDirectory(root);
  if (owner && (before.uid !== owner.uid || before.gid !== owner.gid)) throw new Error('Caddy destination owner mismatch');
  const names = fs.readdirSync(root).sort();
  for (const name of names) {
    const location = path.join(root, name);
    const relative = prefix + '/' + name;
    const st = fs.lstatSync(location);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      countEntry(state);
      snapshotTree(location, relative, state, owner);
      state.rows.push({ path: relative, type: 'directory', mode: st.mode & 0o7777 });
    } else {
      checkedFile(st);
      countEntry(state, st.size);
      if (owner && (st.uid !== owner.uid || st.gid !== owner.gid)) throw new Error('Caddy destination owner mismatch');
      state.rows.push({ path: relative, type: 'file', mode: st.mode & 0o7777, size: st.size, sha256: processFile(location, st) });
    }
  }
  stableDirectory(root, before, names);
}

function snapshot(roots, owner) {
  const state = { entries: 0, bytes: 0, rows: [] };
  for (const kind of ['data', 'config']) snapshotTree(roots[kind], kind, state, owner);
  return state.rows;
}

function volumeReceipt(rows, rootModes) {
  return {
    schema: 'caddy-volume-clone-v1',
    entries: rows.length,
    bytes: rows.reduce((sum, row) => sum + (row.size ?? 0), 0),
    root_modes: rootModes,
    inventory_sha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    certificate_sha256: rows.filter(row => row.type === 'file' && /\.(crt|pem)$/i.test(row.path)).map(row => row.sha256).sort(),
  };
}

export function verifyVolumes(sourceRoots, targetRoots, uid = 1001, gid = 1001) {
  const rootModes = {};
  const identities = [];
  for (const kind of ['data', 'config']) {
    const source = checkedDirectory(sourceRoots[kind]);
    const target = checkedDirectory(targetRoots[kind]);
    if (target.uid !== uid || target.gid !== gid || (source.mode & 0o7777) !== (target.mode & 0o7777)) {
      throw new Error('Caddy volume root ownership or mode mismatch');
    }
    rootModes[kind] = source.mode & 0o7777;
    identities.push(`${source.dev}:${source.ino}`, `${target.dev}:${target.ino}`);
  }
  if (new Set(identities).size !== identities.length) throw new Error('Caddy source and destination roots must be distinct');
  const original = snapshot(sourceRoots);
  if (JSON.stringify(snapshot(targetRoots, { uid, gid })) !== JSON.stringify(original)) {
    throw new Error('Caddy volume tree changed or differs after copy');
  }
  return volumeReceipt(original, rootModes);
}

export function inventorySource(sourceRoots) {
  const rootModes = {};
  const identities = [];
  for (const kind of ['data', 'config']) {
    const source = checkedDirectory(sourceRoots[kind]);
    rootModes[kind] = source.mode & 0o7777;
    identities.push(`${source.dev}:${source.ino}`);
  }
  if (new Set(identities).size !== identities.length) throw new Error('Caddy source roots must be distinct');
  return volumeReceipt(snapshot(sourceRoots), rootModes);
}

export function verifyFresh(targetRoots, uid = 1001, gid = 1001) {
  const identities = [];
  for (const kind of ['data', 'config']) {
    const root = targetRoots[kind];
    const rootStat = checkedDirectory(root);
    const child = path.join(root, 'caddy');
    const childStat = checkedDirectory(child);
    for (const item of [rootStat, childStat]) {
      if (item.uid !== uid || item.gid !== gid || (item.mode & 0o7777) !== 0o750) {
        throw new Error('Fresh Caddy volume metadata does not match the qualified image');
      }
    }
    if (JSON.stringify(fs.readdirSync(root)) !== JSON.stringify(['caddy']) || fs.readdirSync(child).length !== 0) {
      throw new Error('Fresh Caddy volume is not the qualified empty layout');
    }
    identities.push(`${rootStat.dev}:${rootStat.ino}`);
    stableDirectory(child, childStat, []);
    stableDirectory(root, rootStat, ['caddy']);
  }
  if (new Set(identities).size !== 2) throw new Error('Fresh Caddy volumes must be distinct');
  return { schema: 'caddy-fresh-volumes-v1', data_mode: 0o750, config_mode: 0o750, owner: uid, group: gid };
}

export function copyVolumes(sourceRoots, targetRoots, uid = 1001, gid = 1001) {
  const state = { entries: 0, bytes: 0, rows: [] };
  const rootModes = {};
  const roots = [sourceRoots.data, sourceRoots.config, targetRoots.data, targetRoots.config];
  const identities = roots.map(location => {
    const st = checkedDirectory(location);
    return `${st.dev}:${st.ino}`;
  });
  if (new Set(identities).size !== roots.length) throw new Error('Caddy source and destination roots must be distinct');
  for (const kind of ['data', 'config']) {
    if (fs.readdirSync(targetRoots[kind]).length) throw new Error('Caddy destination volume is not empty');
  }
  for (const kind of ['data', 'config']) {
    const source = sourceRoots[kind];
    const target = targetRoots[kind];
    const before = checkedDirectory(source);
    rootModes[kind] = before.mode & 0o7777;
    if (fs.readdirSync(target).length) throw new Error('Caddy destination volume is not empty');
    copyTree(source, target, kind, state, uid, gid);
    setOwnership(target, before, uid, gid);
    if (identity(fs.lstatSync(source)) !== identity(before)) throw new Error('Caddy source root changed');
  }
  for (const kind of ['data', 'config']) {
    if ((checkedDirectory(sourceRoots[kind]).mode & 0o7777) !== rootModes[kind] ||
        (checkedDirectory(targetRoots[kind]).mode & 0o7777) !== rootModes[kind]) throw new Error('Caddy volume root mode mismatch');
  }
  const expected = JSON.stringify(state.rows);
  if (JSON.stringify(snapshot(sourceRoots)) !== expected || JSON.stringify(snapshot(targetRoots, { uid, gid })) !== expected) {
    throw new Error('Caddy volume tree changed or differs after copy');
  }
  return volumeReceipt(state.rows, rootModes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && !['--verify', '--verify-source', '--verify-fresh'].includes(process.argv[2]))) throw new Error('Only fixed verification modes are accepted');
    const source = { data: '/source/data', config: '/source/config' };
    const target = { data: '/target/data', config: '/target/config' };
    let result;
    if (process.argv[2] === '--verify') result = verifyVolumes(source, target);
    else if (process.argv[2] === '--verify-source') result = inventorySource(source);
    else if (process.argv[2] === '--verify-fresh') result = verifyFresh(target);
    else result = copyVolumes(source, target);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write('Caddy volume copy refused: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
