import { describe, expect, it, jest } from '@jest/globals';
import { DollhouseContainer } from '../../src/di/Container.js';
import { registerDatabaseConnectionLifecycleOwners } from '../../src/di/registrars/DatabaseServiceRegistrar.js';

describe('database connection lifecycle wiring', () => {
  it('closes distinct application and system connection owners exactly once', async () => {
    const applicationConnection = { db: {}, close: jest.fn<() => Promise<void>>().mockResolvedValue() };
    const systemConnection = { db: {}, close: jest.fn<() => Promise<void>>().mockResolvedValue() };
    const container = new DollhouseContainer();

    registerDatabaseConnectionLifecycleOwners(container, applicationConnection, systemConnection);
    await container.dispose();

    expect(applicationConnection.close).toHaveBeenCalledTimes(1);
    expect(systemConnection.close).toHaveBeenCalledTimes(1);
  });

  it('closes a shared application/system connection owner exactly once', async () => {
    const sharedConnection = { db: {}, close: jest.fn<() => Promise<void>>().mockResolvedValue() };
    const container = new DollhouseContainer();

    registerDatabaseConnectionLifecycleOwners(container, sharedConnection, sharedConnection);
    await container.dispose();

    expect(sharedConnection.close).toHaveBeenCalledTimes(1);
  });
});
