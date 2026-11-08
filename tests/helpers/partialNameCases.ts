/**
 * Partial names are not names: details, edit, delete and template activation resolve an element by
 * its exact, case-folded or slug name, never by a substring of it. Shared by the file and database
 * backend tests so both run the same cases.
 */
import { expect } from '@jest/globals';
import { SkillActivationStrategy } from '../../src/handlers/strategies/SkillActivationStrategy.js';
import { TemplateActivationStrategy } from '../../src/handlers/strategies/TemplateActivationStrategy.js';
import { deleteElement } from '../../src/handlers/element-crud/deleteElement.js';
import { editElement } from '../../src/handlers/element-crud/editElement.js';
import { ElementNotFoundError } from '../../src/utils/ErrorHandler.js';
import type { createRealManagerSuite } from './di-mocks.js';

type Suite = ReturnType<typeof createRealManagerSuite>;
const STORED = 'Code Reviewer';
const PARTIALS = ['review', 'code-rev', 'Code', 'reviewer'];
const textOf = (response: unknown) => ((response as { content?: Array<{ text?: string }> }).content ?? []).map(part => part.text ?? '').join('\n');

export async function expectPartialNamesRefused(suite: Suite): Promise<void> {
  await suite.skillManager.create({ name: STORED, description: 'Original description', content: 'Follow these detailed instructions.' });
  await suite.templateManager.create({ name: STORED, description: 'Template description', content: 'Hello {{name}}' });
  const managers: Record<string, unknown> = { skills: suite.skillManager, templates: suite.templateManager };
  const context = { ...suite, fileOperations: suite.fileOperationsService, ensureInitialized: async () => {}, getPersonaIndicator: () => '',
    getManagerForType: (type: string) => managers[type] } as never;
  const details = new SkillActivationStrategy(suite.skillManager);
  const templates = new TemplateActivationStrategy(suite.templateManager);
  // Every family refuses every partial name: each refusal is read-only, so they run together.
  const refusesAll = () => Promise.all(PARTIALS.map(async partial => {
    await expect(details.getElementDetails(partial)).rejects.toThrow(new ElementNotFoundError('Skill', partial).message);
    await expect(templates.activate(partial)).rejects.toThrow(new ElementNotFoundError('Template', partial).message);
    const edit = await editElement(context, { name: partial, type: 'skills', input: { description: 'Changed by a partial name' } })
      .then(textOf, (error: unknown) => (error as Error).message);
    expect([partial, edit]).toEqual([partial, expect.stringContaining('not found')]);
    const removal = await deleteElement(context, { name: partial, type: 'skills' }).then(textOf, (error: unknown) => (error as Error).message);
    expect([partial, removal]).toEqual([partial, expect.stringContaining('not found')]);
  }));
  suite.skillManager.clearCache();
  suite.templateManager.clearCache();
  await refusesAll();
  await refusesAll();
  // Nothing was edited or deleted; the slug form still resolves every family.
  expect((await suite.skillManager.findByName(STORED))?.metadata.description).toBe('Original description');
  await expect(details.getElementDetails('code-reviewer')).resolves.toHaveProperty('content');
  await expect(templates.activate('code-reviewer')).resolves.toHaveProperty('content');
  expect(textOf(await editElement(context, { name: 'code-reviewer', type: 'skills', input: { description: 'Changed by its slug' } })))
    .not.toContain('not found');
  expect((await suite.skillManager.findByName(STORED))?.metadata.description).toBe('Changed by its slug');
  expect(textOf(await deleteElement(context, { name: 'code-reviewer', type: 'skills' }))).toContain('Successfully deleted');
  await expect(suite.skillManager.findByName(STORED)).resolves.toBeUndefined();
}
