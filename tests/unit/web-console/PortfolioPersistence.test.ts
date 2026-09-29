import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { CONSOLE_PORTFOLIO_ELEMENT_TYPES, PortfolioElementVersionConflictError } from '../../../src/web-console/stores/IPortfolioElementStore.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-09-28T00:00:00Z');
const directories: string[] = [];
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const manager of disposables.splice(0)) manager.dispose();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-persistence-'));
  directories.push(directory);
  const suite = createRealManagerSuite(directory);
  const managers = { personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
    agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager };
  disposables.push(...Object.values(managers));
  return { directory, managers, store: new ManagerBackedPortfolioElementStore({ managers, getCurrentUserId: () => USER_ID }) };
}

describe.each(CONSOLE_PORTFOLIO_ELEMENT_TYPES)('portfolio persistence: %s', type => {
  const input = { userId: USER_ID, type, name: 'persistence-example', displayName: 'persistence-example',
    metadata: { description: 'Persistence example', goal: 'Assist carefully', elements: [], instructions: 'Apply careful review.' },
    tags: ['original'], content: 'Original reference body', now: NOW };

  it('honors exclusive create when another writer wins after the existence check', async () => {
    const { store, managers } = fixture();
    const manager = managers[type];
    const original = manager.save.bind(manager);
    jest.spyOn(manager, 'save').mockImplementationOnce(async (...args) => {
      await store.create({ ...input, tags: ['winner'] });
      return original(...args);
    });
    await expect(store.create(input)).rejects.toThrow(/already exists/i);
    expect((await store.findByName(USER_ID, type, input.name))?.tags).toEqual(['winner']);
  });

});

it('preserves a skill reference body through console import and save', async () => {
  const { store } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'reference-example', displayName: null,
    metadata: { description: 'Reference example', instructions: 'Review carefully.' }, content: 'My original reference', tags: [], now: NOW });
  expect(created.content.trim()).toBe('My original reference');
  const updated = await store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'My edited reference', now: NOW });
  expect(updated?.content.trim()).toBe('My edited reference');
  expect((await store.findByName(USER_ID, 'skills', created.canonicalName))?.content.trim()).toBe('My edited reference');
});

it.each([''])('preserves a v2 skill body with instructions=%s', async instructions => {
  const { store, managers } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'body-only', displayName: null,
    metadata: { description: 'Body-only skill', format_version: 'v2', instructions },
    content: 'Reference without directives', tags: [], now: NOW });
  expect(created.content.trim()).toBe('Reference without directives');
  managers.skills.clearCache();
  const loaded = await managers.skills.load('body-only.md');
  expect(loaded.content.trim()).toBe('Reference without directives');
  expect(loaded.instructions).toBe('');
});


it('promotes a legacy v2 skill body when instructions are absent', async () => {
  const { directory, managers, store } = fixture();
  fs.mkdirSync(path.join(directory, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'skills', 'legacy-v2.md'),
    '---\nname: legacy-v2\ndescription: Legacy v2 skill\nformat_version: v2\n---\n\nReview this request carefully.');
  const loaded = await managers.skills.load('legacy-v2.md');
  expect(loaded.instructions.trim()).toBe('Review this request carefully.');
  expect((await store.findByName(USER_ID, 'skills', 'legacy-v2'))?.validationStatus).toBe('valid');
});


it('preserves projection hash preconditions for skill updates and deletes', async () => {
  const { store } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'hash-guard', displayName: null,
    metadata: { description: 'Hash guard', instructions: 'Review carefully.' }, content: 'Original reference', tags: [], now: NOW });
  const updated = await store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Edited reference', now: NOW });
  expect(updated?.contentHash).not.toBe(created.contentHash);
  expect(await store.findByName(USER_ID, 'skills', created.canonicalName)).toEqual(updated);
  await expect(store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Stale edit', now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
  await expect(store.delete({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
  expect(await store.findByName(USER_ID, 'skills', created.canonicalName)).toEqual(updated);
  await expect(store.delete({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: updated!.contentHash, now: NOW })).resolves.toBeTruthy();
});

it('does not recreate a skill deleted after lookup and before the locked save', async () => {
  const { store, managers, directory } = fixture();
  const created = await store.create({ userId: USER_ID, type: 'skills', name: 'deleted-skill', displayName: null,
    metadata: { description: 'Deleted skill', instructions: 'Review carefully.' }, content: 'Original reference', tags: [], now: NOW });
  const save = managers.skills.save.bind(managers.skills);
  jest.spyOn(managers.skills, 'save').mockImplementationOnce(async (...args) => {
    expect(args[2]).toEqual({ updateOnly: true });
    await managers.skills.delete(args[1]);
    return save(...args);
  });
  await expect(store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Edited reference', now: NOW })).resolves.toBeNull();
  expect(fs.existsSync(path.join(directory, 'skills', 'deleted-skill.md'))).toBe(false);
  expect(await store.findByName(USER_ID, 'skills', created.canonicalName)).toBeNull();
});

it('pins the known file-mode limit: a stale update overwrites same-path recreation without inserting another skill', async () => {
  const { store, managers, directory } = fixture();
  const input = { userId: USER_ID, type: 'skills' as const, name: 'recreated-skill', displayName: null,
    metadata: { description: 'Recreated skill', instructions: 'Review carefully.' },
    content: 'Original reference', tags: [], now: NOW };
  const created = await store.create(input);
  const save = managers.skills.save.bind(managers.skills);
  jest.spyOn(managers.skills, 'save').mockImplementationOnce(async (...args) => {
    await managers.skills.delete(args[1]);
    await store.create({ ...input, content: 'Replacement reference' });
    expect(fs.readFileSync(path.join(directory, 'skills', args[1]), 'utf8')).toContain('Replacement reference');
    return save(...args);
  });
  const updated = await store.update({ userId: USER_ID, type: 'skills', canonicalName: created.canonicalName,
    expectedVersion: 1, expectedContentHash: created.contentHash, content: 'Stale update', now: NOW });
  expect(updated?.content.trim()).toBe('Stale update');
  expect(fs.readdirSync(path.join(directory, 'skills')).filter(file => file.endsWith('.md'))).toEqual(['recreated-skill.md']);
  const raw = fs.readFileSync(path.join(directory, 'skills', 'recreated-skill.md'), 'utf8');
  expect(raw).toContain('Stale update');
  expect(raw).not.toContain('Replacement reference');
  expect(await store.listByUser(USER_ID, { type: 'skills' })).toHaveLength(1);
});
