import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InitializationService } from '../../../src/services/InitializationService.js';
import type { PersonaManager } from '../../../src/persona/PersonaManager.js';

describe('InitializationService', () => {
  let personaManager: jest.Mocked<Pick<PersonaManager, 'initialize'>>;

  beforeEach(() => {
    personaManager = {
      initialize: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('initializes persona manager on first call', async () => {
    const service = new InitializationService(
      personaManager as unknown as PersonaManager
    );

    await service.ensureInitialized();

    expect(personaManager.initialize).toHaveBeenCalledTimes(1);
  });

  it('does not re-run initialization when already initialized', async () => {
    const service = new InitializationService(
      personaManager as unknown as PersonaManager
    );

    await service.ensureInitialized();
    await service.ensureInitialized();

    expect(personaManager.initialize).toHaveBeenCalledTimes(1);
  });

  it('shares a single initialization promise across callers', async () => {
    const deferred: { resolve?: () => void } = {};
    personaManager.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          deferred.resolve = resolve;
        })
    );

    const service = new InitializationService(
      personaManager as unknown as PersonaManager
    );

    const firstCall = service.ensureInitialized();
    const secondCall = service.ensureInitialized();

    expect(personaManager.initialize).toHaveBeenCalledTimes(1);

    deferred.resolve?.();
    await Promise.all([firstCall, secondCall]);
  });

  it('allows re-initialization after dispose', async () => {
    const service = new InitializationService(
      personaManager as unknown as PersonaManager
    );

    await service.ensureInitialized();
    await service.dispose();

    personaManager.initialize.mockClear();

    await service.ensureInitialized();
    expect(personaManager.initialize).toHaveBeenCalledTimes(1);
  });

  it('does not memoize failures', async () => {
    const error = new Error('init failed');
    personaManager.initialize
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    const service = new InitializationService(
      personaManager as unknown as PersonaManager
    );

    await expect(service.ensureInitialized()).rejects.toThrow(error);
    await service.ensureInitialized();

    expect(personaManager.initialize).toHaveBeenCalledTimes(2);
  });
});
