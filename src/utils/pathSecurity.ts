import * as fs from 'node:fs';
import * as path from 'node:path';

function assertNotSymlink(pathToCheck: string, message: string): void {
  try {
    const stats = fs.lstatSync(pathToCheck);
    if (stats.isSymbolicLink()) {
      throw new Error(message);
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return;
    }
    throw error;
  }
}

function assertNoSymlinkedDescendants(resolvedBase: string, resolvedTarget: string): void {
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  if (!relativePath) {
    return;
  }

  let currentPath = resolvedBase;
  for (const segment of relativePath.split(path.sep)) {
    if (!segment) {
      continue;
    }

    currentPath = path.join(currentPath, segment);
    assertNotSymlink(currentPath, 'Path segment resolves through a symbolic link');
  }
}

/**
 * Resolve a target path and verify that it remains inside the intended base
 * directory. This is separator-aware, so sibling paths such as `/tmp/base2`
 * are not treated as children of `/tmp/base`. Existing symlinked base paths
 * and symlinked descendants under the base are rejected because writes would
 * follow them outside the lexical containment boundary.
 */
export function resolvePathWithinBase(baseDir: string, ...segments: string[]): string {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new TypeError('Base directory must be a non-empty string');
  }

  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new TypeError('Path segments must be strings');
    }
    if (segment.includes('\0')) {
      throw new Error('Path segment contains a null byte');
    }
  }

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, ...segments);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  const isTraversal = relativePath === '..'
    || relativePath.startsWith('..' + path.sep)
    || path.isAbsolute(relativePath);

  if (!isTraversal) {
    assertNotSymlink(resolvedBase, 'Base directory resolves through a symbolic link');
    assertNoSymlinkedDescendants(resolvedBase, resolvedTarget);
    return resolvedTarget;
  }

  throw new Error('Resolved path escapes the base directory');
}
