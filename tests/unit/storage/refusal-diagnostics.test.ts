import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ElementStorageLayer } from '../../../src/storage/ElementStorageLayer.js';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
import { logger } from '../../../src/utils/logger.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';

describe('reference-refusal diagnostics', () => {
  const roots: string[] = [];
  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  async function layer() {
    const base = await fs.mkdtemp(path.join(tmpdir(), 'refusal-diagnostics-')); roots.push(base);
    const root = path.join(base, 'skills');
    await fs.mkdir(root);
    const ops = createTestFileOperationsService();
    return { base, root, layer: new ElementStorageLayer(ops, { elementDir: root, fileExtension: '.md', storageBackend: new FileStorageBackend(ops), scanCooldownMs: 0 }) };
  }

  it('stays bounded however many distinct caller references are refused', async () => {
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
    const { layer: storage } = await layer();
    for (let index = 0; index < 600; index++) {
      await expect(storage.readContent(path.join('..', `outside-${index}.md`))).rejects.toMatchObject({ name: 'ValidationError' });
    }
    expect((storage as any).refusalDetails.size).toBeLessThanOrEqual(512);
    expect((storage as any).reportedReadRefusals.size).toBeLessThanOrEqual(512);
  });

  it('reports a refusal at error level again once the path passed the policy in between', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
    const { base, root, layer: storage } = await layer();
    const target = path.join(base, 'outside.md');
    await fs.writeFile(target, '---\nname: outside\n---\nBody');
    const file = path.join(root, 'entry.md');
    await fs.symlink(target, file);
    await expect(storage.readContent('entry.md')).rejects.toMatchObject({ name: 'ValidationError' });
    await expect(storage.readContent('entry.md')).rejects.toMatchObject({ name: 'ValidationError' });
    expect(error).toHaveBeenCalledTimes(1);
    // Repaired: the path passes the policy, so its old refusal is forgotten.
    await fs.rm(file);
    await fs.writeFile(file, '---\nname: entry\n---\nBody');
    await expect(storage.readContent('entry.md')).resolves.toContain('name: entry');
    // A new escape is a new security signal, reported at error level again.
    await fs.rm(file);
    await fs.symlink(target, file);
    await expect(storage.readContent('entry.md')).rejects.toMatchObject({ name: 'ValidationError' });
    expect(error).toHaveBeenCalledTimes(2);
  });
});
