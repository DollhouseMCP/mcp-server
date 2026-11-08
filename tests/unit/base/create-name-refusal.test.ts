/**
 * One duplicate-name refusal for every type (BaseElementManager.assertNameAvailable): the same
 * rule and the same message, naming the stored name when it differs from the requested text.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../helpers/di-mocks.js';

describe('duplicate-name refusal', () => {
  it('gives every type the one message, the agent create included', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-name-refusal-'));
    const suite = createRealManagerSuite(root);
    const managers = [['skill', suite.skillManager], ['template', suite.templateManager], ['persona', suite.personaManager],
      ['ensemble', suite.ensembleManager], ['agent', suite.agentManager], ['memory', suite.memoryManager]] as const;
    try {
      for (const [label, manager] of managers) {
        jest.spyOn(manager as any, 'nameTakenBy').mockResolvedValue('Stored Name');
        const article = /^[aeiou]/u.test(label) ? 'An' : 'A';
        await expect((manager as any).duplicateNameRefusal('stored name')).resolves
          .toBe(`${article} ${label} named "stored name" already exists (stored as "Stored Name")`);
        await expect((manager as any).assertNameAvailable('Stored Name')).rejects.toThrow(`${article} ${label} named "Stored Name" already exists`);
      }
      const agent = await suite.agentManager.create('stored-name', 'An agent description', 'Follow these detailed agent instructions.', {} as never);
      expect(agent).toMatchObject({ success: false, message: 'An agent named "stored-name" already exists (stored as "Stored Name")' });
    } finally {
      await Promise.all(managers.map(([, manager]) => manager.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a second create of a stored name through each real manager, with the one message', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-name-refusal-real-'));
    const suite = createRealManagerSuite(root);
    const body = { description: 'Duplicate refusal fixture', content: 'Follow these detailed instructions.' };
    const creates: Array<[string, () => Promise<unknown>]> = [
      ['skill', () => suite.skillManager.create({ name: 'Stored Name', ...body })],
      ['template', () => suite.templateManager.create({ name: 'Stored Name', ...body })],
      ['persona', () => suite.personaManager.create({ name: 'Stored Name', ...body, instructions: 'You are a careful assistant persona.' })],
      ['ensemble', () => suite.ensembleManager.create({ name: 'Stored Name', ...body, elements: [] })],
      ['memory', () => suite.memoryManager.create({ name: 'Stored Name', ...body })],
    ];
    try {
      for (const [label, create] of creates) {
        await create();
        const article = /^[aeiou]/u.test(label) ? 'An' : 'A';
        await expect(create()).rejects.toThrow(`${article} ${label} named "Stored Name" already exists`);
      }
      expect(await suite.agentManager.create('stored-agent', 'An agent description', 'Follow these detailed agent instructions.', {} as never))
        .toMatchObject({ success: true });
      expect(await suite.agentManager.create('stored-agent', 'An agent description', 'Follow these detailed agent instructions.', {} as never))
        .toMatchObject({ success: false, message: 'An agent named "stored-agent" already exists' });
    } finally {
      await Promise.all([suite.skillManager, suite.templateManager, suite.personaManager, suite.ensembleManager,
        suite.agentManager, suite.memoryManager].map(manager => manager.dispose()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
