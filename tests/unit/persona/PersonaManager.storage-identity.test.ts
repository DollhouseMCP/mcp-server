import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createIntegrationContainer } from '../../helpers/integration-container.js';
import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { PersonaElement } from '../../../src/persona/PersonaElement.js';

describe('PersonaManager lookup order with mocked lookups', () => {
  let env: Awaited<ReturnType<typeof createIntegrationContainer>>;
  let manager: PersonaManager;
  const identity = 'guard.md';

  beforeEach(async () => {
    env = await createIntegrationContainer();
    manager = env.container.resolve<PersonaManager>('PersonaManager');
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await env.dispose();
  });

  it('resolves a stored identity before attempting a name lookup', async () => {
    const persona = new PersonaElement({ name: 'guard' }, 'Protect deletion.', identity,
      env.container.resolve('MetadataService'));
    const byIdentity = jest.spyOn(manager, 'findByStorageIdentity').mockResolvedValue(persona);
    const byName = jest.spyOn(manager, 'findByName').mockResolvedValue(undefined);
    expect(await manager.findPersonaAsync(identity)).toBe(persona);
    expect(byIdentity).toHaveBeenCalledWith(identity);
    expect(byName).not.toHaveBeenCalled();
  });

  it('falls back to name lookup when storage identity is absent', async () => {
    const persona = new PersonaElement({ name: 'guard' }, 'Protect deletion.', identity,
      env.container.resolve('MetadataService'));
    const byIdentity = jest.spyOn(manager, 'findByStorageIdentity').mockResolvedValue(undefined);
    const byName = jest.spyOn(manager, 'findByName').mockResolvedValue(persona);
    expect(await manager.findPersonaAsync('guard')).toBe(persona);
    expect(byName).toHaveBeenCalledWith('guard');
    expect(byIdentity).toHaveBeenCalledWith('guard');
    expect(byIdentity.mock.invocationCallOrder[0]).toBeLessThan(byName.mock.invocationCallOrder[0]);
  });

  it('returns undefined when neither identity nor name exists', async () => {
    const byIdentity = jest.spyOn(manager, 'findByStorageIdentity').mockResolvedValue(undefined);
    const byName = jest.spyOn(manager, 'findByName').mockResolvedValue(undefined);
    await expect(manager.findPersonaAsync(identity)).resolves.toBeUndefined();
    expect(byIdentity).toHaveBeenCalledWith(identity);
    expect(byName).toHaveBeenCalledWith(identity);
  });

  it('keeps active-persona lookup sequential and returns activation order', async () => {
    const first = new PersonaElement({ name: 'first' }, 'First instructions.', 'first.md',
      env.container.resolve('MetadataService'));
    const second = new PersonaElement({ name: 'second' }, 'Second instructions.', 'second.md',
      env.container.resolve('MetadataService'));
    const lookup = jest.spyOn(manager, 'findPersonaAsync')
      .mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await manager.activatePersona('first');
    await manager.activatePersona('second');
    lookup.mockReset();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    lookup.mockImplementationOnce(async () => { entered(); await blocked; return first; })
      .mockResolvedValueOnce(second);
    const result = manager.resolveActivePersonas();
    await started;
    try {
      expect(lookup.mock.calls).toEqual([['first.md']]);
    } finally { release(); }
    expect(await result).toEqual([first, second]);
    expect(lookup.mock.calls).toEqual([['first.md'], ['second.md']]);
  });

  async function blockFirstActiveLookup() {
    const personas = ['first', 'second', 'third'].map(name => {
      const persona = new PersonaElement({ name }, `${name} instructions.`, `${name}.md`,
        env.container.resolve('MetadataService'));
      manager['cacheElement'](persona, persona.filename);
      return persona;
    });
    await manager.activatePersona('first');
    await manager.activatePersona('second');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const lookup = jest.spyOn(manager, 'findPersonaAsync').mockImplementation(async identifier => {
      if (identifier === 'first.md') { entered(); await blocked; }
      return manager.findPersona(identifier);
    });
    const result = manager.resolveActivePersonas();
    await started;
    return { personas, lookup, result, release };
  }

  it('skips a live-set member deactivated while the first lookup is blocked', async () => {
    const { personas, lookup, result, release } = await blockFirstActiveLookup();
    try {
      expect(manager.deactivatePersona('second').success).toBe(true);
    } finally { release(); }
    expect(await result).toEqual([personas[0]]);
    expect(lookup.mock.calls).toEqual([['first.md']]);
  });

  it('includes a live-set member activated while the first lookup is blocked', async () => {
    const { personas, lookup, result, release } = await blockFirstActiveLookup();
    try {
      expect((await manager.activatePersona('third')).success).toBe(true);
    } finally { release(); }
    expect(await result).toEqual(personas);
    expect(lookup.mock.calls).toEqual([['first.md'], ['third'], ['second.md'], ['third.md']]);
  });
});

describe('Invalid file storage identities', () => {
  it.each(['../outside.md', '/tmp/outside.md'])(
    'retains path validation for %s without a name fallback', async identifier => {
      const env = await createIntegrationContainer();
      try {
        const manager = env.container.resolve<PersonaManager>('PersonaManager');
        await expect(manager.findByStorageIdentity(identifier)).rejects.toThrow();
        const byName = jest.spyOn(manager, 'findByName').mockResolvedValue(undefined);
        await expect(manager.findPersonaAsync(identifier)).resolves.toBeUndefined();
        expect(byName).not.toHaveBeenCalled();
        expect(manager.getCacheMissMetrics().diskFailures).toBe(1);
      } finally { jest.restoreAllMocks(); await env.dispose(); }
    });
});
