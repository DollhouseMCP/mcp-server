import { jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealSkillManager, createRealEnsembleManager } from '../../helpers/di-mocks.js';
import { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { buildSkillContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);
afterEach(() => jest.restoreAllMocks());
describe.each(['skill', 'ensemble'] as const)('%s DB activation reporting', type => {
  it('observes edited, malformed and deleted definitions with a warm cache', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'activation-report-'));
    const envKey = `DOLLHOUSE_MAX_ACTIVE_${type.toUpperCase()}S`;
    const original = process.env[envKey];
    process.env[envKey] = '5';
    const user = fixedUserId(await ensureTestUser());
    const writer = new DatabaseStorageLayer(getTestDb(), user, `${type}s`);
    const manager = (type === 'skill' ? createRealSkillManager : createRealEnsembleManager)(dir,
      { storageLayerFactory: new DatabaseStorageLayerFactory(getTestDb(), user) });
    const activate = (name: string) => manager instanceof SkillManager ? manager.activateSkill(name) : manager.activateEnsemble(name);
    try {
      for (let i = 0; i < 5; i++) {
        const name = `report-${i}`;
        await writer.writeContent(`${type}s`, name, buildSkillContent(name), { author: '', version: '1.0.0', description: '', tags: [] });
      }
      for (let i = 0; i < 5; i++) expect((await activate(`report-${i}`)).success).toBe(true);
      const identity = manager['storageLayer'].getPathByName('report-0')!;
      const updateRaw = (rawContent: string) => withUserContext(getTestDb(), user(), tx =>
        tx.update(elements).set({ rawContent, updatedAt: new Date() }).where(eq(elements.id, identity)));
      await updateRaw(buildSkillContent('report-0', { description: 'Edited definition' }));
      const scan = jest.spyOn(manager['storageLayer'], 'scan');
      await activate('report-4');
      expect(scan).toHaveBeenCalledTimes(1);
      expect(manager['getCachedElementByStorageIdentity'](identity)?.metadata.description).toBe('Edited definition');
      await updateRaw('---\nname: [invalid\n---');
      expect((await activate('report-4')).message).toContain('reference "report-0" could not be loaded');
      await writer.deleteContent(`${type}s`, 'report-1');
      expect((await activate('report-4')).message).toContain('reference "report-1" could not be loaded');
    } finally {
      manager.dispose();
      if (original === undefined) delete process.env[envKey]; else process.env[envKey] = original;
      await rm(dir, { recursive: true, force: true });
      await cleanupAllTestData();
    }
  });
});
