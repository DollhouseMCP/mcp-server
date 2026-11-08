/**
 * The layer's own save of one record while a collection scan runs is a change concurrent with the
 * read, like a signalled invalidation: it stays pending for the next read and never revokes the
 * authority of the scan for any other reference.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const skill = (name: string, body = 'Follow these detailed instructions.') => `---\nname: ${name}\ndescription: fixture\n---\n${body}`;

describe('sibling saves during a collection scan', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'sibling-save-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'alpha.md'), skill('Alpha'));
    await writeFile(path.join(dir, 'beta.md'), skill('Beta'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it.each([1, 2, 3])('loads and finds a healthy element while %i sibling saves land during the scans', async saves => {
    const manager = suite.skillManager;
    const layer = (manager as any).storageLayer;
    await manager.listReport();
    manager.clearCache();
    layer.invalidate();
    const backend = layer.backend;
    const statMany = backend.statMany.bind(backend);
    let saved = 0;
    jest.spyOn(backend, 'statMany').mockImplementation(async (directory: string, paths: string[]) => {
      const observed = await statMany(directory, paths);
      // The process saves beta.md after the scan's stat and before its publication.
      if (saved < saves) {
        saved += 1;
        const file = path.join(dir, 'beta.md');
        await writeFile(file, skill('Beta', `Changed body ${saved} with detailed instructions.`));
        await layer.notifySaved('beta.md', file);
      }
      return observed;
    });

    expect((await manager.load('alpha.md')).metadata.name).toBe('Alpha');
    expect((await manager.findByName('Alpha'))?.metadata.name).toBe('Alpha');
    expect(saved).toBeGreaterThan(0);
    jest.mocked(backend.statMany).mockRestore();
    // The saved sibling itself settles on the next read.
    expect((await manager.findByName('Beta'))?.metadata.name).toBe('Beta');
  });
});
