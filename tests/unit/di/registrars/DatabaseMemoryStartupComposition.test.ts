import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { DiContainerFacade } from '../../../../src/di/DiContainerFacade.js';

const originalEnv = (await import('../../../../src/config/env.js')).env;
const tenant = '10af0385-1c1e-4a81-8679-0a3432d73374';
let protectedModes = '0';
const statements: string[] = [];
const execute = jest.fn(async (query: SQL) => {
  const text = new PgDialect().sqlToQuery(query).sql; statements.push(text);
  if (text.includes('canBypassRls')) return [{ currentUser: 'system-test', canBypassRls: true }];
  if (text.includes('AS database')) return [{ database: 'served', oid: '16384', address: '127.0.0.1', port: 5432, started: '1' }];
  if (text.includes('invalid_modes')) return [{ catalog_known: true, invalid_modes: '0', protected_modes: protectedModes }];
  return [];
});
const db = { transaction: async (body: (tx: { execute: typeof execute }) => Promise<unknown>) => body({ execute }) } as unknown as DatabaseInstance;
const connection = { db, close: jest.fn(async () => {}) };
jest.unstable_mockModule('../../../../src/config/env.js', () => ({ env: {
  ...originalEnv, DOLLHOUSE_DATABASE_URL: 'postgres://test-only/served', DOLLHOUSE_DATABASE_ADMIN_URL: undefined,
  DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: undefined,
} }));
jest.unstable_mockModule('../../../../src/database/bootstrap.js', () => ({
  bootstrapDatabase: jest.fn(async () => ({ db, connection, userId: tenant })),
}));
const { DatabaseServiceRegistrar } = await import('../../../../src/di/registrars/DatabaseServiceRegistrar.js');
const { DatabaseTenantMemoryRegistry } = await import('../../../../src/storage/DatabaseTenantMemoryRegistry.js');
function container(): DiContainerFacade {
  const factories = new Map<string, () => unknown>([['ContextTracker', () => ({ getSessionContext: () => undefined })]]);
  const values = new Map<string, unknown>();
  return {
    register: (name, factory) => { factories.set(name, factory); values.delete(name); },
    resolve: <T>(name: string): T => {
      if (!values.has(name)) {
        const factory = factories.get(name); if (!factory) throw new Error(`Missing test service: ${name}`);
        values.set(name, factory());
      }
      return values.get(name) as T;
    },
    hasRegistration: name => factories.has(name),
  };
}
beforeEach(() => { protectedModes = '0'; statements.splice(0); execute.mockClear(); });
describe('actual database registrar configuration-off boundary', () => {
  it('refuses startup with no registry when durable protected state exists, before ordinary factory installation', async () => {
    const c = container(); protectedModes = '1';
    await expect(new DatabaseServiceRegistrar().bootstrapAndRegister(c)).rejects.toThrow('startup');
    expect(c.hasRegistration('StorageLayerFactory')).toBe(false);
    expect(statements.some(text => text.includes('invalid_modes'))).toBe(true);
  });
  it('preserves known never-admitted legacy startup only after its authoritative check', async () => {
    const c = container(); await new DatabaseServiceRegistrar().bootstrapAndRegister(c);
    expect(c.hasRegistration('StorageLayerFactory')).toBe(true);
    expect(statements.some(text => text.includes('invalid_modes'))).toBe(true);
  });
  it('rejects a structurally supplied or wrong-database registry without inspecting an unrelated database', async () => {
    const c = container(); c.register('DatabaseTenantMemoryRegistry', () => ({ matchesDatabase: () => true }));
    await expect(new DatabaseServiceRegistrar().bootstrapAndRegister(c)).rejects.toThrow('actual application database');
    const other = {} as DatabaseInstance;
    const registry = new DatabaseTenantMemoryRegistry({ db: other, getEffectiveTenant: () => tenant,
      createManagerDeps: () => { throw new Error('Must not initialize'); },
      getAttribution: () => ({ contextRoot: 'test', sessionId: null, transport: 'stdio' }) });
    const d = container(); d.register('DatabaseTenantMemoryRegistry', () => registry);
    await expect(new DatabaseServiceRegistrar().bootstrapAndRegister(d)).rejects.toThrow('actual application database');
    expect(statements.some(text => text.includes('invalid_modes'))).toBe(false);
  });
});
