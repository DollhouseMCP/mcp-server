import * as fs from 'node:fs';
import * as path from 'node:path';

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * lstat of the deepest ancestor of `startPath` that exists, or null when
 * nothing up to the filesystem root exists. Used to vet paths that will be
 * created later: their containment depends on the directory they will be
 * created inside.
 */
function nearestExistingAncestorStats(startPath: string): fs.Stats | null {
  let previous = startPath;
  let current = path.dirname(startPath);
  while (current !== previous) {
    try {
      return fs.lstatSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    previous = current;
    current = path.dirname(current);
  }
  return null;
}

function assertNotSymlink(pathToCheck: string, message: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(pathToCheck);
  } catch (error) {
    if (isMissingPathError(error)) {
      // The path does not exist yet, so it will be created by a later
      // mkdir/write. That is only safe if the directory it gets created
      // inside is real: a symlinked existing ancestor would redirect the
      // recursive create outside the containment boundary (#2342).
      const ancestorStats = nearestExistingAncestorStats(pathToCheck);
      if (ancestorStats?.isSymbolicLink()) {
        throw new Error(message);
      }
      return;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(message);
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
 * follow them outside the lexical containment boundary. A base that does not
 * exist yet is vetted through its nearest existing ancestor: if that ancestor
 * is a symlink, the recursive mkdir/write that follows would be redirected
 * outside the intended tree, so it is rejected too (#2342).
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
