import { describe, expect, it, jest } from '@jest/globals';
import { replaceElement } from '../../../../src/handlers/element-crud/replaceElement.js';
import type { ElementCrudContext } from '../../../../src/handlers/element-crud/types.js';

describe('replaceElement', () => {
  it('persists a freshly imported snapshot rather than deep-merging the existing element', async () => {
    const existing = {
      metadata: {
        name: 'Imported Persona',
        description: 'old description',
        staleSetting: 'must disappear',
      },
      filename: 'imported-persona.md',
    };
    const replacement = {
      metadata: { name: 'Imported Persona', description: 'new description' },
      instructions: 'new instructions',
      content: '',
    };
    const personaManager = {
      list: jest.fn(async () => [existing]),
      importElement: jest.fn(async () => replacement),
      validate: jest.fn(() => ({ valid: true })),
      save: jest.fn(async () => undefined),
      saveReplacement: jest.fn(async () => undefined),
    };
    const context = {
      ensureInitialized: jest.fn(async () => undefined),
      personaManager,
    } as unknown as ElementCrudContext;

    await replaceElement(context, {
      name: 'Imported Persona',
      type: 'personas',
      data: {
        name: 'Imported Persona',
        description: 'new description',
        instructions: 'new instructions',
      },
    });

    const serialized = personaManager.importElement.mock.calls[0]?.[0];
    expect(JSON.parse(serialized as string)).toEqual({
      name: 'Imported Persona',
      description: 'new description',
      instructions: 'new instructions',
      metadata: {
        name: 'Imported Persona',
        description: 'new description',
      },
    });
    expect(serialized).not.toContain('staleSetting');
    expect(personaManager.saveReplacement).toHaveBeenCalledWith(
      existing,
      replacement,
      'imported-persona.md',
    );
    expect(personaManager.save).not.toHaveBeenCalled();
    expect(existing.metadata.staleSetting).toBe('must disappear');
  });

  it('does not overwrite the existing element when the replacement fails validation', async () => {
    const existing = { metadata: { name: 'Invalid Import' }, filename: 'invalid-import.md' };
    const replacement = { metadata: { name: 'Invalid Import' } };
    const personaManager = {
      list: jest.fn(async () => [existing]),
      importElement: jest.fn(async () => replacement),
      validate: jest.fn(() => ({
        valid: false,
        errors: [{ field: 'description', message: 'description is invalid' }],
      })),
      save: jest.fn(async () => undefined),
      saveReplacement: jest.fn(async () => undefined),
    };
    const context = {
      ensureInitialized: jest.fn(async () => undefined),
      personaManager,
    } as unknown as ElementCrudContext;

    const result = await replaceElement(context, {
      name: 'Invalid Import',
      type: 'persona',
      data: { name: 'Invalid Import' },
    });

    expect(result.content[0]?.text).toContain('Imported replacement is invalid');
    expect(personaManager.save).not.toHaveBeenCalled();
  });

  it('sanitizes replacement metadata and preserves skill parameter definitions', async () => {
    const existing = { metadata: { name: 'Imported Skill' }, filename: 'imported-skill.md' };
    const replacement = { metadata: { name: 'Imported Skill' }, instructions: 'new instructions' };
    const skillManager = {
      list: jest.fn(async () => [existing]),
      importElement: jest.fn(async () => replacement),
      validate: jest.fn(() => ({ valid: true })),
      save: jest.fn(async () => undefined),
      saveReplacement: jest.fn(async () => undefined),
    };
    const context = {
      ensureInitialized: jest.fn(async () => undefined),
      skillManager,
    } as unknown as ElementCrudContext;

    const metadata = JSON.parse('{"description":"new description","constructor":{"polluted":true}}') as Record<string, unknown>;
    const parameters = [{ name: 'depth', type: 'number', description: 'Search depth' }];
    await replaceElement(context, {
      name: 'Imported Skill',
      type: 'skill',
      data: { metadata, parameters, instructions: 'new instructions' },
    });

    const serialized = skillManager.importElement.mock.calls[0]?.[0];
    expect(JSON.parse(serialized as string)).toEqual({
      metadata: {
        name: 'Imported Skill',
        description: 'new description',
        parameters,
      },
      parameters,
      instructions: 'new instructions',
    });
    expect(serialized).not.toContain('constructor');
  });

  it.each([
    ['omitted', {}, false],
    ['included', { state: { goals: [], decisions: [], context: {} } }, true],
  ] as const)('delegates %s agent state to snapshot replacement', async (_label, state, stateIncluded) => {
    const existing = { metadata: { name: 'Imported Agent' }, filename: 'imported-agent.md' };
    const replacement = { metadata: { name: 'Imported Agent' } };
    const agentManager = {
      list: jest.fn(async () => [existing]),
      importElement: jest.fn(async () => replacement),
      validate: jest.fn(() => ({ valid: true })),
      save: jest.fn(async () => undefined),
      saveReplacement: jest.fn(async () => undefined),
      replaceFromSnapshot: jest.fn(async () => undefined),
    };
    const context = {
      ensureInitialized: jest.fn(async () => undefined),
      agentManager,
    } as unknown as ElementCrudContext;

    await replaceElement(context, {
      name: 'Imported Agent',
      type: 'agents',
      data: { metadata: { description: 'replacement' }, ...state },
    });

    expect(agentManager.replaceFromSnapshot).toHaveBeenCalledWith(
      replacement,
      'imported-agent.md',
      { stateIncluded, expected: existing },
    );
    expect(agentManager.save).not.toHaveBeenCalled();
  });
});
