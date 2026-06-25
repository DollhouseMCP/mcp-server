import { describe, expect, it } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

interface PackageJson {
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

const COMMANDER_IMPORT_PATTERN = /\bfrom\s+['"]commander['"]|\brequire\(\s*['"]commander['"]\s*\)/u;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
}

function sourcePathForBin(binPath: string): string | null {
  if (!binPath.startsWith('dist/') || !binPath.endsWith('.js')) return null;
  return path.join(process.cwd(), binPath.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts'));
}

describe('published CLI bin dependencies', () => {
  it('declares commander as a production dependency for packaged bins that import it', () => {
    const packageJson = readPackageJson();
    const binEntries = Object.entries(packageJson.bin ?? {});
    const binsImportingCommander = binEntries
      .map(([name, binPath]) => ({ name, sourcePath: sourcePathForBin(binPath) }))
      .filter((entry): entry is { name: string; sourcePath: string } =>
        entry.sourcePath !== null && existsSync(entry.sourcePath))
      .filter(entry => COMMANDER_IMPORT_PATTERN.test(readFileSync(entry.sourcePath, 'utf8')))
      .map(entry => entry.name)
      .sort();

    expect(binsImportingCommander).toContain('dollhouse-allowlist');
    expect(binsImportingCommander.length).toBeGreaterThan(0);
    expect(packageJson.dependencies?.commander).toBeDefined();
  });
});
