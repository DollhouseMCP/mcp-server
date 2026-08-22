import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

describe('copy-runtime-assets', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'copy-runtime-assets-'));
    const scriptPath = join(projectRoot, 'scripts', 'copy-runtime-assets.mjs');
    await mkdir(dirname(scriptPath), { recursive: true });
    await copyFile(join(process.cwd(), 'scripts', 'copy-runtime-assets.mjs'), scriptPath);

    for (const source of ['src/seed-elements', 'src/web/public', 'src/web-console/ui']) {
      await mkdir(join(projectRoot, source), { recursive: true });
      await writeFile(join(projectRoot, source, 'current.txt'), source, 'utf8');
    }

    for (const destination of ['dist/seed-elements', 'dist/web/public', 'dist/web-console/ui']) {
      await mkdir(join(projectRoot, destination), { recursive: true });
      await writeFile(join(projectRoot, destination, 'stale.txt'), 'stale', 'utf8');
    }
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('replaces every runtime asset tree instead of retaining stale package files', async () => {
    execFileSync(process.execPath, [join(projectRoot, 'scripts', 'copy-runtime-assets.mjs')], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    for (const [source, destination] of [
      ['src/seed-elements', 'dist/seed-elements'],
      ['src/web/public', 'dist/web/public'],
      ['src/web-console/ui', 'dist/web-console/ui'],
    ]) {
      await expect(readFile(join(projectRoot, destination, 'current.txt'), 'utf8')).resolves.toBe(source);
      await expect(readFile(join(projectRoot, destination, 'stale.txt'), 'utf8')).rejects.toThrow();
    }
  });
});
