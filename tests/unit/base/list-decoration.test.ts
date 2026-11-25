import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';
import { decoratedTypes, disposeListingSuite, verifyActiveListing } from '../../helpers/listDecorationCases.js';
import { PersonaHandler } from '../../../src/handlers/PersonaHandler.js';
import { PersonaExporter } from '../../../src/persona/export-import/PersonaExporter.js';
import type { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaIndicatorService } from '../../../src/services/PersonaIndicatorService.js';
import { ManagerBackedPortfolioElementStore } from '../../../src/web-console/stores/ManagerBackedPortfolioElementStore.js';
import { PersonaElement } from '../../../src/persona/PersonaElement.js';

afterEach(() => jest.restoreAllMocks());

describe('list report decoration on files', () => {
  it.each(decoratedTypes)('keeps active %s in list_elements after eviction', async type => {
    const root = await mkdtemp(path.join(tmpdir(), 'listed-file-'));
    const suite = createRealManagerSuite(root);
    try { await verifyActiveListing(suite, type); }
    finally { await disposeListingSuite(suite); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['list', 'report', 'reload', 'handler', 'export', 'import', 'console'] as const)('derives persona filenames through %s', async route => {
    const root = await mkdtemp(path.join(tmpdir(), 'listed-persona-'));
    const suite = createRealManagerSuite(root);
    const persona = new PersonaElement({ name: 'Listed Persona', unique_id: 'listed-persona-id' }, 'Instructions', undefined, suite.metadataService);
    const existing = new PersonaElement({ name: 'Existing Persona' }, 'Instructions', 'kept.md', suite.metadataService);
    jest.spyOn(suite.personaManager['_listOps'], 'listReport').mockResolvedValue({ items: [persona, existing], complete: true, failures: [] });
    try {
      const exporter = new PersonaExporter(null);
      const exportBundle = jest.spyOn(exporter, 'exportBundle');
      const handler = new PersonaHandler(suite.personaManager, exporter, undefined,
        {} as InitializationService, { getPersonaIndicator: () => '' } as PersonaIndicatorService,
        { get: () => 'listed-persona-id.md', set: () => {} });
      const operations = {
        list: () => suite.personaManager.list(),
        report: () => suite.personaManager.listReport(),
        reload: () => suite.personaManager.reload(),
        handler: async () => expect((await handler.listPersonas()).content[0].text).toContain('🔹 **Listed Persona**'),
        export: async () => {
          await handler.exportAllPersonas();
          expect(exportBundle.mock.results[0].value.personas.map(item => item.filename)).toEqual(['listed-persona-id.md', 'kept.md']);
        },
        import: async () => expect(await handler['postImportListingNotice']()).toBe('Total personas: 2'),
        console: async () => {
          const store = new ManagerBackedPortfolioElementStore({ managers: {
            personas: suite.personaManager, skills: suite.skillManager, templates: suite.templateManager,
            agents: suite.agentManager, memories: suite.memoryManager, ensembles: suite.ensembleManager,
          }, getCurrentUserId: () => '018f3d47-73ae-7f10-a0de-0742618d4fb1' });
          expect((await store.listByUser('018f3d47-73ae-7f10-a0de-0742618d4fb1', { type: 'personas' })).items).toHaveLength(2);
        },
      };
      await operations[route]();
      expect([persona.filename, existing.filename]).toEqual(['listed-persona-id.md', 'kept.md']);
    } finally { await disposeListingSuite(suite); await rm(root, { recursive: true, force: true }); }
  });
  it('keeps template metadata through all report-based helpers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'listed-template-'));
    const suite = createRealManagerSuite(root);
    try {
      await suite.templateManager.create({ name: 'helper-template', description: 'Helper fixture',
        content: 'Template content', metadata: { category: 'review', tags: ['review'] } });
      expect((await suite.templateManager.findByCategory('review')).items.map(item => item.metadata.name)).toEqual(['helper-template']);
      expect((await suite.templateManager.findByTag('review')).items.map(item => item.metadata.name)).toEqual(['helper-template']);
      expect((await suite.templateManager.getMostUsed()).items.map(item => item.metadata.name)).toEqual(['helper-template']);
    } finally { await disposeListingSuite(suite); await rm(root, { recursive: true, force: true }); }
  });

});
