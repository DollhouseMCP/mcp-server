import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const BASELINE_REVISION = '094b1823';
const gitExecutable = process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git';
const git = args => execFileSync(gitExecutable, ['-c', 'safe.directory=' + process.cwd(), ...args], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});

export const readAtBaseline = file => git(['show', BASELINE_REVISION + ':' + file]);
export const listAtBaseline = directory => git(['ls-tree', '-r', '--name-only', '-z', BASELINE_REVISION, '--', directory]).split('\0').filter(Boolean);

/** Use pinned repository sources; only compiler libraries and installed dependencies come from disk. */
export function baselineCompilerHost(ts, options) {
  const host = ts.createCompilerHost(options, true);
  const files = new Set(listAtBaseline('.'));
  const content = new Map();
  const relative = file => path.relative(process.cwd(), path.resolve(file)).split(path.sep).join('/');
  const external = file => file.startsWith('../') || file === '..' || file.startsWith('node_modules/');
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = file => {
    const rel = relative(file);
    if (external(rel)) return readFile(file);
    if (!files.has(rel)) return undefined;
    if (!content.has(rel)) content.set(rel, readAtBaseline(rel));
    return content.get(rel);
  };
  host.fileExists = file => {
    const rel = relative(file);
    return external(rel) ? fileExists(file) : files.has(rel);
  };
  host.getSourceFile = (file, languageVersion) => {
    const source = host.readFile(file);
    return source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion, true);
  };
  return host;
}
