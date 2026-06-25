import { describe, expect, it } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

interface PackageJson {
  dependencies?: Record<string, string>;
  bin?: Record<string, string>;
}

const COMMANDER_IMPORT_PATTERN = /\bfrom\s+['"]commander['"]|\brequire\(\s*['"]commander['"]\s*\)/u;
const PROJECT_ROOT = process.cwd();
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

function sourcePathForBin(binPath: string): string | null {
  if (!binPath.startsWith('dist/') || !binPath.endsWith('.js')) return null;
  const sourceBase = path.join(PROJECT_ROOT, binPath.replace(/^dist\//u, 'src/').replace(/\.js$/u, ''));
  return SOURCE_EXTENSIONS
    .map(extension => `${sourceBase}${extension}`)
    .find(existsSync) ?? null;
}

describe('published CLI bin dependencies', () => {
  it('declares commander as a production dependency for packaged bins that import it', () => {
    const packageJson = readPackageJson();
    const binEntries = Object.entries(packageJson.bin ?? {});
    const binSources = binEntries
      .map(([name, binPath]) => ({ name, binPath, sourcePath: sourcePathForBin(binPath) }));
    const missingSources = binSources.filter(entry => entry.binPath.startsWith('dist/') && entry.sourcePath === null);
    const binsImportingCommander = binSources
      .filter((entry): entry is { name: string; binPath: string; sourcePath: string } => entry.sourcePath !== null)
      .filter(entry => COMMANDER_IMPORT_PATTERN.test(readFileSync(entry.sourcePath, 'utf8')))
      .map(entry => entry.name)
      .sort();

    // This is intentionally Commander-specific: add similar checks when a
    // packaged bin imports another package that is easy to strand in dev deps.
    expect(missingSources).toEqual([]);
    expect(binsImportingCommander.length).toBeGreaterThan(0);
    expect(packageJson.dependencies?.commander).toBeDefined();
  });
});
