/**
 * Unit tests for PackageResourceLocator.
 *
 * The locator resolves paths relative to its own module location. These
 * tests exercise the resolution logic by constructing locators with
 * synthetic `import.meta.url` values representing both dist and src
 * layouts, verifying the tree root detection and alternate-tree fallback.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';

/**
 * Build a fake `import.meta.url` as if the locator's source file lived
 * at `<pkgRoot>/<tree>/paths/PackageResourceLocator.<ext>`.
 */
function fakeModuleUrl(pkgRoot: string, tree: 'src' | 'dist', ext: 'ts' | 'js'): string {
  const filePath = path.join(pkgRoot, tree, 'paths', `PackageResourceLocator.${ext}`);
  return pathToFileURL(filePath).href;
}

describe('PackageResourceLocator', () => {
  describe('constructor and tree root detection', () => {
    it('detects tree root when loaded from dist', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(locator.getTreeRoot()).toBe('/opt/pkg/dist');
    });

    it('detects tree root when loaded from src (dev mode)', () => {
      const url = fakeModuleUrl('/opt/pkg', 'src', 'ts');
      const locator = new PackageResourceLocator(url);
      expect(locator.getTreeRoot()).toBe('/opt/pkg/src');
    });

    it('uses import.meta.url by default', () => {
      const locator = new PackageResourceLocator();
      // Live resolution — tree should be either this repo's src or dist.
      const treeRoot = locator.getTreeRoot();
      expect(path.basename(treeRoot)).toMatch(/^(src|dist)$/);
    });

    it('strips trailing separator from tree root (Windows drive-root safety)', () => {
      // Pathological case: package installed at filesystem root so the
      // double-dirname walk returns `/`. The containment check would
      // then build `//` and reject every subpath as an escape. The
      // constructor must normalize the trailing separator.
      const url = pathToFileURL('/paths/PackageResourceLocator.js').href;
      const locator = new PackageResourceLocator(url);
      // Tree root should be the filesystem root with no trailing slash
      // beyond the base (POSIX root is '/'; we accept that).
      const treeRoot = locator.getTreeRoot();
      expect(treeRoot === '/' || !treeRoot.endsWith('/')).toBe(true);
      // Containment check still works for a normal subpath.
      expect(locator.resolve('foo.txt')).toBe('/foo.txt');
    });
  });

  describe('getPackageRoot', () => {
    it('returns the parent of the tree root', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(locator.getPackageRoot()).toBe('/opt/pkg');
    });
  });

  describe('resolve (sync, no disk check)', () => {
    it('joins a relative path against the tree root (dist case)', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(locator.resolve('seed-elements/memories/foo.yaml'))
        .toBe('/opt/pkg/dist/seed-elements/memories/foo.yaml');
    });

    it('joins a relative path against the tree root (src case)', () => {
      const url = fakeModuleUrl('/opt/pkg', 'src', 'ts');
      const locator = new PackageResourceLocator(url);
      expect(locator.resolve('seed-elements/memories/foo.yaml'))
        .toBe('/opt/pkg/src/seed-elements/memories/foo.yaml');
    });

    it('rejects paths that escape the tree root via .. segments', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(() => locator.resolve('../../../etc/passwd')).toThrow(/escapes tree root/);
      expect(() => locator.resolve('some/path/../../../escape')).toThrow(/escapes tree root/);
    });

    it('rejects absolute paths', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(() => locator.resolve('/etc/passwd')).toThrow(/absolute path/);
    });

    it('rejects empty string and "." (must name a resource, not the tree root)', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(() => locator.resolve('')).toThrow(/tree root/);
      expect(() => locator.resolve('.')).toThrow(/tree root/);
    });

    it('rejects paths that normalize to the tree root itself', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      expect(() => locator.resolve('foo/..')).toThrow(/escapes tree root/);
    });

    it('accepts paths with interior .. that stay inside the tree', () => {
      const url = fakeModuleUrl('/opt/pkg', 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      // seed-elements/../seed-elements → seed-elements, stays inside dist
      expect(locator.resolve('seed-elements/../seed-elements/foo.yaml'))
        .toBe('/opt/pkg/dist/seed-elements/foo.yaml');
    });
  });

  describe('locate (async, disk check + alternate-tree fallback)', () => {
    let tmpDir: string;

    beforeAll(async () => {
      // Build a pretend package layout under a temp dir:
      //   <tmp>/pkg/dist/seed-elements/foo.yaml    (dist has the file)
      //   <tmp>/pkg/src/seed-elements/               (src is empty — fallback test)
      //   <tmp>/pkg/src/other-resource.txt           (src-only file — reverse fallback test)
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'package-resource-locator-test-'));
      const pkg = path.join(tmpDir, 'pkg');
      await fs.mkdir(path.join(pkg, 'dist', 'seed-elements'), { recursive: true });
      await fs.writeFile(path.join(pkg, 'dist', 'seed-elements', 'foo.yaml'), 'content');
      await fs.mkdir(path.join(pkg, 'src'), { recursive: true });
      await fs.writeFile(path.join(pkg, 'src', 'other-resource.txt'), 'content');
    });

    afterAll(async () => {
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns the primary path when the resource exists in the current tree', async () => {
      const pkg = path.join(tmpDir, 'pkg');
      const url = fakeModuleUrl(pkg, 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('seed-elements/foo.yaml');
      expect(found).toBe(path.join(pkg, 'dist', 'seed-elements', 'foo.yaml'));
    });

    it('falls back to src tree when dist tree does not have the resource', async () => {
      const pkg = path.join(tmpDir, 'pkg');
      // Locator thinks it is in dist, but file is only in src.
      const url = fakeModuleUrl(pkg, 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('other-resource.txt');
      expect(found).toBe(path.join(pkg, 'src', 'other-resource.txt'));
    });

    it('falls back to dist tree when src tree does not have the resource', async () => {
      const pkg = path.join(tmpDir, 'pkg');
      // Locator thinks it is in src, but file is only in dist.
      const url = fakeModuleUrl(pkg, 'src', 'ts');
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('seed-elements/foo.yaml');
      expect(found).toBe(path.join(pkg, 'dist', 'seed-elements', 'foo.yaml'));
    });

    it('returns null when the resource is in neither tree', async () => {
      const pkg = path.join(tmpDir, 'pkg');
      const url = fakeModuleUrl(pkg, 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('nonexistent-resource.yaml');
      expect(found).toBeNull();
    });

    it('returns null when tree root has no src/dist sibling to fall back to', async () => {
      // Unusual layout: tree root is 'lib' (not 'src' or 'dist'), no sibling.
      const pkg = path.join(tmpDir, 'pkg-weird');
      await fs.mkdir(path.join(pkg, 'lib', 'paths'), { recursive: true });
      const url = pathToFileURL(path.join(pkg, 'lib', 'paths', 'PackageResourceLocator.js')).href;
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('anything');
      expect(found).toBeNull();
    });

    it('returns null when a symlink inside the tree points outside', async () => {
      // Build a package layout with a symlink in dist/ pointing to an
      // external file. The containment check after realpath must reject.
      const pkg = path.join(tmpDir, 'symlink-pkg');
      await fs.mkdir(path.join(pkg, 'dist'), { recursive: true });
      // External file outside the tree
      const outside = path.join(tmpDir, 'outside-secret.txt');
      await fs.writeFile(outside, 'secret');
      // Symlink inside the tree pointing at the external file
      const linkPath = path.join(pkg, 'dist', 'leaked.txt');
      try {
        await fs.symlink(outside, linkPath);
      } catch {
        // Some filesystems (e.g. non-root on certain Windows configs)
        // don't allow symlink creation — skip the test rather than
        // fail. This is an additive defense-in-depth check; if it
        // can't run here, the test suite doesn't lose coverage on
        // supported platforms.
        return;
      }
      const url = fakeModuleUrl(pkg, 'dist', 'js');
      const locator = new PackageResourceLocator(url);
      const found = await locator.locate('leaked.txt');
      expect(found).toBeNull();
    });
  });
});
