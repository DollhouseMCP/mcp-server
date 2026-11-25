import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileDiscoveryUtil } from '../../../src/utils/FileDiscoveryUtil.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';

describe('FileDiscoveryUtil.findFiles failure classification', () => {
  let root: string;

  beforeEach(async () => {
    FileDiscoveryUtil.clearCache();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'file-discovery-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds a matching file in a readable directory', async () => {
    await fs.writeFile(path.join(root, 'test-content.md'), 'x');
    await expect(FileDiscoveryUtil.findFile(root, 'test-content')).resolves.toBe(path.join(root, 'test-content.md'));
  });

  it('answers no matches for a directory that is missing or is not a directory', async () => {
    const file = path.join(root, 'plain.md');
    await fs.writeFile(file, 'x');
    await expect(FileDiscoveryUtil.findFiles(path.join(root, 'missing'), 'anything')).resolves.toEqual([]);
    await expect(FileDiscoveryUtil.findFiles(path.join(file, 'child'), 'anything')).resolves.toEqual([]);
  });

  it('propagates every other listing failure instead of answering no matches', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    jest.spyOn(FileOperationsService.prototype, 'listDirectory').mockRejectedValue(denied);
    await expect(FileDiscoveryUtil.findFiles(root, 'anything')).rejects.toBe(denied);
    await expect(FileDiscoveryUtil.findFile(root, 'anything')).rejects.toBe(denied);
  });
});
