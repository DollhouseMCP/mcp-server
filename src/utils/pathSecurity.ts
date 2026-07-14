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
 *
 * KNOWN LIMIT (#2344): this stops at the first ancestor lstat can see, and
 * lstat resolves intermediate symlinks — so a symlink whose target already
 * contains a matching subdirectory is reported as a plain directory and the
 * symlink component itself is never inspected. Walking every lexical ancestor
 * instead is not an option: system symlinks (macOS /tmp -> /private/tmp,
 * /var -> /private/var) sit above every temp path and would false-positive.
 * Full protection needs a caller-known boundary, which is exactly what
 * vetOutputBase() provides — see the contract note on resolvePathWithinBase.
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
 *
 * CONTRACT (#2344): the base's own ancestry can only be best-effort vetted
 * here — a symlink whose target pre-contains matching subdirectories is not
 * detectable without a caller-known boundary (see nearestExistingAncestorStats
 * for why walking every ancestor false-positives on system symlinks). Do NOT
 * pass user-controlled base paths directly to this function: vet them first
 * with vetOutputBase(), which contains them canonically against an anchor and
 * returns the canonical base to use here. Every current caller does this.
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

/** True when a base-relative path points outside the base. */
function escapesBase(relativePath: string): boolean {
  return relativePath === '..'
    || relativePath.startsWith('..' + path.sep)
    || path.isAbsolute(relativePath);
}

/**
 * Canonical (realpath) form of a path that may not fully exist yet: the
 * deepest existing ancestor is resolved through every symlink, and the
 * not-yet-created suffix is appended unchanged. This answers "where would a
 * recursive mkdir/write on this path REALLY land?" — which per-component
 * lstat checks cannot, because lstat resolves intermediate symlinks and only
 * reports on the final component (#2344).
 */
export function canonicalizePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const canonical = fs.realpathSync(current);
      return missing.length ? path.join(canonical, ...missing) : canonical;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Nothing on the chain exists (should not happen for absolute paths —
      // the root exists — but keep a lexical fallback rather than throwing).
      return missing.length ? path.join(current, ...missing) : current;
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Vets a user-supplied output base for CLI writes and returns the canonical
 * path all subsequent writes should use (#2344).
 *
 * Two regimes, split by what the user lexically named:
 *
 *  - Base inside the anchor (relative outputs like the './anthropic-skills'
 *    default): the canonical base must stay inside the canonical anchor.
 *    A symlink that redirects it elsewhere — including one whose target
 *    already contains matching subdirectories, the case per-component lstat
 *    checks miss — is rejected. Comparing in canonical space means system
 *    links above the anchor (macOS /tmp -> /private/tmp) never false-positive.
 *
 *  - Base outside the anchor (explicit absolute or ../ outputs): the user
 *    named that destination, so there is no boundary to defend. Instead of
 *    guessing intent, the real destination is disclosed via `onDisclose`
 *    whenever it differs from the lexical path, and the canonical path is
 *    returned so what was vetted is what gets written.
 */
export function vetOutputBase(
  baseDir: string,
  options?: { anchor?: string; onDisclose?: (canonicalBase: string) => void },
): string {
  if (!baseDir || typeof baseDir !== 'string') {
    throw new TypeError('Base directory must be a non-empty string');
  }
  if (baseDir.includes('\0')) {
    throw new Error('Path segment contains a null byte');
  }

  const resolvedAnchor = path.resolve(options?.anchor ?? process.cwd());
  const resolvedBase = path.resolve(baseDir);
  const canonicalBase = canonicalizePath(resolvedBase);

  if (!escapesBase(path.relative(resolvedAnchor, resolvedBase))) {
    const canonicalAnchor = canonicalizePath(resolvedAnchor);
    if (escapesBase(path.relative(canonicalAnchor, canonicalBase))) {
      throw new Error(
        `Output path resolves outside the working directory through a symbolic link (real destination: ${canonicalBase})`,
      );
    }
    return canonicalBase;
  }

  if (canonicalBase !== resolvedBase) {
    options?.onDisclose?.(canonicalBase);
  }
  return canonicalBase;
}
