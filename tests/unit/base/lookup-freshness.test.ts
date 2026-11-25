/**
 * A name lookup decides its own freshness, with no handler-side refresh: a selection the index
 * made that no longer holds (the file went, or now carries another name) is rescanned once and
 * certified again, and a miss is certified against the directory's current members.
 */
import { describe, expect, it, afterEach, beforeEach, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rename, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

const BOUND = 15_000;
const skill = (name: string, description: string) =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${description}\n---\nFollow these detailed instructions.`;

describe('name lookup freshness inside the scan cooldown', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lookup-freshness-'));
    suite = createRealManagerSuite(root);
    dir = (suite.skillManager as any)['elementDir'];
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'alpha.md'), skill('Alpha', 'first'));
    await writeFile(path.join(dir, 'beta-skill.md'), skill('Beta Skill', 'first'));
    await suite.skillManager.list();
  });
  afterEach(async () => {
    await suite.skillManager.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const found = async (name: string) => {
    const element = await suite.skillManager.findByName(name);
    return element ? [element.metadata.name, element.getFilePath?.() ?? (element as any).filePath] : undefined;
  };

  it('finds a definition whose file was renamed on disk', async () => {
    await rename(path.join(dir, 'alpha.md'), path.join(dir, 'renamed-file.md'));
    expect(await found('Alpha')).toEqual(['Alpha', 'renamed-file.md']);
  }, BOUND);

  it('answers the new name, and not the old one, for a definition renamed in place', async () => {
    const file = path.join(dir, 'beta-skill.md');
    await writeFile(file, skill('Gamma Renamed', 'renamed in place'));
    await utimes(file, new Date(), new Date(Date.now() + 9_000));
    expect(await found('Beta Skill')).toBeUndefined();
    expect(await found('Gamma Renamed')).toEqual(['Gamma Renamed', 'beta-skill.md']);
  }, BOUND);

  it('finds a definition added since the index was built, under any filename', async () => {
    await writeFile(path.join(dir, 'odd-name.md'), skill('Delta', 'added'));
    expect(await found('Delta')).toEqual(['Delta', 'odd-name.md']);
  }, BOUND);

  it('answers a hit from the index with no enumeration, and a miss with one', async () => {
    const files = (suite as any).fileOperationsService;
    const enumerations = jest.spyOn(files, 'listDirectoryWithTypes');
    await found('Alpha');
    expect(enumerations).not.toHaveBeenCalled();
    await found('No Such Skill');
    expect(enumerations).toHaveBeenCalledTimes(1);
  }, BOUND);

  it('refuses a selection that still does not hold after the rescan', async () => {
    const manager = suite.skillManager as any;
    await writeFile(path.join(dir, 'alpha.md'), skill('Renamed Elsewhere', 'unobservable'));
    // The rescan cannot observe the change (it is pinned out), so the selection still names 'Alpha'.
    jest.spyOn(manager['_resolver']['host'], 'refreshStaleIndex').mockResolvedValue(undefined);
    await expect(manager.findByName('Alpha')).rejects.toMatchObject({ name: 'ElementIndeterminateError' });
  }, BOUND);

  it('answers an active reference deleted elsewhere from the enforcement scan, without observing again', async () => {
    const manager = suite.skillManager;
    expect((await manager.activateSkill('Alpha')).success).toBe(true);
    await rm(path.join(dir, 'alpha.md'));
    const observe = jest.spyOn((manager as any)['storageLayer'], 'observeCollectionChange');
    const report = await manager.getActiveReferenceReport();
    expect(report.items).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
  }, BOUND);
});
