/**
 * macOS-shaped filesystem semantics for pathSecurity.
 *
 * macOS uses POSIX path arithmetic, but system symlinks and Unicode-normalizing
 * filesystems create behavior Linux-only tests do not expose. The suite builds
 * a private /tmp -> /private/tmp-shaped symlink tree and accepts either valid
 * NFC/NFD filesystem behavior by checking file identity rather than assuming
 * byte-distinct names.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  canonicalizePath,
  resolvePathWithinBase,
  vetOutputBase,
} from '../../../src/utils/pathSecurity.js';

const describePosixFilesystem = process.platform === 'win32' ? describe.skip : describe;

describePosixFilesystem('pathSecurity under macOS-shaped filesystem semantics', () => {
  let root: string;
  let realRoot: string;
  let linkedRoot: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'dh-darwin-'));
    realRoot = path.join(root, 'private', 'workspace');
    mkdirSync(realRoot, { recursive: true });
    linkedRoot = path.join(root, 'workspace');
    symlinkSync(realRoot, linkedRoot, 'dir');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('symlinked ancestor: the /tmp -> /private/tmp shape', () => {
    it('canonicalizes an existing path through the symlinked ancestor', () => {
      const nested = path.join(realRoot, 'elements');
      mkdirSync(nested, { recursive: true });
      const viaLink = path.join(linkedRoot, 'elements');

      expect(canonicalizePath(viaLink)).toBe(nested);
      expect(canonicalizePath(viaLink)).not.toBe(viaLink);
    });

    it('canonicalizes a not-yet-created suffix through the symlinked ancestor', () => {
      const viaLink = path.join(linkedRoot, 'not-created-yet', 'file.md');

      expect(existsSync(viaLink)).toBe(false);
      expect(canonicalizePath(viaLink)).toBe(path.join(realRoot, 'not-created-yet', 'file.md'));
    });

    it('accepts a real base reached through a symlinked ancestor', () => {
      const base = path.join(linkedRoot, 'portfolio');
      mkdirSync(path.join(realRoot, 'portfolio'), { recursive: true });

      expect(resolvePathWithinBase(base, 'personas', 'creative.md'))
        .toBe(path.join(base, 'personas', 'creative.md'));
    });

    it('rejects a base that is itself a symlink', () => {
      expect(() => resolvePathWithinBase(linkedRoot, 'personas'))
        .toThrow('Base directory resolves through a symbolic link');
    });

    it('rejects traversal out of a base reached through a symlinked ancestor', () => {
      const base = path.join(linkedRoot, 'portfolio');

      expect(() => resolvePathWithinBase(base, '..', '..', 'escaped.md'))
        .toThrow('Resolved path escapes the base directory');
    });
  });

  describe('vetOutputBase with system symlinks above the anchor', () => {
    it('accepts a base inside an anchor reached through a symlink', () => {
      const anchor = path.join(linkedRoot, 'anchor');
      mkdirSync(path.join(realRoot, 'anchor', 'out'), { recursive: true });

      expect(vetOutputBase(path.join(anchor, 'out'), { anchor }))
        .toBe(path.join(realRoot, 'anchor', 'out'));
    });

    it('rejects a lexically contained base symlinked outside the anchor', () => {
      const anchor = path.join(realRoot, 'anchor2');
      const outside = path.join(root, 'elsewhere');
      mkdirSync(anchor, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, path.join(anchor, 'escape'), 'dir');

      expect(() => vetOutputBase(path.join(anchor, 'escape'), { anchor }))
        .toThrow(/resolves outside the working directory through a symbolic link/);
    });

    it('discloses the canonical destination for an explicit outside-anchor base', () => {
      const anchor = path.join(realRoot, 'anchor3');
      mkdirSync(anchor, { recursive: true });
      const disclosed: string[] = [];

      expect(vetOutputBase(path.join(linkedRoot, 'elements'), {
        anchor,
        onDisclose: canonical => disclosed.push(canonical),
      })).toBe(path.join(realRoot, 'elements'));
      expect(disclosed).toEqual([path.join(realRoot, 'elements')]);
    });
  });

  describe('Unicode filename normalization', () => {
    const NFC = 'caf\u00e9.md';
    const NFD = 'cafe\u0301.md';

    it('contains both spellings without rewriting the requested segment', () => {
      const base = path.join(realRoot, 'unicode');
      mkdirSync(base, { recursive: true });

      expect(resolvePathWithinBase(base, NFC)).toBe(path.join(base, NFC));
      expect(resolvePathWithinBase(base, NFD)).toBe(path.join(base, NFD));
    });

    it('handles both distinct-name and normalization-coalescing filesystems', () => {
      const base = path.join(realRoot, 'unicode-files');
      mkdirSync(base, { recursive: true });
      const nfcPath = resolvePathWithinBase(base, NFC);
      const nfdPath = resolvePathWithinBase(base, NFD);

      writeFileSync(nfcPath, 'composed');
      writeFileSync(nfdPath, 'decomposed');

      const nfcStats = statSync(nfcPath);
      const nfdStats = statSync(nfdPath);
      const sameFile = nfcStats.dev === nfdStats.dev && nfcStats.ino === nfdStats.ino;
      if (sameFile) {
        expect(readFileSync(nfcPath, 'utf8')).toBe('decomposed');
        expect(readFileSync(nfdPath, 'utf8')).toBe('decomposed');
      } else {
        expect(readFileSync(nfcPath, 'utf8')).toBe('composed');
        expect(readFileSync(nfdPath, 'utf8')).toBe('decomposed');
      }
    });

    it('canonicalizes to the same file identity when the filesystem coalesces spellings', () => {
      const base = path.join(realRoot, 'unicode-canon');
      mkdirSync(base, { recursive: true });
      const nfcPath = path.join(base, NFC);
      const nfdPath = path.join(base, NFD);
      writeFileSync(nfcPath, 'x');

      const canonicalNfc = canonicalizePath(nfcPath);
      expect(readFileSync(canonicalNfc, 'utf8')).toBe('x');
      const canonicalNfd = canonicalizePath(nfdPath);
      if (existsSync(nfdPath)) {
        const nfcStats = statSync(canonicalNfc);
        const nfdStats = statSync(canonicalNfd);
        expect({ dev: nfdStats.dev, ino: nfdStats.ino })
          .toEqual({ dev: nfcStats.dev, ino: nfcStats.ino });
      } else {
        expect(canonicalNfd).toBe(nfdPath);
      }
    });
  });
});
