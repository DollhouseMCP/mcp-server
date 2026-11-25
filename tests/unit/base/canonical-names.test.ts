import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import {
  canonicalElementName, foldedNameKey, resolveNamedCandidate, slugNameKey, MAX_ELEMENT_NAME_LENGTH,
} from '../../../src/storage/ElementNameKeys.js';
import { FrontmatterParser } from '../../../src/storage/FrontmatterParser.js';
import { MemoryMetadataExtractor } from '../../../src/storage/MemoryMetadataExtractor.js';
import { Memory } from '../../../src/elements/memories/Memory.js';
import { Ensemble } from '../../../src/elements/ensembles/Ensemble.js';
import { acceptsLoadedDefinition } from '../../../src/elements/base/ElementNameEvidence.js';
import { createTestMetadataService } from '../../helpers/di-mocks.js';

const LONG_NAME = `Long ${'x'.repeat(MAX_ELEMENT_NAME_LENGTH)}`;
const NAMES = ['Q&A', "Bob's Notes", "What's New?", LONG_NAME];
const skill = (name: string) => `---\nname: ${JSON.stringify(name)}\ndescription: Canonical name fixture\n---\nFollow these detailed instructions.`;

describe('one canonical element name', () => {
  it('normalises, sanitises and truncates once, and both selection keys compare canonical forms', () => {
    expect(canonicalElementName('Q&A')).toBe('QA');
    expect(canonicalElementName(LONG_NAME)).toHaveLength(MAX_ELEMENT_NAME_LENGTH);
    expect(foldedNameKey('Q&A')).toBe(foldedNameKey('QA'));
    expect(slugNameKey("Bob's Notes")).toBe(slugNameKey(canonicalElementName("Bob's Notes")));
    // A name that canonicalises to nothing has no key and selects nothing.
    expect(foldedNameKey('&&')).toBe('');
    expect(resolveNamedCandidate('&&', [{ reference: 'x.md', name: '!!' }]).selected).toBeUndefined();
  });

  it('gives the index, the hydrated element and a stored raw name one name', () => {
    for (const name of NAMES) {
      const canonical = canonicalElementName(name);
      expect(FrontmatterParser.extractMetadata(skill(name)).name).toBe(canonical);
      // The memory index keeps the stored (raw) name, the guarded console's identity; its canonical
      // form is the hydrated name, and selection compares canonical keys.
      const memoryYaml = `metadata:\n  name: ${JSON.stringify(name)}\nentries: []\n`;
      const memoryIndexName = MemoryMetadataExtractor.extractMetadata(memoryYaml, 'm.yaml').name;
      expect(memoryIndexName).toBe(name.normalize('NFC'));
      expect(canonicalElementName(memoryIndexName)).toBe(canonical);
      // Memory and Ensemble compute the same canonical form in their own constructors (pinned here).
      expect(new Memory({ name }, createTestMetadataService()).metadata.name).toBe(canonical);
      expect(new Ensemble({ name }, [], createTestMetadataService()).metadata.name).toBe(canonical);
      // A loaded (hydrated) definition is accepted for the raw name it was stored under, on either backend.
      expect(acceptsLoadedDefinition(name, 'row-id', canonical)).toBe(true);
      expect(resolveNamedCandidate(name, [{ reference: 'row-id', name }]).selected?.reference).toBe('row-id');
    }
  });

  it('refuses two stored names that collide after canonicalising, unless the caller\'s own text names one file', () => {
    const candidates = [{ reference: 'qa-agent.md', name: 'Q&A' }, { reference: 'qa.md', name: 'QA' }];
    expect(resolveNamedCandidate('Q&A', candidates)).toMatchObject({ selected: undefined, competitors: candidates });
    // The filename witnesses only what was asked: 'QA' names qa.md.
    expect(resolveNamedCandidate('QA', candidates).selected?.reference).toBe('qa.md');
  });
});

describe('canonical names through a real file manager', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'canonical-names-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it.each(NAMES.filter(name => name !== LONG_NAME))('reads, targets for update, activates and restores %s by the name it was stored under', async name => {
    await writeFile(path.join(dir, 'stored.md'), skill(name));
    const manager = suite.skillManager;
    const canonical = canonicalElementName(name);
    expect((await manager.findByName(name))?.metadata.name).toBe(canonical);
    expect((await manager.findForUpdate(name))?.path).toBe('stored.md');
    expect((await manager.listReport()).items.map(item => item.metadata.name)).toEqual([canonical]);
    expect((await manager.activateSkill(name)).success).toBe(true);
    const recorded = [...(manager as any)['getActivationSet']()];
    expect(recorded).toEqual([canonical]);
    // Restart: a fresh manager restores the recorded activation through findByName.
    const restarted = createRealManagerSuite(root);
    try {
      for (const reference of recorded) (restarted.skillManager as any)['getActivationSet']().add(reference);
      expect((await restarted.skillManager.getActiveSkills()).map(item => item.metadata.name)).toEqual([canonical]);
    } finally {
      await restarted.skillManager.dispose();
    }
  });

  it('reports a stored name over the length limit as an unreadable definition, never as absent', async () => {
    // The loader's field rule refuses names over the limit (pre-existing); the index still lists the
    // record under its canonical (truncated) name, so the lookup selects it and the read refuses typed.
    await writeFile(path.join(dir, 'stored.md'), skill(LONG_NAME));
    const manager = suite.skillManager;
    await expect(manager.findByName(LONG_NAME)).rejects.toMatchObject({ kind: 'unreadable' });
    const report = await manager.listReport();
    expect(report.items).toEqual([]);
    expect(report.failures.map(failure => failure.reference)).toEqual(['stored.md']);
  });

  it('refuses a name two stored definitions share after canonicalising', async () => {
    await writeFile(path.join(dir, 'qa-agent.md'), skill('Q&A'));
    await writeFile(path.join(dir, 'qa.md'), skill('QA'));
    await expect(suite.skillManager.findByName('Q&A')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
  });

  it('reads by name a definition the listing shows beside a never-parsed failed file that could hold the name', async () => {
    await writeFile(path.join(dir, 'code-review.md'), skill('Code Review'));
    await writeFile(path.join(dir, 'Code Review.md'), '---\nname: [broken\n---');
    const manager = suite.skillManager;
    const report = await manager.listReport();
    expect(report.items.map(item => item.metadata.name)).toEqual(['Code Review']);
    expect(report.failures.map(failure => failure.reference)).toEqual(['Code Review.md']);
    expect((await manager.findByName('Code Review'))?.metadata.name).toBe('Code Review');
    // An absence claim is still refused while a never-parsed failure exists.
    await expect(manager.findByName('Release Notes')).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});
