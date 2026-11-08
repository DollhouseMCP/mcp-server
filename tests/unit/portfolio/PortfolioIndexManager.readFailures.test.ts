import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PortfolioIndexManager, type IndexEntry } from '../../../src/portfolio/PortfolioIndexManager.js';
import { PortfolioManager } from '../../../src/portfolio/PortfolioManager.js';
import type { IndexConfigManager } from '../../../src/portfolio/config/IndexConfig.js';
import { createTestFileOperationsService } from '../../helpers/di-mocks.js';
import { ElementReadError } from '../../../src/elements/base/ElementReadError.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { CollectionFailure } from '../../../src/elements/base/CollectionReport.js';
import { resolveElementTypes } from '../../../src/utils/elementTypeResolver.js';

afterEach(() => jest.restoreAllMocks());

async function sameNameFixture(source: 'files' | 'memory-source') {
  const root = await mkdtemp(path.join(tmpdir(), 'portfolio-same-name-'));
  const files = createTestFileOperationsService();
  const portfolio = new PortfolioManager(files, { baseDir: root });
  const config = { getConfig: () => ({ index: { ttlMinutes: 5 } }) } as IndexConfigManager;
  const type = source === 'files' ? ElementType.SKILL : ElementType.MEMORY;
  const extension = source === 'files' ? '.md' : '.yaml';
  const entries: IndexEntry[] = ['first', 'second'].map(filename => ({
    filePath: path.join(root, type, `${filename}${extension}`), elementType: type,
    filename, lastModified: new Date(0),
    metadata: { name: 'Same name', tags: ['shared-tag'], keywords: ['shared-keyword'] },
  }));
  const failures: CollectionFailure[] = [];
  await mkdir(path.join(root, type));
  if (source === 'files') {
    await Promise.all(entries.map(entry => writeFile(entry.filePath,
      '---\nname: Same name\ntags: [shared-tag]\nkeywords: [shared-keyword]\n---\nReadable instructions.')));
  }
  const memorySource = source === 'memory-source' ? {
    namespace: root, assertCurrent: () => {},
    listEntries: async () => ({ items: entries, failures, complete: failures.length === 0 }),
  } : undefined;
  const index = new PortfolioIndexManager(config, portfolio, files, memorySource);
  return { root, index, type, entries, fail: async () => {
    const reference = path.join(type, `same-name${extension}`);
    if (source === 'files') await writeFile(path.join(root, reference), '---\nname: [unfinished\n---\n');
    else failures.push({ reference, candidateNames: ['Same name'], error: new ElementReadError('Unreadable', 'unreadable') });
  } };
}

describe('portfolio read failures', () => {
  it.each(['root', 'date'] as const)('retains memory siblings after a %s entry stat failure', async location => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-inventory-'));
    const files = createTestFileOperationsService();
    const portfolio = new PortfolioManager(files, { baseDir: root });
    const config = { getConfig: () => ({ index: { ttlMinutes: 5 } }) } as IndexConfigManager;
    const index = new PortfolioIndexManager(config, portfolio, files);
    const memories = path.join(root, ElementType.MEMORY);
    const date = path.join(memories, '2026-11-24');
    const brokenDir = location === 'root' ? memories : date;
    const brokenReference = path.join(ElementType.MEMORY, location === 'root' ? '' : '2026-11-24', 'broken.yaml');
    try {
      await mkdir(date, { recursive: true });
      await writeFile(path.join(memories, 'root.yaml'), 'name: Healthy root\ndescription: Root memory');
      await writeFile(path.join(date, 'dated.yaml'), 'name: Healthy dated\ndescription: Dated memory');
      await symlink(path.join(root, 'absent-target'), path.join(brokenDir, 'broken.yaml'));
      const report = await index.getIndexReport();
      expect(report.items[0].byType.get(ElementType.MEMORY)?.map(entry => entry.metadata.name).sort())
        .toEqual(['Healthy dated', 'Healthy root']);
      expect(report.complete).toBe(false);
      expect(report.failures.map(failure => failure.reference)).toEqual([brokenReference]);
      expect(report.failures[0].error).toBeInstanceOf(ElementReadError);
      expect((await index.searchReport('Healthy')).items).toHaveLength(2);
      await expect(index.getIndex()).rejects.toBeInstanceOf(ElementReadError);
      // A stat failure still participates in the same-name survivor shadowing rule.
      await writeFile(path.join(memories, 'copy.yaml'), 'name: broken\ndescription: Shadowed memory');
      await expect(index.rebuildIndex()).rejects.toBeInstanceOf(ElementReadError);
      const rebuilt = await index.getIndexReport();
      expect(rebuilt.items[0].byType.get(ElementType.MEMORY)?.map(entry => entry.metadata.name).sort())
        .toEqual(['Healthy dated', 'Healthy root']);
      expect(rebuilt.failures.map(failure => failure.reference)).toEqual([brokenReference]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['files', 'memory-source'] as const)('keeps distinct same-name entries when merging %s', async source => {
    const fixture = await sameNameFixture(source);
    const { index, entries, type, root } = fixture;
    try {
      const report = await index.getIndexReport();
      expect(report.complete).toBe(true);
      const built = report.items[0];
      const expectedPaths = entries.map(entry => entry.filePath).sort();
      expect([...built.byFilename.values()].map(entry => entry.filePath).sort()).toEqual(expectedPaths);
      expect(built.byType.get(type)?.map(entry => entry.filePath).sort()).toEqual(expectedPaths);
      expect(built.byTag.get('shared-tag')).toHaveLength(2);
      expect(built.byKeyword.get('shared-keyword')).toHaveLength(2);
      expect((await index.getStats()).elementsByType[type]).toBe(2);
      for (const entry of entries) {
        expect((await index.findByName(entry.filename, { fuzzyMatch: false }))?.filePath).toBe(entry.filePath);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['files', 'memory-source'] as const)('withholds same-name %s survivors when a failed record could hold their name', async source => {
    const fixture = await sameNameFixture(source);
    try {
      await fixture.fail();
      const report = await fixture.index.getIndexReport();
      expect(report.complete).toBe(false);
      expect(report.failures).toHaveLength(1);
      const built = report.items[0];
      expect(built.byType.get(fixture.type)).toEqual([]);
      expect(built.byFilename.size).toBe(0);
      expect(built.byName.size).toBe(0);
      expect(built.byTag.size).toBe(0);
      expect(built.byKeyword.size).toBe(0);
      await expect(fixture.index.getIndex()).rejects.toBeInstanceOf(ElementReadError);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  it('caches incomplete index evidence until the next explicit rebuild', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'portfolio-report-'));
    const files = createTestFileOperationsService();
    const portfolio = new PortfolioManager(files, { baseDir: root });
    const config = { getConfig: () => ({ index: { ttlMinutes: 5 } }) } as IndexConfigManager;
    const index = new PortfolioIndexManager(config, portfolio, files);
    const broken = path.join(root, 'skills', 'broken.md');
    try {
      await mkdir(path.join(root, 'skills'));
      await writeFile(path.join(root, 'skills', 'healthy.md'), '---\nname: healthy\n---\nHealthy instructions.');
      await writeFile(broken, '---\nname: [unfinished\n---\n');
      const read = jest.spyOn(files, 'readFile');
      const report = await index.searchReport('healthy');
      const reads = read.mock.calls.length;
      expect(report.items.map(result => result.entry.metadata.name)).toEqual(['healthy']);
      expect(report).toMatchObject({ complete: false, failures: [{ reference: path.join('skills', 'broken.md') }] });
      expect(JSON.stringify(report.failures)).not.toContain(root);
      await expect(index.getIndex()).rejects.toBeInstanceOf(ElementReadError);
      expect(read).toHaveBeenCalledTimes(reads);
      await writeFile(broken, '---\nname: repaired\n---\nRepaired instructions.');
      await index.rebuildIndex();
      expect((await index.searchReport('repaired')).complete).toBe(true);
      expect((await index.searchReport('repaired')).items).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['enumeration', 'content', 'malformed'] as const)('does not publish an empty index after %s failure', async failure => {
    const root = await mkdtemp(path.join(tmpdir(), 'portfolio-read-'));
    const files = createTestFileOperationsService();
    const portfolio = new PortfolioManager(files, { baseDir: root });
    const config = { getConfig: () => ({ index: { ttlMinutes: 5 } }) } as IndexConfigManager;
    const index = new PortfolioIndexManager(config, portfolio, files);
    try {
      await mkdir(path.join(root, 'skills'));
      await writeFile(path.join(root, 'skills', 'policy.md'), failure === 'malformed'
        ? '---\nname: [unfinished\n---\n' : '---\nname: policy\n---\nPolicy instructions.');
      if (failure === 'enumeration') jest.spyOn(files, 'listDirectory').mockRejectedValue(new Error('Enumeration failed'));
      if (failure === 'content') jest.spyOn(files, 'readFile').mockRejectedValue(new Error('Read failed'));
      await expect(index.getStats()).rejects.toBeInstanceOf(ElementReadError);
      await expect(index.findByName('policy')).rejects.toBeInstanceOf(ElementReadError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not infer a unique type when another manager cannot answer', async () => {
    const skillManager = { findByName: async () => ({ metadata: { name: 'policy' } }) };
    const memoryManager = { findByName: async () => { throw new Error('Storage unavailable'); } };
    await expect(resolveElementTypes([{ element_name: 'policy' }], { skillManager, memoryManager }))
      .rejects.toBeInstanceOf(ElementReadError);
  });
});
