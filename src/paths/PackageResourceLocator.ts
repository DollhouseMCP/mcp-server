/**
 * PackageResourceLocator — locates resources shipped with the installed
 * DollhouseMCP package.
 *
 * Package-internal resources (seed elements, bundled defaults, static
 * assets, helper scripts, `package.json`) live inside the installed
 * npm package. Eight call sites across the server compute their own
 * `fileURLToPath(import.meta.url)` + ad-hoc relative traversal to find
 * these resources — this class replaces that pattern with one place
 * that knows the tree layout.
 *
 * Resolution strategy: the locator's own source file lives at
 * `src/paths/PackageResourceLocator.ts` (or `dist/paths/PackageResourceLocator.js`
 * when built). It walks up from its own `import.meta.url` to find the
 * tree root (`src/` or `dist/`) and resolves resources relative to
 * that. Optional alternate-tree fallback handles dev configurations
 * where `dist/` assets haven't been built.
 *
 * @since Step 4.5
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class PackageResourceLocator {
  /** The directory containing this module's tree (either `.../src` or `.../dist`). */
  private readonly treeRoot: string;

  /** Cached realpath of the tree root, populated lazily by `locate()`. */
  private realTreeRootCache: Promise<string | null> | null = null;

  /**
   * @param moduleUrl `import.meta.url` of this class's source. Defaults to
   *                   the built-in value. Override only for tests.
   */
  constructor(moduleUrl: string = import.meta.url) {
    // Module path is <tree>/paths/PackageResourceLocator.{ts,js}.
    // Two dirname() calls walk up to <tree>. On filesystem roots
    // (POSIX `/`, Windows `C:\`) dirname returns the root with a
    // trailing separator — the containment check below handles this
    // rather than stripping the separator (stripping would produce
    // an empty string).
    this.treeRoot = path.dirname(path.dirname(fileURLToPath(moduleUrl)));
  }

  /** Prefix used for containment comparison — deduplicates trailing separator. */
  private get containmentPrefix(): string {
    return this.treeRoot.endsWith(path.sep) ? this.treeRoot : this.treeRoot + path.sep;
  }

  /** Lazy realpath of the tree root. Cached for the locator's lifetime. */
  private async realTreeRoot(): Promise<string | null> {
    if (this.realTreeRootCache === null) {
      this.realTreeRootCache = (async () => {
        try { return await fs.realpath(this.treeRoot); }
        catch { return null; }
      })();
    }
    return this.realTreeRootCache;
  }

  /**
   * Resolve a resource path relative to the tree root. Pure — does not
   * check the filesystem. Callers that need disk verification should
   * use `locate()` instead.
   *
   * The returned path is constrained to the tree root — `..` segments
   * that would escape the package are rejected. Absolute `relativePath`
   * values are rejected. Prevents a caller from accidentally forwarding
   * user input and escaping the package sandbox.
   *
   * @param relativePath path from the tree root (e.g. `seed-elements/memories/foo.yaml`)
   * @throws if `relativePath` is absolute or escapes the tree root
   */
  resolve(relativePath: string): string {
    if (relativePath === '' || relativePath === '.') {
      throw new Error('PackageResourceLocator: relativePath must identify a resource, not the tree root');
    }
    if (path.isAbsolute(relativePath)) {
      throw new Error(`PackageResourceLocator: absolute path rejected: ${relativePath}`);
    }
    const joined = path.resolve(this.treeRoot, relativePath);
    if (joined === this.treeRoot || !joined.startsWith(this.containmentPrefix)) {
      throw new Error(`PackageResourceLocator: path escapes tree root: ${relativePath}`);
    }
    return joined;
  }

  /**
   * Resolve a resource path, verifying it exists on disk. Falls back to
   * the alternate tree (src ↔ dist) when the primary location is
   * missing — covers dev configurations where `dist/` hasn't been
   * built, and vice versa.
   *
   * **Symlink containment (caveats):** at resolution time, the
   * resource's `realpath` is verified to stay inside the tree root.
   * If a symlink inside the package tree points outside the tree,
   * this method returns `null`. **This is a best-effort check at the
   * moment of `locate()`, not a security boundary.** The returned
   * path is the *logical* path (not the realpath); a caller that
   * opens it is subject to TOCTOU — a symlink swapped between the
   * containment check and the open will serve the new target. Do not
   * treat `locate()` as a security decision; it reduces the attack
   * surface for the accidental/malicious-package-contents scenario,
   * but it does not neutralize symlinks in general.
   *
   * @param relativePath path from the tree root
   * @returns absolute path if found and contained at check time, otherwise `null`
   */
  async locate(relativePath: string): Promise<string | null> {
    const primary = this.resolve(relativePath);
    const primaryReal = await realpathIfExists(primary);
    if (primaryReal !== null) {
      const realRoot = await this.realTreeRoot();
      if (realRoot !== null && pathContainedBy(primaryReal, realRoot)) {
        return primary;
      }
    }
    const alternate = this.alternateTreePath(relativePath);
    if (alternate !== null) {
      const altReal = await realpathIfExists(alternate);
      const altRootString = this.alternateTreeRoot();
      if (altReal !== null && altRootString !== null) {
        const altRootReal = await realpathIfExists(altRootString);
        if (altRootReal !== null && pathContainedBy(altReal, altRootReal)) {
          return alternate;
        }
      }
    }
    return null;
  }

  private alternateTreeRoot(): string | null {
    const treeName = path.basename(this.treeRoot);
    const parent = path.dirname(this.treeRoot);
    if (treeName === 'dist') return path.join(parent, 'src');
    if (treeName === 'src') return path.join(parent, 'dist');
    return null;
  }

  /**
   * The installed package root — the directory one level above the
   * tree root. Where `package.json` lives.
   */
  getPackageRoot(): string {
    return path.dirname(this.treeRoot);
  }

  /** The tree root (`.../src` or `.../dist`). Exposed for tests. */
  getTreeRoot(): string {
    return this.treeRoot;
  }

  /**
   * Same-name relative path in the opposite tree (src ↔ dist), or
   * `null` if the current tree is neither, or if the joined path
   * escapes the sibling tree root.
   */
  private alternateTreePath(relativePath: string): string | null {
    const treeName = path.basename(this.treeRoot);
    const parent = path.dirname(this.treeRoot);
    let siblingRoot: string;
    if (treeName === 'dist') {
      siblingRoot = path.join(parent, 'src');
    } else if (treeName === 'src') {
      siblingRoot = path.join(parent, 'dist');
    } else {
      return null;
    }
    const joined = path.resolve(siblingRoot, relativePath);
    // Same containment guard the primary resolve() applies — `..`
    // segments that escape the sibling tree root are rejected.
    const prefix = siblingRoot.endsWith(path.sep) ? siblingRoot : siblingRoot + path.sep;
    if (joined === siblingRoot || !joined.startsWith(prefix)) {
      return null;
    }
    return joined;
  }
}

/**
 * Resolve `p` through any symlinks and return the real path. Returns
 * `null` if the path doesn't exist or cannot be traversed.
 */
async function realpathIfExists(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * True if `candidate` is `root` itself or a descendant of `root`. Both
 * must already be realpath-normalized by the caller — this function
 * does not do the `realpath` itself, so that callers can cache.
 */
function pathContainedBy(candidate: string, realRoot: string): boolean {
  if (candidate === realRoot) return true;
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return candidate.startsWith(prefix);
}
