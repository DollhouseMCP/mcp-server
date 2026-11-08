/**
 * Every entry that loads an agent by its resolved storage reference follows one rule (the loader's
 * cached-instance rule): on files a cached agent is served only while the file is unchanged, so
 * read(name) and findByStorageIdentity answer alike after another process edits the file.
 */
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../../helpers/di-mocks.js';

describe('agent reads by storage reference', () => {
  it('answers read(name) and findByStorageIdentity alike after an external edit, in either order (I4)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-reference-reads-'));
    const suite = createRealManagerSuite(root);
    const agents = suite.agentManager;
    try {
      const dir = (agents as any)['elementDir'];
      await mkdir(dir, { recursive: true });
      await agents.create('gate-agent', 'Original description', 'Follow these detailed agent instructions.', {} as never);
      await agents.list();
      const file = path.join(dir, 'gate-agent.md');
      await writeFile(file, (await readFile(file, 'utf8')).replace('Original description', 'Edited description, longer'));
      await utimes(file, new Date(), new Date(Date.now() + 5_000));
      expect((await agents.read('gate-agent'))?.metadata.description).toBe('Edited description, longer');
      expect((await agents.findByStorageIdentity('gate-agent.md'))?.metadata.description).toBe('Edited description, longer');
      expect((await agents.read('gate-agent'))?.metadata.description).toBe('Edited description, longer');
    } finally {
      await Promise.all([agents.dispose(), suite.skillManager.dispose(), suite.memoryManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
