import fs from 'node:fs/promises';
import path from 'node:path';
import { FileDangerZoneBlockStore } from '../../src/state/FileDangerZoneBlockStore.js';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createIsolatedContainer } from '../helpers/integration-container.js';
import { AgentExecutionHandler } from '../../src/handlers/mcp-aql/AgentExecutionHandler.js';
import type { DangerZoneEnforcer } from '../../src/security/DangerZoneEnforcer.js';
import type { FileOperationsService } from '../../src/services/FileOperationsService.js';

async function guard(enforcer: DangerZoneEnforcer, method: string) {
  const prototype = AgentExecutionHandler.prototype as unknown as {
    ensureNotDangerZoneBlocked(method: string, name: string): Promise<void>;
  };
  await prototype.ensureNotDangerZoneBlocked.call({ handlers: { dangerZoneEnforcer: enforcer } }, method, 'agent');
}
afterEach(() => { jest.restoreAllMocks(); delete process.env.DOLLHOUSE_TEST_DEFERRED_DELAY_MS; });
describe('container block-state readiness', () => {
  it('holds the first agent call until deferred state is loaded', async () => {
    const env = await createIsolatedContainer();
    try {
      const fileOps = env.container.resolve<FileOperationsService>('FileOperationsService');
      const store = new FileDangerZoneBlockStore(fileOps, env.portfolioDir);
      env.container.register('DangerZoneBlockStore', () => store, { override: true });
      expect(store.location).toBe(path.join(env.portfolioDir, 'blocked-agents.json'));
      await fs.writeFile(store.location,
        JSON.stringify({ version: 1, blocks: { agent: { reason: 'Review required', blockedAt: '2026-01-01' } } })
      );
      const internals = env.container as unknown as { completeSinkSetup(): Promise<void>; completeConsoleSetup(): Promise<void>; deferredDangerZoneInit(): Promise<void> };
      jest.spyOn(internals, 'completeSinkSetup').mockImplementation(() => internals.deferredDangerZoneInit());
      jest.spyOn(internals, 'completeConsoleSetup').mockResolvedValue();
      process.env.DOLLHOUSE_TEST_DEFERRED_DELAY_MS = '40';
      const enforcer = env.container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      const deferred = env.container.completeDeferredSetup();
      try {
        await expect(guard(enforcer, 'execute')).rejects.toThrow(/blocked/);
        await expect(guard(enforcer, 'getState')).resolves.toBeUndefined();
        await expect(guard(enforcer, 'abort')).resolves.toBeUndefined();
      } finally { await deferred; }
      await expect(guard(enforcer, 'execute')).rejects.toThrow(/Review required/);
    } finally { await env.dispose(); }
  });
  it('retains unavailable state after deferred initialization', async () => {
    const env = await createIsolatedContainer();
    try {
      const fileOps = env.container.resolve<FileOperationsService>('FileOperationsService');
      const store = new FileDangerZoneBlockStore(fileOps, env.portfolioDir);
      env.container.register('DangerZoneBlockStore', () => store, { override: true });
      expect(store.location).toBe(path.join(env.portfolioDir, 'blocked-agents.json'));
      await fs.writeFile(store.location, '{}');
      jest.spyOn(fileOps, 'readFile').mockImplementation(async filename => {
        expect(filename).toBe(store.location);
        throw new Error('read failed');
      });
      const enforcer = env.container.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
      await (env.container as unknown as { deferredDangerZoneInit(): Promise<void> }).deferredDangerZoneInit();
      await expect(guard(enforcer, 'execute')).rejects.toThrow(/blocked/);
      await expect(guard(enforcer, 'getState')).resolves.toBeUndefined();
      await expect(guard(enforcer, 'abort')).resolves.toBeUndefined();
    } finally { await env.dispose(); }
  });
});

describe('block-store backend selection', () => {
  it('chooses the registered database backend at resolution time', async () => {
    const env = await createIsolatedContainer();
    try {
      const factory = env.container.resolve<import('../../src/state/IDangerZoneBlockStore.js').DangerZoneBlockStoreFactory>('DangerZoneBlockStoreFactory');
      const database = {};
      class Store {
        constructor(readonly db: unknown, readonly user: string) {}
      }
      env.container.register('DatabaseInstance', () => database);
      env.container.register('DatabaseDangerZoneBlockStoreClass', () => Store);
      const result = factory('user-id');
      expect(result).toBeInstanceOf(Store);
      expect(result).toMatchObject({ db: database, user: 'user-id' });
    } finally { await env.dispose(); }
  });
});
