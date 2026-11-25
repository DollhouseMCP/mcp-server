import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { MemoryActivationStrategy } from '../../../src/handlers/strategies/MemoryActivationStrategy.js';

const content = (name: string) => `name: ${name}\ndescription: Detailed memory attribution fixture\nautoLoad: true\nentries: []\n`;
const broken = 'name: [unfinished';
type Suite = ReturnType<typeof createRealManagerSuite>;
const dispose = (suite: Suite) => Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager,
  suite.ensembleManager, suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
afterEach(() => jest.restoreAllMocks());

describe('memory failed-name attribution', () => {
  it.each(['cold', 'warm', 'restart', 'restart without index'])('blocks a never-parsed newer dated copy (%s)', async state => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-attribution-'));
    let suite = createRealManagerSuite(root);
    const older = '2026-10-01/policy-memory.yaml';
    const newer = '2026-10-27/policy-memory.yaml';
    try {
      for (const date of ['2026-10-01', '2026-10-27']) await mkdir(path.join(root, 'memories', date), { recursive: true });
      await writeFile(path.join(root, 'memories', older), content('Policy Memory'));
      if (state !== 'cold') expect(await suite.memoryManager.findByName('Policy Memory')).toBeDefined();
      await writeFile(path.join(root, 'memories', newer), broken);
      if (state.startsWith('restart')) {
        await suite.memoryManager.scanAndEvict();
        await dispose(suite);
        if (state === 'restart without index') await rm(path.join(root, 'memories', '_index.json'), { force: true });
        suite = createRealManagerSuite(root);
      } else suite.memoryManager['storageLayer'].invalidate();
      const manager = suite.memoryManager;
      for (const name of ['policy-memory', 'Policy Memory']) {
        await expect(manager.findByName(name)).rejects.toMatchObject({ kind: 'indeterminate' });
        await expect(manager.findByName(name)).rejects.toThrow(newer);
        await expect(manager.load(name)).rejects.toThrow(newer);
        await expect(manager.activateMemory(name)).rejects.toThrow(newer);
        await expect(new MemoryActivationStrategy(manager).getElementDetails(name)).rejects.toThrow(newer);
      }
      const report = await manager.listReport();
      expect(report.complete).toBe(false);
      expect(report.items).toEqual([]);
      expect(report.failures.map(failure => failure.reference)).toContain(newer);
      await expect(manager.getAutoLoadMemories()).rejects.toThrow(newer);
      expect(await manager.getAutoLoadMemoryReport()).toMatchObject({ complete: false, items: [],
        failures: expect.arrayContaining([expect.objectContaining({ reference: newer })]) });
    } finally { await dispose(suite); await rm(root, { recursive: true, force: true }); }
  });

  it('serves an older healthy copy when a never-parsed mismatched filename hides the same intended name', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-residual-'));
    const suite = createRealManagerSuite(root);
    try {
      await mkdir(path.join(root, 'memories'), { recursive: true });
      await writeFile(path.join(root, 'memories', 'policy-memory.yaml'), content('Policy Memory'));
      await writeFile(path.join(root, 'memories', 'external-draft.yaml'), 'name: Policy Memory\nentries: [unfinished');
      // A certified name is read through the loader route (loadStoredReference), never back through load().
      const load = jest.spyOn(suite.memoryManager as any, 'loadStoredReference');
      expect((await suite.memoryManager.findByName('Policy Memory'))?.metadata.name).toBe('Policy Memory');
      expect(load).toHaveBeenCalledTimes(1);
      await expect(suite.memoryManager.findByName('missing')).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(suite.memoryManager.findByName('external-draft')).rejects.toMatchObject({ kind: 'indeterminate' });
      await expect(suite.memoryManager.activateMemory('Policy Memory')).resolves.toMatchObject({ success: true });
      expect((await new MemoryActivationStrategy(suite.memoryManager).getElementDetails('Policy Memory')).content[0].text).toContain('Policy Memory');
      await expect(suite.memoryManager.list()).rejects.toMatchObject({ kind: 'indeterminate' });
      expect(await suite.memoryManager.listReport()).toMatchObject({ complete: false,
        items: [expect.objectContaining({ metadata: expect.objectContaining({ name: 'Policy Memory' }) })],
        failures: [expect.objectContaining({ reference: 'external-draft.yaml' })] });
      await expect(suite.memoryManager.getAutoLoadMemories()).rejects.toThrow('external-draft.yaml');
      expect(await suite.memoryManager.getAutoLoadMemoryReport()).toMatchObject({ complete: false,
        items: [expect.objectContaining({ metadata: expect.objectContaining({ name: 'Policy Memory' }) })],
        failures: [expect.objectContaining({ reference: 'external-draft.yaml' })] });
    } finally { await dispose(suite); await rm(root, { recursive: true, force: true }); }
  });

  it('blocks retained and filename names after a rewrite, including case and NFC variants', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memory-rewrite-'));
    const suite = createRealManagerSuite(root);
    try {
      await mkdir(path.join(root, 'memories'), { recursive: true });
      const reference = path.join(root, 'memories', 'renamed.yaml');
      await writeFile(reference, content('Café Policy'));
      expect(await suite.memoryManager.findByName('Café Policy')).toBeDefined();
      await writeFile(reference, broken);
      await suite.memoryManager.scanAndEvict();
      for (const name of ['Café Policy', 'CAFÉ POLICY', 'Cafe\u0301 Policy', 'renamed']) {
        await expect(suite.memoryManager.findByName(name)).rejects.toThrow('renamed.yaml');
      }
      expect(await suite.memoryManager.findByName('unrelated-missing')).toBeUndefined();
    } finally { await dispose(suite); await rm(root, { recursive: true, force: true }); }
  });
});
