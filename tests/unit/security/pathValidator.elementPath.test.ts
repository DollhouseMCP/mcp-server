import { describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { PathValidator, pathRefusalDetail } from '../../../src/security/pathValidator.js';
import { logger } from '../../../src/utils/logger.js';

describe('PathValidator stored element paths', () => {
  it('distinguishes an absent reference from a present symlink with an absent target', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'dangling-element-path-'));
    try {
      const missing = path.join(root, 'missing.md');
      const link = path.join(root, 'present.md');
      await fs.symlink(missing, link);
      await expect(PathValidator.validateElementPathOnly(missing, root)).resolves.toBeUndefined();
      await expect(PathValidator.validateElementPathOnly(link, root)).rejects.toMatchObject({
        code: 'EIO', cause: expect.objectContaining({ code: 'ENOENT' }),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports the symlink escape before the filename rules, and carries the detail on the error', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'element-path-'));
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'element-path-outside-'));
    try {
      const target = path.join(outside, 'target.bin');
      await fs.writeFile(target, 'outside');
      const link = path.join(root, 'escape.bin');
      await fs.symlink(target, link);
      const errors = jest.spyOn(logger, 'error').mockImplementation(() => {});
      try {
        // The target leaves the directory AND the extension is refused: the escape is what gets reported.
        const refused = await PathValidator.validateElementPathOnly(link, root, { quiet: true }).catch((error: unknown) => error);
        expect(refused).toMatchObject({ message: 'Path access denied' });
        expect(pathRefusalDetail(refused)).toEqual({ path: link, realPath: await fs.realpath(target), allowedDir: path.normalize(root) });
        expect(errors).not.toHaveBeenCalled();
        // The caller-syntax check has no storage state to consult and refuses the extension.
        expect(() => PathValidator.validateElementReference(link, root, { quiet: true })).toThrow(/extension|Invalid/i);
        const dotted = `${root}${path.sep}..${path.sep}x.md`;
        const traversal = (() => { try { PathValidator.validateElementReference(dotted, root, { quiet: true }); } catch (error) { return error; } })();
        expect(pathRefusalDetail(traversal)).toEqual({ path: dotted });
        expect(pathRefusalDetail(new Error('plain'))).toBeUndefined();
      } finally {
        errors.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a reference containing a NUL instead of validating the reference without it', () => {
    const root = path.resolve('nul-root');
    const withNul = path.join(root, 'foo\0.md');
    const refused = (() => { try { PathValidator.validateElementReference(withNul, root, { quiet: true }); } catch (error) { return error; } })();
    expect(refused).toMatchObject({ message: 'Null bytes are not allowed in a path' });
    expect(pathRefusalDetail(refused)).toEqual({ path: withNul });
    expect(PathValidator.validateElementReference(path.join(root, 'foo.md'), root, { quiet: true })).toBe(path.join(root, 'foo.md'));
  });
});
