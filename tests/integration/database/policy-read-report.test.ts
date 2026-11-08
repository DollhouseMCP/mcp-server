import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { elements } from '../../../src/database/schema/elements.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import { ActivePolicyCollector } from '../../../src/services/policy/ActivePolicyCollector.js';
import { PolicyUnavailableError } from '../../../src/services/policy/PolicyUnavailableError.js';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { buildSkillContent, cleanupAllTestData, closeTestDb, ensureTestUser, fixedUserId, getTestDb } from './test-db-helpers.js';

afterAll(closeTestDb);

describe.each(['file', 'database'] as const)('%s policy read reports', backend => {
  it.each([false, true])('keeps ensemble activation membership live during member lookup (remove pending: %s)', async removePending => {
    const root = await mkdtemp(path.join(tmpdir(), 'ensemble-policy-live-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined });
    const managers = [suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager, suite.agentManager, suite.personaManager];
    const write = async (type: string, name: string, fields: string) => {
      const content = `---\nname: ${name}\ndescription: Live ensemble member fixture\n${fields}\n---\nDetailed policy instructions.`;
      if (user) await new DatabaseStorageLayer(getTestDb(), user, type).writeContent(type, name, content,
        { description: 'Live ensemble fixture', author: 'test', version: '1.0.0', tags: [] });
      else {
        await mkdir(path.join(root, type), { recursive: true });
        await writeFile(path.join(root, type, `${name}.md`), content);
      }
    };
    try {
      for (const name of ['member-a', 'member-b', 'late-member']) await write('skills', name, 'gatekeeper:\n  deny: [delete_element]');
      await write('ensembles', 'ensemble-a', 'elements:\n  - element_type: skill\n    element_name: member-a');
      await write('ensembles', 'ensemble-b', 'elements:\n  - element_type: skill\n    element_name: member-b');
      const active = suite.ensembleManager['getActivationSet']();
      active.add('ensemble-a');
      let release!: () => void;
      let started!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { started = resolve; });
      const original = suite.skillManager.findByName.bind(suite.skillManager);
      const lookup = jest.spyOn(suite.skillManager, 'findByName').mockImplementation(async name => {
        if (name === 'member-a') { started(); await pending; }
        return original(name);
      });
      const collector = new ActivePolicyCollector({ ...suite, ensureInitialized: async () => {},
        getManagerForType: type => type === 'skills' ? suite.skillManager : undefined });
      const collecting = collector.collectActiveElementsForReport();
      await Promise.race([entered, collecting.then(() => { throw new Error('Collection ended before member lookup'); })]);
      active.add('ensemble-b');
      if (removePending) active.delete('ensemble-a');
      const a = suite.ensembleManager['getCachedElementsForCurrentNamespace']().find(item => item.metadata.name === 'ensemble-a')!;
      a.metadata.elements.push({ element_type: 'skill', element_name: 'late-member' } as any);
      release();
      const report = await collecting;
      expect(report.complete).toBe(true);
      const names = report.items.map(item => item.name);
      expect(names).toEqual(expect.arrayContaining(['ensemble-b', 'member-b']));
      expect(names.includes('ensemble-a')).toBe(!removePending);
      expect(names.includes('member-a')).toBe(!removePending);
      expect(names).not.toContain('late-member');
      expect(lookup.mock.calls.map(([name]) => name)).toEqual(['member-a', 'member-b']);
    } finally {
      jest.restoreAllMocks();
      await Promise.all(managers.map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      if (user) await cleanupAllTestData();
    }
  });

  it.each(['skill', 'ensemble', 'agent', 'persona'] as const)('refuses enforcement and reports survivors after a malformed active %s', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'policy-read-report-'));
    const user = backend === 'database' ? fixedUserId(await ensureTestUser()) : undefined;
    const factory = user ? new DatabaseStorageLayerFactory(getTestDb(), user) : undefined;
    const suite = createRealManagerSuite(root, { storageLayerFactory: factory });
    const healthyType = type;
    const brokenManager = suite[`${type}Manager`];
    const healthyManager = suite[`${healthyType}Manager`];
    const write = async (kind: typeof type, name: string) => {
      const collection = `${kind}s`;
      const content = buildSkillContent(name);
      if (user) return new DatabaseStorageLayer(getTestDb(), user, collection).writeContent(collection, name, content, {
        description: 'Policy read fixture', author: 'test', version: '1.0.0', tags: [],
      });
      const directory = path.join(root, collection);
      await mkdir(directory, { recursive: true });
      const filename = `${name}.md`;
      await writeFile(path.join(directory, filename), content);
      return filename;
    };
    try {
      const brokenIdentity = await write(type, 'broken-policy');
      await write(healthyType, 'healthy-policy');
      brokenManager['getActivationSet']().add('broken-policy');
      healthyManager['getActivationSet']().add('healthy-policy');
      const collector = new ActivePolicyCollector({ ...suite,
        ensureInitialized: async () => {},
        getManagerForType: () => undefined,
      });
      expect((await collector.collectActiveElementsForReport()).complete).toBe(true);
      const malformed = '---\nname: [unfinished\n---\n';
      if (user) {
        await withUserContext(getTestDb(), user(), tx => tx.update(elements).set({ rawContent: malformed })
          .where(eq(elements.id, brokenIdentity)));
      } else {
        await writeFile(path.join(root, `${type}s`, brokenIdentity), malformed);
      }
      brokenManager.clearCache();
      const report = await collector.collectActiveElementsForReport({ freshAfterInFlight: true });
      expect(report.complete).toBe(false);
      expect(report.items.map(item => item.name)).toContain('healthy-policy');
      expect(report.failures.some(failure => failure.reference === 'broken-policy')).toBe(true);
      const enforcement = await collector.collectActiveElementsForPolicy().then(() => false, cause => cause instanceof PolicyUnavailableError);
      expect(enforcement).toBe(true);
      brokenManager['getActivationSet']().delete('broken-policy');
      const recovered = await collector.collectActiveElementsForReport();
      expect(recovered.complete).toBe(true);
      expect(recovered.items.map(item => item.name)).toContain('healthy-policy');
    } finally {
      brokenManager['getActivationSet']().clear();
      healthyManager['getActivationSet']().clear();
      await Promise.all([suite.skillManager, suite.templateManager, suite.memoryManager, suite.ensembleManager,
        suite.agentManager, suite.personaManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
      if (user) await cleanupAllTestData();
    }
  });
});
