import { ActivationMetricsTracker } from '../../../src/metrics/ActivationMetricsTracker.js';
import { writeFile, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { withUserContext } from '../../../src/database/rls.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../src/database/schema/index.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import type { AgentManager } from '../../../src/elements/agents/AgentManager.js';
import type { TemplateManager } from '../../../src/elements/templates/TemplateManager.js';
import type { MemoryManager } from '../../../src/elements/memories/MemoryManager.js';
import { DatabaseStorageLayer } from '../../../src/storage/DatabaseStorageLayer.js';
import type { IStorageLayerFactory } from '../../../src/storage/IStorageLayerFactory.js';
import type { SerializationService } from '../../../src/services/SerializationService.js';
import type { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { ElementType } from '../../../src/portfolio/types.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import type { SkillManager } from '../../../src/elements/skills/SkillManager.js';
import type { EnsembleManager } from '../../../src/elements/ensembles/EnsembleManager.js';
import { ElementCRUDHandler } from '../../../src/handlers/ElementCRUDHandler.js';
import { createIntegrationContainer } from '../integration-container.js';
import { OperationCounter } from './OperationCounter.js';

export const TYPES = [ElementType.PERSONA, ElementType.SKILL, ElementType.ENSEMBLE] as const;
export type CountedType = typeof TYPES[number];
export const ALL_TYPES = [...TYPES, ElementType.AGENT, ElementType.TEMPLATE, ElementType.MEMORY] as const;
export type AllCountedType = typeof ALL_TYPES[number];
export type Backend = 'file' | 'db';

/** Fixed-width names and UTF-8 content make byte expectations stable across fixtures. */
export function elementContent(type: AllCountedType, index: number, edited = false): string {
  const extra = type === ElementType.ENSEMBLE ? 'elements: []\n' : '';
  return `---\nname: ${type}-${index.toString().padStart(2, '0')}\ndescription: Counting fixture\nversion: 1.0.0\n${extra}---\n${edited ? 'Edited café body.' : 'Original café body.'}\n`;
}

async function buildCacheFixture(mode: Backend, dbOptions?: { url: string; userId: string }, extended = false) {
  const env = await createIntegrationContainer();
  const restores: (() => void)[] = [];
  // Register each acquired observer before attempting the next fallible acquisition.
  const observe = (install: () => () => void) => { restores.push(install()); };
  let client: ReturnType<OperationCounter['client']> | undefined;
  const dispose = async () => {
    try {
      const reversed = [...restores].reverse();
      const results = await Promise.allSettled(reversed.map(restore => Promise.resolve().then(restore)));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Observer cleanup failed');
    } finally {
      try { await env.dispose(); } finally { await client?.end(); }
    }
  };
  try {
    const counter = new OperationCounter();
    const files = env.container.resolve<FileOperationsService>('FileOperationsService');
    const enabledTypes = extended ? ALL_TYPES : TYPES;
    observe(() => counter.observeFiles(files, file => enabledTypes.some(type =>
      file.startsWith(env.portfolioManager.getElementDir(type) + path.sep)) && /\.(md|yaml)$/.test(file)));
    observe(() => counter.observeYaml());
    observe(() => counter.observePureYaml(env.container.resolve<SerializationService>('SerializationService')));
    observe(() => counter.observeIndexParses());
    client = mode === 'db' && dbOptions ? counter.client(dbOptions.url) : undefined;
    const db = client ? drizzle(client, { schema }) : undefined;
    // Prime driver type discovery outside measurements, including empty portfolios.
    if (client) await client`SELECT 1`;
    const layers = new Map<AllCountedType, DatabaseStorageLayer>();
    const fileFactory = env.container.resolve<IStorageLayerFactory>('StorageLayerFactory');
    env.container.replace<IStorageLayerFactory>('StorageLayerFactory', () => ({
      createForElement: (type, options) => fileFactory.createForElement(type, { ...options, scanCooldownMs: 0 }),
    }));
    if (mode === 'db') {
      if (!db || !dbOptions) throw new Error('Database fixture requires a database and tenant');
      const fallback = env.container.resolve<IStorageLayerFactory>('StorageLayerFactory');
      env.container.register('UserIdResolver', () => () => dbOptions.userId);
      env.container.replace<IStorageLayerFactory>('StorageLayerFactory', () => ({
        createForElement(type, options) {
          if (!(enabledTypes as readonly string[]).includes(type)) return fallback.createForElement(type, options);
          if (type === ElementType.MEMORY) {
            return new DatabaseStorageLayerFactory(db, () => dbOptions.userId).createForElement(type, options);
          }
          const layer = new DatabaseStorageLayer(db, () => dbOptions.userId, type);
          // A separate writer models external edits without mutating the reader index.
          layers.set(type as AllCountedType, new DatabaseStorageLayer(db, () => dbOptions.userId, type));
          return layer;
        },
      }));
    }
    const personas = env.container.resolve<PersonaManager>('PersonaManager');
    const skills = env.container.resolve<SkillManager>('SkillManager');
    const ensembles = env.container.resolve<EnsembleManager>('EnsembleManager');
    const agents = env.container.resolve<AgentManager>('AgentManager');
    const templates = env.container.resolve<TemplateManager>('TemplateManager');
    const memories = env.container.resolve<MemoryManager>('MemoryManager');
    const managers = {
      [ElementType.AGENT]: agents,
      [ElementType.TEMPLATE]: templates,
      [ElementType.MEMORY]: memories,
      [ElementType.PERSONA]: personas,
      [ElementType.SKILL]: skills,
      [ElementType.ENSEMBLE]: ensembles,
    };
    // The original fixture retains its three DB types; extended cases opt into all six.
    const handler = new ElementCRUDHandler(skills, env.container.resolve('TemplateManager'),
      env.container.resolve('TemplateRenderer'), env.container.resolve('AgentManager'),
      env.container.resolve('MemoryManager'), ensembles, personas, env.portfolioManager,
      env.container.resolve('InitializationService'), env.container.resolve('PersonaIndicatorService'),
      files, env.container.resolve('ElementQueryService'), env.container.resolve('ValidationRegistry'), new ActivationMetricsTracker(() => 'local-user'));
    const locations = new Map<string, string>();
    const key = (type: AllCountedType, index: number) => `${type}-${index.toString().padStart(2, '0')}`;
    const put = async (type: AllCountedType, index: number, edited = false) => {
      const name = key(type, index);
      if (type === ElementType.MEMORY) {
        if (edited) {
          const memory = await memories.findByName(name);
          if (!memory) throw new Error('Memory fixture missing');
          memory.instructions = 'Edited café body.';
          await memories.save(memory);
        } else {
          const memory = await memories.create({ name, description: 'Counting fixture', instructions: 'Original café body.' });
          locations.set(name, memory.getFilePath()!);
        }
        return;
      }
      const content = elementContent(type, index, edited);
      const layer = layers.get(type);
      if (layer) {
        const id = await layer.writeContent(type, name, content, { author: 'test', version: '1.0.0', tags: [], description: 'Counting fixture' });
        locations.set(name, id);
        // Keep scan comparisons independent of PostgreSQL sub-millisecond timestamps.
        await withUserContext(db!, dbOptions!.userId, tx => tx.update(schema.elements)
          .set({ updatedAt: new Date(edited ? '2100-01-01' : '2020-01-01') }).where(eq(schema.elements.id, id)));
      } else {
        const file = path.join(env.portfolioManager.getElementDir(type), `${name}.md`);
        await writeFile(file, content);
        // Explicit mtime avoids filesystem timestamp-resolution races; no sleeps.
        await utimes(file, new Date(1_700_000_000_000), new Date(edited ? 1_700_000_010_000 : 1_700_000_000_000));
        locations.set(name, file);
      }
    };
    return {
      counter, managers, put,
      details: (name: string, type: AllCountedType) => handler.getElementDetails(name, type),
      name: key,
      location: (type: AllCountedType, index: number) => {
        const location = locations.get(key(type, index));
        return location && mode === 'file' && type !== ElementType.MEMORY ? path.basename(location) : location;
      },
      seed: async (type: AllCountedType, count: number) => {
        if (type !== ElementType.MEMORY) {
          await Promise.all(Array.from({ length: count }, (_, index) => put(type, index)));
          return;
        }
        // MemoryManager.create() lists for duplicates before its queued save.
        // Finish each create before the next scan: file scans and save notifications
        // update the same index/manifest, so overlap makes fixture setup order-dependent.
        const next = async (index: number): Promise<void> => {
          if (index >= count) return;
          await put(type, index);
          await next(index + 1);
        };
        await next(0);
      },
      remove: async (type: AllCountedType, index: number) => {
        const location = locations.get(key(type, index));
        if (!location) throw new Error('Fixture does not exist');
        if (type === ElementType.MEMORY) { await memories.delete(location); return; }
        const layer = layers.get(type);
        if (layer) await layer.deleteContentByIdentity(type, location);
        else await unlink(location);
      },
      activate: async (type: CountedType | ElementType.AGENT, count: number) => {
        const activators = {
          [ElementType.AGENT]: agents.activateAgent.bind(agents),
          [ElementType.PERSONA]: personas.activatePersona.bind(personas),
          [ElementType.SKILL]: skills.activateSkill.bind(skills),
          [ElementType.ENSEMBLE]: ensembles.activateEnsemble.bind(ensembles),
        };
        // Activation mutates shared session state; preserve order instead of racing calls.
        await Array.from({ length: count }, (_, index) => key(type, index)).reduce(async (previous, name) => {
          await previous;
          const result = await activators[type](name);
          if (!result.success) throw new Error(result.message);
        }, Promise.resolve());
      },
      refresh: () => handler.getActiveElementsForPolicy({ allowCoalescing: false }),
      dispose,
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) {
      console.error('Counting fixture cleanup failed after construction failure', cleanupError);
    }
    throw error;
  }
}

/** Keep host watcher settings from injecting background reads into the measured operation. */
export async function cacheFixture(mode: Backend, dbOptions?: { url: string; userId: string }, extended = false) {
  const keys = ['DOLLHOUSE_ENABLE_FILE_WATCHER', 'AUTO_RELOAD_ON_EXTERNAL_CHANGE'] as const;
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { process.env[key] = 'false'; });
  const restore = () => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  try {
    const fixture = await buildCacheFixture(mode, dbOptions, extended);
    return { ...fixture, dispose: async () => {
      try { await fixture.dispose(); } finally { restore(); }
    } };
  } catch (error) {
    restore();
    throw error;
  }
}
