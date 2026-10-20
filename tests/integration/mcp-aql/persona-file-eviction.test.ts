import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import path from 'node:path';
import { ElementType } from '../../../src/portfolio/types.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { FileActivationStateStore } from '../../../src/state/FileActivationStateStore.js';
import { createIntegrationContainer } from '../../helpers/integration-container.js';

describe('File persona recovery by activation filename', () => {
  let env: Awaited<ReturnType<typeof createIntegrationContainer>>;
  let manager: PersonaManager;

  beforeEach(async () => {
    env = await createIntegrationContainer();
    manager = env.container.resolve<PersonaManager>('PersonaManager');
  });
  afterEach(async () => { jest.restoreAllMocks(); await env.dispose(); });

  async function put(index: number, edited = false) {
    const name = `file-policy-${index}`;
    const file = path.join(env.portfolioManager.getElementDir(ElementType.PERSONA), `${name}.md`);
    await writeFile(file, `---\nname: ${name}\ndescription: Policy fixture\ngatekeeper:\n  deny: [delete_element]\n---\n${edited ? 'Edited' : 'Original'} instructions.\n`);
    const stamp = new Date(edited ? '2100-01-01' : '2000-01-01');
    await utimes(file, stamp, stamp);
    return name;
  }

  it('guards dotted display-name compatibility when probing storage identity', async () => {
    const name = 'Finance v2.0';
    await writeFile(
      path.join(env.portfolioManager.getElementDir(ElementType.PERSONA), 'finance-v2-0.md'),
      `---\nname: ${name}\ndescription: Finance policy\n---\nFinance instructions.\n`,
    );
    await manager.refreshIndex({ freshAfterInFlight: true });
    expect((await manager.findByName(name))?.metadata.name).toBe(name);
    manager.clearCache();
    await manager.refreshIndex({ freshAfterInFlight: true });
    expect((await manager.findPersonaAsync(name))?.metadata.name).toBe(name);
    expect(manager.getCacheMissMetrics().diskFailures).toBe(0);
  });

  it('activates a user-supplied filename from a cold cache', async () => {
    const name = await put(0);
    await manager.refreshIndex({ freshAfterInFlight: true });
    expect(manager.findPersona(name)).toBeUndefined();
    const result = await manager.activatePersona(`${name}.md`);
    expect(result.success).toBe(true);
    expect(result.persona?.metadata.name).toBe(name);
    expect(manager.getActivePersonaIds()).toEqual([`${name}.md`]);
  });

  it.each([1, 10])('recovers %i active personas on the first lookup after eviction', async count => {
    const names = await Promise.all(Array.from({ length: count }, (_, index) => put(index)));
    await manager.list();
    await names.reduce(async (previous, name) => {
      await previous;
      expect((await manager.activatePersona(name)).success).toBe(true);
    }, Promise.resolve());
    manager.clearCache();
    await manager.refreshIndex({ freshAfterInFlight: true });
    expect(await manager.resolveActivePersonas()).toHaveLength(count);
  });

  it('retains the edited active persona after its refresh eviction', async () => {
    const name = await put(0);
    await manager.list();
    expect((await manager.activatePersona(name)).success).toBe(true);
    await put(0, true);
    await manager.refreshIndex({ freshAfterInFlight: true });
    const active = await manager.resolveActivePersonas();
    expect(active).toHaveLength(1);
    expect(active[0].instructions).toContain('Edited');
    expect(active[0].metadata.gatekeeper).toEqual({ deny: ['delete_element'] });
  });

  it('restores a persisted filename in a fresh container without pruning it', async () => {
    const name = await put(0);
    expect((await manager.activatePersona(name)).success).toBe(true);
    const filename = (await manager.findPersonaAsync(name))!.filename;
    const stateDir = path.join(env.portfolioDir, 'state');
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, 'activations-file-restore.json'), JSON.stringify({
      version: 1, sessionId: 'file-restore', lastUpdated: '2026-10-20T00:00:00.000Z',
      activations: { persona: [{ name, filename, activatedAt: '2026-10-20T00:00:00.000Z' }] },
    }));
    const restarted = await createIntegrationContainer({ portfolioDir: env.portfolioDir });
    try {
      const freshManager = restarted.container.resolve<PersonaManager>('PersonaManager');
      const store = new FileActivationStateStore(restarted.container.resolve('FileOperationsService'), stateDir, 'file-restore');
      await store.initialize();
      expect(store.isEnabled()).toBe(true);
      const prune = jest.spyOn(store, 'removeStaleActivation');
      expect(freshManager.getActivePersonas()).toHaveLength(0);
      expect(freshManager.findPersona(name)).toBeUndefined();
      await restarted.container['restoreActivations'](store);
      expect({ pruned: prune.mock.calls.length, active: freshManager.getActivePersonas().length })
        .toEqual({ pruned: 0, active: 1 });
      expect(store.getActivations('persona')).toHaveLength(1);
    } finally { await restarted.dispose(); }
  });
});
