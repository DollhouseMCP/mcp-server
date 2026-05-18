import { describe, it, expect } from '@jest/globals';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(process.cwd());
const srcRoot = path.join(projectRoot, 'src');
const allowlistPath = path.join(projectRoot, 'tests', 'architecture', 'file-lock-manager-allowlist.json');
const directAtomicCallPattern =
  /\b(?:this\.(?:locks|fileLockManager)|fileLockManager|locks)\.atomic(?:Read|Write)File\s*\(/g;

describe('FileLockManager direct callers architecture', () => {
  it('keeps direct FileLockManager atomic calls limited to FOS or explicit operator-scope allowlist', async () => {
    const allowlist = JSON.parse(await fs.readFile(allowlistPath, 'utf8')) as string[];
    const files = await listTypeScriptFiles(srcRoot);
    const violations: string[] = [];
    const allowed = new Set(allowlist);

    for (const file of files) {
      const rel = path.relative(projectRoot, file).replaceAll(path.sep, '/');
      const source = stripComments(await fs.readFile(file, 'utf8'));
      const matches = [...source.matchAll(directAtomicCallPattern)];
      if (matches.length === 0) continue;
      if (rel === 'src/services/FileOperationsService.ts') continue;
      if (allowed.has(rel)) continue;

      violations.push(`${rel} (${matches.length} direct atomic call${matches.length === 1 ? '' : 's'})`);
    }

    expect(violations).toEqual([]);
  });
});

async function listTypeScriptFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith('.ts')) return [fullPath];
    return [];
  }));
  return files.flat();
}

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1'); // NOSONAR — strips // comments from source at test time; input is repo files, not attacker-supplied
}
