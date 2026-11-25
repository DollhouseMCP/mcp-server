/**
 * An edited name takes the element's own name rule (BaseElement.assignName), as a constructed or
 * loaded one does: the edit response, the instance and the stored definition carry the canonical
 * name the index holds.
 */
import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../../helpers/di-mocks.js';
import { editElement } from '../../../../src/handlers/element-crud/editElement.js';
import { ElementType } from '../../../../src/portfolio/types.js';
import { canonicalElementName } from '../../../../src/storage/ElementNameKeys.js';

const RAW = '  Café Notes  ';
const CANONICAL = canonicalElementName(RAW);

describe('editElement name assignment', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'edit-canonical-'));
    suite = createRealManagerSuite(root);
  });
  afterEach(async () => {
    await Promise.all([suite.skillManager, suite.templateManager, suite.agentManager, suite.ensembleManager, suite.memoryManager,
      suite.personaManager].map(manager => manager.dispose()));
    await rm(root, { recursive: true, force: true });
  });

  const context = () => {
    const managers: Record<string, unknown> = {
      [ElementType.PERSONA]: suite.personaManager, [ElementType.SKILL]: suite.skillManager, [ElementType.TEMPLATE]: suite.templateManager,
      [ElementType.AGENT]: suite.agentManager, [ElementType.MEMORY]: suite.memoryManager, [ElementType.ENSEMBLE]: suite.ensembleManager,
    };
    return { ...suite, ensureInitialized: async () => {}, getPersonaIndicator: () => '', getManagerForType: (type: string) => managers[type] } as never;
  };

  const creators: Record<string, () => Promise<unknown>> = {
    skills: () => suite.skillManager.create({ name: 'Edit Me', description: 'd', content: 'Follow these detailed instructions.' }),
    templates: () => suite.templateManager.create({ name: 'Edit Me', description: 'd', content: 'Template body {{x}}' }),
    // Agent creates take a hyphenated name; the edit may then rename it freely.
    agents: () => suite.agentManager.create('edit-me', 'd', 'Follow these detailed agent instructions.', {} as never),
    ensembles: () => suite.ensembleManager.create({ name: 'Edit Me', description: 'd', elements: [] } as never),
  };

  it('keeps the canonical form of the edit name text (sanity)', () => {
    expect(CANONICAL).not.toBe(RAW);
    expect(CANONICAL).toBe('Café Notes');
  });

  it.each(['skills', 'templates', 'agents', 'ensembles'] as const)('stores the canonical name for an edited %s', async type => {
    const manager = (suite as Record<string, any>)[`${type.slice(0, -1)}Manager`];
    const dir: string = manager['elementDir'];
    await mkdir(dir, { recursive: true });
    await creators[type]();
    const edited = await editElement(context(), { name: type === 'agents' ? 'edit-me' : 'Edit Me', type, input: { name: RAW } });
    const text = (edited as { content: Array<{ text: string }> }).content.map(part => part.text).join('\n');
    expect(text).toContain(CANONICAL);
    expect(text).not.toContain(RAW.trim());
    const instance = await manager.findByName(CANONICAL);
    expect(instance?.metadata.name).toBe(CANONICAL);
    const stored = await Promise.all((await readdir(dir)).filter(file => /\.(md|yaml)$/.test(file)).map(file => readFile(path.join(dir, file), 'utf8')));
    expect(stored.some(body => body.includes(`name: ${CANONICAL}`))).toBe(true);
    expect(stored.some(body => body.includes(RAW.trim()))).toBe(false);
  });
});
