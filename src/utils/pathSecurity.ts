import * as path from 'node:path';

/**
 * Resolve a target path and verify that it remains inside the intended base
 * directory. This is separator-aware, so sibling paths such as `/tmp/base2`
 * are not treated as children of `/tmp/base`.
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

  if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return resolvedTarget;
  }

  throw new Error('Resolved path escapes the base directory');
}
