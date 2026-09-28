import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileStorageBackend } from '../../../src/storage/FileStorageBackend.js';
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'versioned-portfolio-'));
  directories.push(directory);
  const suite = createRealManagerSuite(directory);
  const managers = { personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
    agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager };
  disposables.push(...Object.values(managers));
  return { directory, managers, store: new ManagerBackedPortfolioElementStore({ managers, getCurrentUserId: () => USER_ID }) };
}

describe.each(CONSOLE_PORTFOLIO_ELEMENT_TYPES)('stored-byte portfolio contract: %s', type => {
  const input = { userId: USER_ID, type, name: 'versioned-example', displayName: 'versioned-example',
    metadata: { description: 'Versioned example', goal: 'Assist carefully', elements: [], instructions: 'Apply careful review.' },
    tags: ['original'], content: 'Original reference body', now: NOW };

  it('returns the exact stored version and preserves it across a cache reload', async () => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const observation = await manager.readVersioned(created.name);
    expect(created.contentHash).toBe(createHash('sha256').update(observation.raw).digest('hex'));
    manager.clearCache();
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(created);
    const updated = await store.update({ ...input, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, tags: ['changed'] });
    expect(updated?.contentHash).not.toBe(created.contentHash);
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(updated);
    await expect(store.update({ ...input, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    await expect(store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect(await store.findByName(USER_ID, type, created.canonicalName)).toEqual(updated);
  });

  it('does not delete a concurrent edit after the versioned read', async () => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const original = manager.delete.bind(manager);
    jest.spyOn(manager, 'delete').mockImplementationOnce(async (...args) => {
      await store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
        expectedContentHash: created.contentHash, tags: ['concurrent'] });
      return original(...args);
    });
    await expect(store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
      expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    expect((await store.findByName(USER_ID, type, created.canonicalName))?.tags).toEqual(['concurrent']);
  });

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

  it('reads hand-authored stored bytes without substituting cached metadata', async () => {
    const { store, managers, directory } = fixture();
    const created = await store.create(input);
    const observation = await managers[type].readVersioned(created.name);
    expect(observation.identity.kind).toBe('file');
    const raw = type === 'memories'
      ? 'metadata:\n  name: versioned-example\n  description: Hand-authored description\n  tags: [hand-authored]\nentries: []\n'
      : '---\nname: versioned-example\ndescription: Hand-authored description\ntags: [hand-authored]\ngoal: Review carefully\nelements: []\n---\n\nHand-authored legacy body';
    fs.writeFileSync(path.join(directory, type, observation.relativePath), raw);
    const read = await store.findByName(USER_ID, type, created.canonicalName);
    expect(read?.contentHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(read?.metadata.description).toBe('Hand-authored description');
    expect(read?.tags).toEqual(['hand-authored']);
    expect(read?.validationStatus).toBe('valid');
    if (type !== 'memories') expect(read?.content).toBe('Hand-authored legacy body');
    expect((await store.listByUser(USER_ID, { type }))[0]).not.toHaveProperty('contentHash');
  });

  it.each(['delete', 'edit'] as const)('does not overwrite a concurrent %s after the store read', async race => {
    const { store, managers } = fixture();
    const created = await store.create(input);
    const manager = managers[type];
    const original = manager.importElement.bind(manager);
    jest.spyOn(manager, 'importElement').mockImplementationOnce(async (...args) => {
      if (race === 'delete') await store.delete({ userId: USER_ID, type, canonicalName: created.canonicalName,
        expectedVersion: 1, expectedContentHash: created.contentHash, now: NOW });
      else await store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
        expectedContentHash: created.contentHash, tags: ['concurrent'] });
      return original(...args);
    });
    await expect(store.update({ ...input, canonicalName: created.canonicalName, expectedVersion: 1,
      expectedContentHash: created.contentHash, tags: ['losing'] })).rejects.toBeInstanceOf(PortfolioElementVersionConflictError);
    const current = await store.findByName(USER_ID, type, created.canonicalName);
    if (race === 'delete') expect(current).toBeNull();
    else expect(current?.tags).toEqual(['concurrent']);
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

it('resolves date-based memory paths for versioned reads and conditional saves', async () => {
  const { managers, store } = fixture();
  const memory = await managers.memories.importElement('metadata:\n  name: dated-memory\n  description: Dated memory\nentries: []\n', 'yaml');
  const receipt = await managers.memories.save(memory);
  expect(receipt.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\/dated-memory\.yaml$/u);
  const initial = await store.findByName(USER_ID, 'memories', 'dated-memory');
  expect(initial?.contentHash).toBe(receipt.version);
  const updated = await store.update({ userId: USER_ID, type: 'memories', canonicalName: 'dated-memory',
    expectedVersion: 1, content: 'Updated dated entry', now: NOW });
  expect(updated?.content).toContain('Updated dated entry');
  expect((await managers.memories.readVersioned('dated-memory')).relativePath).toBe(receipt.relativePath);
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

it.each(['created', 'root', 'system', 'adapters', '2026-09-28'])('uses the stored memory path with a distinct metadata name: %s', async location => {
  const { directory, managers, store } = fixture();
  if (location === 'created') {
    await store.create({ userId: USER_ID, type: 'memories', name: 'stable-key', displayName: 'Friendly Title',
      metadata: { description: 'Distinct storage and display names' }, content: 'Initial entry', tags: [], now: NOW });
  } else {
    const folder = path.join(directory, 'memories', location === 'root' ? '' : location);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'stable-key.yaml'), 'metadata:\n  name: Friendly Title\n  description: Existing memory\nentries: []\n');
  }
  const initial = await store.findByName(USER_ID, 'memories', 'friendly title');
  expect(initial).not.toBeNull();
  const observation = await managers.memories.readVersioned('Friendly Title');
  expect(observation.relativePath).toContain('stable-key.yaml');
  const updated = await store.update({ userId: USER_ID, type: 'memories', canonicalName: 'friendly title',
    expectedVersion: 1, expectedContentHash: initial?.contentHash, content: 'Updated entry', now: NOW });
  expect(updated?.content).toContain('Updated entry');
  await store.delete({ userId: USER_ID, type: 'memories', canonicalName: 'friendly title',
    expectedVersion: 1, expectedContentHash: updated?.contentHash, now: NOW });
  expect(await store.findByName(USER_ID, 'memories', 'friendly title')).toBeNull();
});

it.each(['skills', 'memories'] as const)('evicts an externally edited %s cache during a console versioned read', async type => {
  const { directory, managers, store } = fixture();
  const created = await store.create({ userId: USER_ID, type, name: 'external-edit', displayName: null,
    metadata: { description: 'Original description', instructions: 'Review carefully.' }, content: 'Reference body', tags: [], now: NOW });
  const manager = managers[type];
  await manager.refreshIndex();
  expect((await manager.findByName(created.name))?.metadata.description).toBe('Original description');
  const observation = await manager.readVersioned(created.name);
  fs.writeFileSync(path.join(directory, type, observation.relativePath), observation.raw.replace('Original description', 'Externally updated description'));
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  expect((await store.findByName(USER_ID, type, created.canonicalName))?.metadata.description).toBe('Externally updated description');
  expect((await manager.findByName(created.name))?.metadata.description).toBe('Externally updated description');
});

it('keeps the primary persona after a stale delete fails', async () => {
  const { managers, store } = fixture();
  for (const name of ['primary-a', 'secondary-b']) {
    await store.create({ userId: USER_ID, type: 'personas', name, displayName: null,
      metadata: { description: 'Active persona' }, content: 'Assist carefully.', tags: [], now: NOW });
    expect((await managers.personas.activatePersona(name)).success).toBe(true);
  }
  const before = managers.personas.getActivePersonaIds();
  expect(before[0]).toBe('primary-a.md');
  const observation = await managers.personas.readVersioned('primary-a');
  await expect(managers.personas.delete('primary-a.md', {
    expected: { identity: observation.identity, version: '0'.repeat(64) },
  })).rejects.toMatchObject({ code: 'ESTALE' });
  expect(managers.personas.getActivePersonaIds()).toEqual(before);
});


it.each(['system', '2026-09-28'])('keeps indexed memory identity when root and %s share a basename', async folder => {
  const { directory, managers, store } = fixture();
  const memoryDir = path.join(directory, 'memories');
  fs.mkdirSync(path.join(memoryDir, folder), { recursive: true });
  const files = [
    { name: 'Root Notes', relativePath: 'shared.yaml' },
    { name: 'Nested Notes', relativePath: `${folder}/shared.yaml` },
  ];
  for (const file of files) {
    fs.writeFileSync(path.join(memoryDir, file.relativePath), `metadata:\n  name: ${file.name}\n  description: ${file.name} description\nentries: []\n`);
  }
  for (const file of files) {
    const observation = await managers.memories.readVersioned(file.name);
    expect(observation.identity).toEqual({ kind: 'file', path: file.relativePath });
    expect(observation.raw).toBe(fs.readFileSync(path.join(memoryDir, file.relativePath), 'utf8'));
    const detail = await store.findByName(USER_ID, 'memories', file.name.toLowerCase());
    expect(detail?.name).toBe(file.name);
    expect(detail?.contentHash).toBe(createHash('sha256').update(observation.raw).digest('hex'));
  }
  for (const [index, file] of files.entries()) {
    const sibling = files[1 - index];
    const siblingBefore = fs.readFileSync(path.join(memoryDir, sibling.relativePath), 'utf8');
    const detail = await store.findByName(USER_ID, 'memories', file.name.toLowerCase());
    const updated = await store.update({ userId: USER_ID, type: 'memories', canonicalName: file.name.toLowerCase(),
      expectedVersion: 1, expectedContentHash: detail?.contentHash, content: `Updated ${file.name}`, now: NOW });
    expect(updated?.content).toContain(`Updated ${file.name}`);
    expect(fs.readFileSync(path.join(memoryDir, sibling.relativePath), 'utf8')).toBe(siblingBefore);
  }
  for (const [index, file] of files.entries()) {
    const sibling = files[1 - index];
    const siblingBefore = index === 0 ? fs.readFileSync(path.join(memoryDir, sibling.relativePath), 'utf8') : undefined;
    const detail = await store.findByName(USER_ID, 'memories', file.name.toLowerCase());
    await store.delete({ userId: USER_ID, type: 'memories', canonicalName: file.name.toLowerCase(),
      expectedVersion: 1, expectedContentHash: detail?.contentHash, now: NOW });
    expect(fs.existsSync(path.join(memoryDir, file.relativePath))).toBe(false);
    if (siblingBefore !== undefined) expect(fs.readFileSync(path.join(memoryDir, sibling.relativePath), 'utf8')).toBe(siblingBefore);
    else expect(fs.existsSync(path.join(memoryDir, sibling.relativePath))).toBe(false);
  }
});

it.each(['skills', 'memories'] as const)('shares one disk scan across sequential %s versioned reads in cooldown', async type => {
  const { directory, managers } = fixture();
  const elementDir = path.join(directory, type);
  fs.mkdirSync(elementDir, { recursive: true });
  fs.writeFileSync(path.join(elementDir, type === 'skills' ? 'cooldown.md' : 'cooldown.yaml'), type === 'skills'
    ? '---\nname: cooldown\ndescription: Cooldown skill\n---\nReview carefully.'
    : 'metadata:\n  name: cooldown\n  description: Cooldown memory\nentries: []\n');
  jest.spyOn(Date, 'now').mockReturnValue(Date.now());
  const scans = jest.spyOn(FileStorageBackend.prototype, 'statMany');
  for (let i = 0; i < 5; i++) expect((await managers[type].readVersioned('cooldown')).raw).toContain('cooldown');
  expect(scans.mock.calls.filter(([dir]) => dir === elementDir)).toHaveLength(1);
  // Explicit refresh callers retain their forced-rescan behavior.
  await managers[type].refreshIndex();
  expect(scans.mock.calls.filter(([dir]) => dir === elementDir)).toHaveLength(2);
});
