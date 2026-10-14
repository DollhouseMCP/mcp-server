import { describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NodeHfs } from '@humanfs/node';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const handlebars = require('handlebars');
const root = fileURLToPath(new URL('../../', import.meta.url));

function runNode(directory: string, args: string[]) {
  const env = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory, NO_COLOR: '1' };
  const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8', timeout: 8_000, maxBuffer: 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return result.stdout;
}

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'build-tools-'));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('build tool dependency security boundaries', () => {
  it('does not include source-map contents from outside the input package', async () => {
    await fixture(async directory => {
      const project = join(directory, 'project');
      await mkdir(project);
      await writeFile(join(project, 'package.json'), '{}');
      await writeFile(join(directory, 'outside.map'), JSON.stringify({
        version: 3, sources: ['outside.ts'], sourcesContent: ['outside-map-fixture'], names: [], mappings: 'AAAA',
      }));
      const result = babel.transformSync('const answer = 42;\n//# sourceMappingURL=../outside.map', {
        filename: join(project, 'input.js'), root: project, configFile: false, babelrc: false, sourceMaps: true,
      });
      expect(result.code).toContain('42');
      expect(result.map.sourcesContent).not.toContain('outside-map-fixture');
    });
  });

  it('preserves a legitimate source map inside the same package', async () => {
    await fixture(async directory => {
      await writeFile(join(directory, 'package.json'), '{}');
      await writeFile(join(directory, 'input.map'), JSON.stringify({
        version: 3, sources: ['original.ts'], sourcesContent: ['inside-map-fixture'], names: [], mappings: 'AAAA',
      }));
      const result = babel.transformSync('const answer = 42;\n//# sourceMappingURL=input.map', {
        filename: join(directory, 'input.js'), root: directory, configFile: false, babelrc: false, sourceMaps: true,
      });
      expect(result.map.sourcesContent).toContain('inside-map-fixture');
    });
  });

  it('preserves a copied symlink instead of materializing an external file', async () => {
    await fixture(async directory => {
      const { symlink } = await import('node:fs/promises');
      const source = join(directory, 'source');
      const target = join(directory, 'outside.txt');
      await mkdir(source);
      await writeFile(target, 'synthetic-outside-file');
      await writeFile(join(source, 'ordinary.txt'), 'ordinary-file');
      await symlink(target, join(source, 'link.txt'), 'file');
      const hfs = new NodeHfs();
      await hfs.copyAll(source, join(directory, 'copied'));
      await hfs.copy(join(source, 'link.txt'), join(directory, 'direct-link'));
      expect((await lstat(join(directory, 'copied/link.txt'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(directory, 'copied/link.txt'))).toBe(target);
      expect((await lstat(join(directory, 'direct-link'))).isSymbolicLink()).toBe(true);
      expect(await readFile(join(directory, 'copied/ordinary.txt'), 'utf8')).toBe('ordinary-file');
    });
  });

  it('escapes script terminators in precompiled source while retaining rendered text', () => {
    const input = 'safe</script><script>fixture</script>';
    const compiled = handlebars.precompile(input);
    expect(compiled).not.toMatch(/<\/script>/i);
    expect(handlebars.compile(input)({})).toBe(input);
  });

  it('refuses a malformed AST block-parameter length before generating code', () => {
    const ast = handlebars.parse('{{#if enabled}}safe{{/if}}');
    ast.body[0].program.blockParams = { length: '(()=>{throw new Error("fixture-injection")})()' };
    expect(() => handlebars.precompile(ast)).toThrow();
  });

  it('does not expose a prototype constructor through its own property', () => {
    const template = handlebars.compile('{{lookup (lookup fn "__proto__") "constructor"}}');
    expect(template({ fn() { return 'ordinary'; } }, { allowProtoMethodsByDefault: true })).toBe('');
    expect(handlebars.compile('{{constructor}}')({ constructor: 'ordinary-own-value' })).toBe('ordinary-own-value');
    expect(handlebars.compile(handlebars.parse('Hello {{name}}'))({ name: 'fixture' })).toBe('Hello fixture');
  });

  it('keeps core-utils sync and async TypeScript transform contracts', async () => {
    const loaderRequire = createRequire(require.resolve('@esbuild-kit/esm-loader'));
    const core = loaderRequire('@esbuild-kit/core-utils');
    const coreRequire = createRequire(loaderRequire.resolve('@esbuild-kit/core-utils'));
    expect(coreRequire('esbuild').version).toBe('0.25.12');
    const input = 'enum Choice { one = 41 }; export const answer: number = Choice.one + 1;';
    const sync = core.transformSync(input, '/fixture/input.cts');
    const asyncResult = await core.transform(input, '/fixture/input.mts');
    expect(sync.code).toContain('exports');
    expect(asyncResult.code).toContain('export');
    expect(sync.map.sources[0]).toContain('input.cts');
    expect(asyncResult.map.sources[0]).toContain('input.mts');
    expect(sync.warnings ?? []).toEqual([]);
    expect(asyncResult.warnings ?? []).toEqual([]);
  });
});

describe('actual build tool CLI consumers', () => {
  it('keeps the ts-jest fixed-template config-init path usable', async () => {
    await fixture(async directory => {
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      runNode(directory, [require.resolve('ts-jest/cli.js'), 'config:init']);
      const output = await readFile(join(directory, 'jest.config.js'), 'utf8');
      expect(output).toContain('createDefaultPreset');
      expect(output).toContain('export default');
      expect(output).toContain('testEnvironment: "node"');
    });
  });

  it('executes TypeScript enum code through the actual ESM loader', async () => {
    await fixture(async directory => {
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'input.ts'), 'enum Choice { one = 41 }; console.log(Choice.one + 1);\n');
      const output = runNode(directory, ['--loader', require.resolve('@esbuild-kit/esm-loader'), join(directory, 'input.ts')]);
      expect(output.trim()).toBe('42');
    });
  });

  it('generates a PostgreSQL migration from a TypeScript config without a database', async () => {
    const directory = await mkdtemp(join(root, '.build-tool-proof-'));
    try {
      await writeFile(join(directory, 'package.json'), '{"type":"module"}');
      await writeFile(join(directory, 'schema.ts'), 'import { pgTable, serial, text } from "drizzle-orm/pg-core";\nexport const fixture = pgTable("security_fixture", { id: serial("id").primaryKey(), label: text("label").notNull() });\n');
      await writeFile(join(directory, 'config.ts'), 'import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./schema.ts", out: "./out" });\n');
      const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
      runNode(directory, [bin, 'generate', '--config=config.ts', '--name=fixture']);
      const sql = await readFile(join(directory, 'out/0000_fixture.sql'), 'utf8');
      expect(sql).toContain('CREATE TABLE "security_fixture"');
      expect(sql).toContain('"label" text NOT NULL');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
