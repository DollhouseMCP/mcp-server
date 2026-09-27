import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as path from 'node:path';
import { ElementCache } from '../../../src/elements/base/ElementCache.js';
import { ElementLoader, type ElementLoaderHost } from '../../../src/elements/base/ElementLoader.js';
import { ElementEventCoordinator } from '../../../src/elements/base/ElementEventCoordinator.js';
import { ElementEventDispatcher } from '../../../src/events/ElementEventDispatcher.js';
import { Skill } from '../../../src/elements/skills/Skill.js';
import { ElementType } from '../../../src/portfolio/types.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { MetadataService } from '../../../src/services/MetadataService.js';
import { createTestStorageFactory } from '../../helpers/createTestStorageFactory.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const elementDir = path.resolve('/virtual/skills');
  const relativePath = 'sample.md';
  const absolutePath = path.join(elementDir, relativePath);
  const cache = new ElementCache<Skill>(ElementType.SKILL, {
    elementDir,
    getCacheNamespace: () => 'test-user',
    resolveAbsolutePath: filePath => path.resolve(elementDir, filePath),
  }, { elementCacheTTL: 0, pathCacheTTL: 0 });
  const fileOperations = new FileOperationsService(new FileLockManager());
  let version = 'V1';
  const read = async () => `---\nname: sample\ndescription: ${version}\n---\nInstructions`;
  jest.spyOn(fileOperations, 'readElementFile').mockImplementation(read);
  const storage = Object.assign(createTestStorageFactory(fileOperations).createForElement('skills', {
    elementDir, fileExtension: '.md',
  }), { readContent: read });
  const metadataService = new MetadataService();
  const host: ElementLoaderHost<Skill> = {
    elementDir,
    elementType: ElementType.SKILL,
    parseContent: raw => SecureYamlParser.safeMatter(raw),
    migrateMetadataDefaults: () => undefined,
    parseMetadata: async data => ({ name: String(data.name), description: String(data.description) }),
    createElement: (metadata, content) => new Skill(metadata, content, metadataService),
    getElementLabel: () => 'skill',
    getElementLabelCapitalized: () => 'Skill',
    normalizeAndValidatePath: async () => ({ relativePath, absolutePath }),
  };
  const events = new ElementEventCoordinator(new ElementEventDispatcher(), false, {
    elementDir, elementType: ElementType.SKILL,
    getElementLabel: () => 'skill',
    load: async () => { throw new Error('Auto-reload is disabled'); },
  }, cache, storage, undefined, elementDir);
  const loader = new ElementLoader(host, cache, events, fileOperations, storage, {});
  return { cache, host, loader, relativePath, absolutePath, update: () => { version = 'V2'; } };
}

describe.each(['load', 'file snapshot', 'database snapshot'] as const)('ElementLoader %s invalidation', mode => {
  afterEach(() => jest.restoreAllMocks());

  function load(f: ReturnType<typeof fixture>) {
    if (mode === 'file snapshot') return f.loader.loadElementSnapshot(f.absolutePath, f.relativePath);
    if (mode === 'database snapshot') return f.loader.loadElementSnapshotFromDb(f.relativePath);
    return f.loader.load(f.relativePath);
  }

  it('prevents a paused old read from overwriting a newer cached result', async () => {
    const f = fixture();
    const reached = deferred();
    const resume = deferred();
    const parse = f.host.parseMetadata;
    jest.spyOn(f.host, 'parseMetadata').mockImplementationOnce(async data => {
      reached.resolve();
      await resume.promise;
      return parse(data);
    });
    const staleLoad = load(f);
    await reached.promise;
    let fresh: Skill | undefined;
    try {
      f.update();
      // Absolute eviction must invalidate the relative-path read, even on a
      // cache miss. This is the file-mode scanAndEvict calling convention.
      f.cache.uncacheByPath(f.absolutePath);
      fresh = await load(f);
    } finally {
      resume.resolve();
      await staleLoad;
    }
    expect(fresh?.metadata.description).toBe('V2');
    expect(f.cache.getCachedByPath(f.relativePath)).toBe(fresh);
    expect(await staleLoad).toMatchObject({ filename: f.relativePath, filePath: f.relativePath });
    f.cache.dispose();
  });

  it('releases its load token when parsing fails', async () => {
    const f = fixture();
    const begin = jest.spyOn(f.cache, 'beginLoad');
    jest.spyOn(f.host, 'parseMetadata').mockRejectedValueOnce(new Error('Invalid metadata'));
    await expect(load(f)).rejects.toThrow('Invalid metadata');
    expect(begin.mock.results[0].value.isCurrent()).toBe(false);
    expect(f.cache.getCachedByPath(f.relativePath)).toBeUndefined();
    expect((await load(f)).metadata.description).toBe('V1');
    f.cache.dispose();
  });
});
