/** Partial and fuzzy names stay removed on the file backend (the database runs the same cases in element-read-contract). */
import { describe, it } from '@jest/globals';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { expectPartialNamesRefused } from '../../helpers/partialNameCases.js';

describe('partial names on the file backend', () => {
  it('refuses a substring of a stored name for details, edit, delete and template activate; the slug resolves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'partial-names-'));
    const suite = createRealManagerSuite(root);
    try {
      for (const type of ['skills', 'templates']) await mkdir(path.join(root, type), { recursive: true });
      await expectPartialNamesRefused(suite);
    } finally {
      await Promise.all([suite.skillManager.dispose(), suite.templateManager.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
