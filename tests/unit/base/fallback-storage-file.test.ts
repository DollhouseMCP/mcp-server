/**
 * A name with no filename characters is stored under the fallback identity (unnamed.md). That
 * file answers only its own name, or its own stem; any other text that merely derives the same
 * fallback file never selects, deletes, activates or updates it.
 */
import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const skill = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\nFollow these detailed instructions.`;

describe('fallback storage file selection', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'fallback-storage-file-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it('never selects, deletes, activates or updates 日本語 for another name that derives its file', async () => {
    const manager = suite.skillManager;
    expect(manager.getElementFilename('日本語')).toBe('unnamed.md');
    await writeFile(path.join(dir, 'unnamed.md'), skill('日本語'));

    for (const other of ['中文', '???', '---']) {
      await expect(manager.findByName(other)).resolves.toBeUndefined();
      await expect(manager.findForUpdate(other)).resolves.toBeUndefined();
      expect((await manager.activateSkill(other)).success).toBe(false);
    }
    await expect(manager.delete('中文')).rejects.toMatchObject({ name: 'ElementMissingError', kind: 'absent' });
    await expect(access(path.join(dir, 'unnamed.md'))).resolves.toBeUndefined();
    expect((await manager.findByName('日本語'))?.metadata.name).toBe('日本語');
  });

  it('keeps a separator-only name addressable by its own name and by its file stem', async () => {
    const manager = suite.skillManager;
    await writeFile(path.join(dir, 'unnamed.md'), skill("'---'"));
    expect((await manager.findByName('---'))?.metadata.name).toBe('---');
    expect((await manager.findByName('unnamed'))?.metadata.name).toBe('---');
    expect((await manager.findForUpdate('unnamed'))?.element.metadata.name).toBe('---');
  });
});
