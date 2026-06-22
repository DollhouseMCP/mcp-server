/**
 * Tests for DeploymentSeedLoader — bootstrap-time element seeding.
 *
 * Uses a real temp directory with fixture files to test the full
 * scan → install cycle.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DeploymentSeedLoader } from '../../../../src/collection/shared-pool/DeploymentSeedLoader.js';
import type { ISharedPoolInstaller } from '../../../../src/collection/shared-pool/ISharedPoolInstaller.js';
import type { IProvenanceStore } from '../../../../src/collection/shared-pool/IProvenanceStore.js';
import type { ProvenanceRecord } from '../../../../src/collection/shared-pool/types.js';

function makeProvenance(overrides?: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    elementId: 'test-id',
    origin: 'deployment_seed',
    sourceUrl: null,
    sourceVersion: null,
    contentHash: 'a'.repeat(64),
    forkedFrom: null,
    installedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('DeploymentSeedLoader', () => {
  let tmpDir: string;
  let mockInstaller: jest.Mocked<ISharedPoolInstaller>;
  let mockStore: jest.Mocked<IProvenanceStore>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seed-loader-test-'));

    mockInstaller = {
      install: jest.fn<ISharedPoolInstaller['install']>().mockResolvedValue({
        action: 'installed',
        elementId: 'new-id',
        provenance: makeProvenance(),
      }),
    };

    mockStore = {
      lookup: jest.fn<IProvenanceStore['lookup']>(),
      findByElementId: jest.fn<IProvenanceStore['findByElementId']>(),
      save: jest.fn<IProvenanceStore['save']>(),
      update: jest.fn<IProvenanceStore['update']>(),
      listByOrigin: jest.fn<IProvenanceStore['listByOrigin']>().mockResolvedValue([]),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSeedFile(type: string, name: string, content?: string): Promise<void> {
    const dir = path.join(tmpDir, type);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${name}.md`),
      content ?? `---\nname: ${name}\ndescription: A ${type} seed\n---\nContent for ${name}`,
      'utf-8',
    );
  }

  it('installs seed files from the directory', async () => {
    await writeSeedFile('personas', 'company-reviewer');
    await writeSeedFile('skills', 'internal-tool');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockInstaller.install).toHaveBeenCalledTimes(2);
  });

  it('passes correct metadata to the installer', async () => {
    await writeSeedFile('personas', 'style-guide');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    await loader.loadSeeds();

    expect(mockInstaller.install).toHaveBeenCalledWith(
      expect.objectContaining({
        elementType: 'personas',
        name: 'style-guide',
        origin: 'deployment_seed',
        sourceUrl: expect.stringContaining('style-guide.md'),
        sourceVersion: null,
      }),
    );
  });

  it('passes file content to the installer', async () => {
    const content = '---\nname: test\ndescription: test\n---\nCustom body';
    await writeSeedFile('skills', 'my-skill', content);

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    await loader.loadSeeds();

    expect(mockInstaller.install).toHaveBeenCalledWith(
      expect.objectContaining({ content }),
    );
  });

  it('counts skipped elements correctly', async () => {
    mockInstaller.install.mockResolvedValue({
      action: 'skipped',
      elementId: 'existing',
      provenance: makeProvenance(),
      reason: 'unchanged',
    });

    await writeSeedFile('personas', 'existing-one');
    await writeSeedFile('personas', 'existing-two');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  it('returns zero counts when seed directory does not exist', async () => {
    const loader = new DeploymentSeedLoader(
      path.join(os.tmpdir(), 'nonexistent-seed-dir-test'),
      mockInstaller,
      mockStore,
    );
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockInstaller.install).not.toHaveBeenCalled();
  });

  it('returns zero counts when seed directory is empty', async () => {
    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(0);
    expect(mockInstaller.install).not.toHaveBeenCalled();
  });

  it('ignores non-element-type directories', async () => {
    await fs.mkdir(path.join(tmpDir, 'random-dir'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'random-dir', 'file.md'), 'content');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    await loader.loadSeeds();

    expect(mockInstaller.install).not.toHaveBeenCalled();
  });

  it('ignores non-markdown files', async () => {
    await fs.mkdir(path.join(tmpDir, 'personas'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'personas', 'readme.txt'), 'text');
    await fs.writeFile(path.join(tmpDir, 'personas', 'data.json'), '{}');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    await loader.loadSeeds();

    expect(mockInstaller.install).not.toHaveBeenCalled();
  });

  it('accepts .yaml and .yml extensions', async () => {
    await fs.mkdir(path.join(tmpDir, 'memories'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'memories', 'baseline.yaml'), 'entries: []');
    await fs.writeFile(path.join(tmpDir, 'memories', 'backup.yml'), 'entries: []');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(2);
  });

  it('counts failed installations', async () => {
    mockInstaller.install
      .mockResolvedValueOnce({ action: 'installed', elementId: 'ok', provenance: makeProvenance() })
      .mockRejectedValueOnce(new Error('write failed'));

    await writeSeedFile('personas', 'good');
    await writeSeedFile('personas', 'bad');

    const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
    const result = await loader.loadSeeds();

    expect(result.installed).toBe(1);
    expect(result.failed).toBe(1);
  });

  describe('orphan detection', () => {
    it('detects orphaned provenance records', async () => {
      await writeSeedFile('personas', 'active');

      mockStore.listByOrigin.mockResolvedValue([
        makeProvenance({ sourceUrl: `file://${path.join(tmpDir, 'personas', 'active.md')}` }),
        makeProvenance({ sourceUrl: `file://${path.join(tmpDir, 'personas', 'removed.md')}` }),
      ]);

      const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
      const result = await loader.loadSeeds();

      expect(result.orphans).toBe(1);
    });

    it('reports zero orphans when all records match files', async () => {
      await writeSeedFile('personas', 'exists');

      mockStore.listByOrigin.mockResolvedValue([
        makeProvenance({ sourceUrl: `file://${path.join(tmpDir, 'personas', 'exists.md')}` }),
      ]);

      const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
      const result = await loader.loadSeeds();

      expect(result.orphans).toBe(0);
    });
  });

  describe('all supported element types', () => {
    it('processes all six element types', async () => {
      for (const type of ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles']) {
        await writeSeedFile(type, `${type}-seed`);
      }

      const loader = new DeploymentSeedLoader(tmpDir, mockInstaller, mockStore);
      const result = await loader.loadSeeds();

      expect(result.installed).toBe(6);
      expect(mockInstaller.install).toHaveBeenCalledTimes(6);
    });
  });
});
