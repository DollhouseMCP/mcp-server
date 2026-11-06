import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { CodeScanner } from '../../../../src/security/audit/scanners/CodeScanner.js';

const rootRequire = createRequire(path.join(process.cwd(), 'package.json'));
const portable = (value: string) => value.replaceAll('\\', '/');
const fromConsumer = (name: string, dependency: string) => createRequire(rootRequire.resolve(name))(dependency);
let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modern-glob-qualification-')));
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  for (const name of ['src/a.ts', 'src/b.js', 'src/nested/c.ts', 'src/.hidden.ts', 'src/skip.ts']) {
    fs.writeFileSync(path.join(dir, name), 'export const value = 1;\n');
  }
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('modern glob consumer qualification', () => {
  test('actual consumer-resolved glob respects cwd, absolute, ignore, dot and braces', async () => {
    for (const consumer of ['@jest/reporters', 'jest-config', 'jest-runtime', 'archiver-utils']) {
      const glob = fromConsumer(consumer, 'glob');
      const matches = glob.globSync('src/**/*.{ts,js}', { cwd: dir, ignore: '**/skip.ts' }).map(portable).sort();
      expect(matches).toEqual(['src/a.ts', 'src/b.js', 'src/nested/c.ts']);
      const withDot = glob.globSync('src/*.ts', { cwd: dir, dot: true, absolute: true }).sort();
      expect(withDot).toEqual(['.hidden.ts', 'a.ts', 'skip.ts'].map(x => path.join(dir, 'src', x)).sort());
      const controller = new AbortController(); controller.abort();
      await expect(glob.glob('**/*', { cwd: dir, signal: controller.signal })).rejects.toBeDefined();
    }
  });

  test('mid-walk cancellation stops after the first real directory read', async () => {
    const { glob } = fromConsumer('jest-runtime', 'glob');
    const controller = new AbortController(); const reason = new Error('cancel fixture'); let calls = 0;
    const walk = glob('**/*', { cwd: dir, signal: controller.signal, fs: {
      readdir: (location: string, options: { withFileTypes: true }, callback: (error: NodeJS.ErrnoException | null, entries?: fs.Dirent[]) => void) => {
        calls++;
        fs.readdir(location, options, (error, entries) => { controller.abort(reason); callback(error, entries); });
      }
    } });
    await expect(walk).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  test('glob default bundle and external minimatch bound globstar-parent expansion', () => {
    const setup = "const pattern='**/../a/b/'.repeat(12)+'target'; const options={optimizationLevel:2,braceExpandMax:64};";
    for (const expression of [
      "console.log(new (require('glob').Glob)(pattern,{...options,cwd:process.argv[1]}).patterns.length);",
      "console.log(new (require('minimatch').Minimatch)(pattern,options).globParts.length);"
    ]) {
      const child = spawnSync(process.execPath, ['-e', setup + expression, dir], { cwd: process.cwd(), encoding: 'utf8', timeout: 3000 });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
      expect(Number(child.stdout)).toBeGreaterThan(0); expect(Number(child.stdout)).toBeLessThanOrEqual(64);
    }
  });

  test('archiver-utils expands and excludes real files in order', () => {
    const file = rootRequire('archiver-utils/file');
    expect(file.expand({ cwd: dir }, ['src/*.ts', '!src/skip.ts']).map(portable)).toEqual(['src/a.ts']);
    expect(file.expandMapping(['src/*.ts', '!src/skip.ts'], 'out', { cwd: dir }).map((x: { src: string[] }) => x.src)).toEqual([[portable(path.join(dir, 'src/a.ts'))]]);
  });

  test('archiver selects real files using its glob consumer', async () => {
    const archive = rootRequire('archiver')('zip');
    const sink = new PassThrough(); sink.resume();
    const names: string[] = [];
    archive.on('entry', (entry: { name: string }) => names.push(entry.name));
    archive.pipe(sink);
    archive.glob('src/**/*.{ts,js}', { cwd: dir, ignore: '**/skip.ts' });
    await archive.finalize();
    expect(names.sort()).toEqual(['src/a.ts', 'src/b.js', 'src/nested/c.ts']);
  });

  test('Jest config expands the real projects glob', async () => {
    fs.mkdirSync(path.join(dir, 'projects', 'one'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'projects', 'two'), { recursive: true });
    const { normalize } = rootRequire('jest-config');
    const result = await normalize({ rootDir: dir, projects: ['<rootDir>/projects/*'] }, {}, undefined);
    expect(result.options.projects.map((x: string) => fs.realpathSync.native(x)).sort())
      .toEqual(['one', 'two'].map(x => fs.realpathSync.native(path.join(dir, 'projects', x))).sort());
  });

  test('Jest coverage reporter applies the glob threshold to a real coverage map', () => {
    const file = path.join(dir, 'src', 'a.ts');
    const { createCoverageMap } = rootRequire('istanbul-lib-coverage');
    const map = createCoverageMap({ [file]: { path: file, statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } } }, fnMap: {}, branchMap: {}, s: { 0: 1 }, f: {}, b: {} } });
    const { CoverageReporter } = rootRequire('@jest/reporters');
    const reporter = new CoverageReporter({ coverageThreshold: { [path.join(dir, 'src', '*.ts')]: { statements: 100 } } }, {});
    reporter._checkThreshold(map);
    expect(reporter.getLastError()).toBeUndefined();
  });

  test('application CodeScanner uses named async glob with absolute and ignored files', async () => {
    const scanner = new CodeScanner({ enabled: true, rules: [], exclude: ['**/skip.ts'] });
    const files = await (scanner as unknown as { getFilesToScan(root: string): Promise<string[]> }).getFilesToScan(dir);
    expect(files.sort()).toEqual(['src/a.ts', 'src/b.js', 'src/nested/c.ts'].map(x => path.join(dir, x)).sort());
  });

  test('external minimatch honors dot and brace patterns through TypeScript-estree parent', () => {
    const { minimatch } = fromConsumer('@typescript-eslint/typescript-estree', 'minimatch');
    expect(minimatch('.hidden.ts', '*.ts')).toBe(false);
    expect(minimatch('.hidden.ts', '*.{ts,js}', { dot: true })).toBe(true);
    expect(minimatch('folder/a.ts', 'folder/*.{js,ts}')).toBe(true);
  });

  test('TypeScript-estree project service accepts a dotfile through allowDefaultProject', () => {
    const file = path.join(dir, '.hidden.ts');
    fs.writeFileSync(file, 'export const value = 1;');
    const estree = rootRequire('@typescript-eslint/typescript-estree');
    const parsed = estree.parseAndGenerateServices('export const value = 1;', {
      filePath: file, tsconfigRootDir: dir, projectService: { allowDefaultProject: ['*.ts'] }
    });
    expect(parsed.services.program).toBeTruthy();
  });

  test('Windows drive and UNC patterns use the supported platform abstraction', () => {
    const { Minimatch } = fromConsumer('@typescript-eslint/typescript-estree', 'minimatch');
    const options = { windowsPathsNoEscape: true, platform: 'win32' };
    expect(new Minimatch('C:\\repo\\*.ts', options).match('C:/repo/a.ts')).toBe(true);
    expect(new Minimatch('\\\\server\\share\\*.ts', options).match('//server/share/a.ts')).toBe(true);
  });

  test('default glob bundle and external matcher settle bounded pathological cases', () => {
    const pattern = "const pattern='+(a|aa|aaa|aaaa|aaaaa)'.repeat(8)+'b';";
    for (const expression of [
      "console.log(JSON.stringify(new (require('glob').Glob)(pattern,{cwd:process.argv[1]}).walkSync()));",
      "console.log(JSON.stringify(require('minimatch').minimatch('a'.repeat(80)+'c',pattern)));"
    ]) {
      const child = spawnSync(process.execPath, ['-e', pattern + expression, dir], { cwd: process.cwd(), encoding: 'utf8', timeout: 3000 });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(expression.includes('Glob') ? [] : false);
    }
  });

  test('Jest runtime reports actual extension suggestions', () => {
    const find = rootRequire('jest-runtime').default.findSiblingsWithFileExtension;
    if (typeof find !== 'function') {
      const testFile = path.join(dir, 'suggest.test.js');
      fs.writeFileSync(testFile, "require('./target'); test('fixture', () => {});\n");
      fs.writeFileSync(path.join(dir, 'target.xyz'), 'fixture');
      const jest = rootRequire.resolve('jest/bin/jest');
      const result = spawnSync(process.execPath, [jest, '--runInBand', '--no-cache', '--config', JSON.stringify({ rootDir: dir, testRegex: 'suggest\\.test\\.js$', moduleFileExtensions: ['js'] })], { encoding: 'utf8', timeout: 8000, env: { ...process.env, NODE_OPTIONS: '' } });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('./target.xyz');
    } else {
      fs.writeFileSync(path.join(dir, 'target.xyz'), 'fixture');
      expect(find(['js'], path.join(dir, 'suggest.test.cjs'), './target')).toContain('./target.xyz');
    }
  });
});
