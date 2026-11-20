// Final-image hardening only. No arguments, environment overrides or downloads.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const tools = [
  { path: '/usr/bin/infocmp', owner: '/var/lib/dpkg/info/ncurses-bin.list', mode: 0o755 },
  { path: '/usr/bin/nsenter', owner: '/var/lib/dpkg/info/util-linux.list', mode: 0o755 },
  { path: '/usr/bin/mount', owner: '/var/lib/dpkg/info/mount.list', mode: 0o4755 },
  { path: '/usr/bin/umount', owner: '/var/lib/dpkg/info/mount.list', mode: 0o4755 },
];

function requireOwnedFile(io, path, mode) {
  const stat = io.lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o7777) !== mode || stat.nlink !== 1) {
    throw new Error(`Unexpected final-image file identity: ${path}`);
  }
}

// The injectable filesystem lets offline tests exercise the exact production
// guards against owned fixtures without writing to the host's /usr directory.
export function removeOptionalRuntimeTools(io = fs) {
  // Validate ALL four tools and package ownership before deleting any path.
  for (const tool of tools) {
    requireOwnedFile(io, tool.path, tool.mode);
    requireOwnedFile(io, tool.owner, 0o644);
    const entries = io.readFileSync(tool.owner, 'utf8').split('\n');
    if (entries.filter(entry => entry === tool.path).length !== 1) {
      throw new Error(`Expected dpkg ownership missing or repeated: ${tool.path}`);
    }
  }
  for (const tool of tools) io.unlinkSync(tool.path);
  for (const tool of tools) {
    try {
      io.lstatSync(tool.path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`Optional runtime tool remains: ${tool.path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  removeOptionalRuntimeTools();
}
