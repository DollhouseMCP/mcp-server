import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { requireDatabaseMemoryStartupAdmission } from '../../../src/storage/DatabaseMemoryStartupAdmission.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

afterEach(() => { jest.restoreAllMocks(); });

const identity = { database: 'served-test', oid: '16384', address: '127.0.0.1', port: 5432, started: '2026-10-08T00:00:00Z' };
function fixture() {
  let mode = { catalog_known: true, invalid_modes: '0', protected_modes: '0' };
  let systemIdentity = { ...identity };
  let applicationIdentity = { ...identity };
  let bypass = true;
  const statements: string[] = [];
  const execute = jest.fn(async (query: SQL) => {
    const text = new PgDialect().sqlToQuery(query).sql; statements.push(text);
    if (text.includes('canBypassRls')) return [{ currentUser: 'system-test', canBypassRls: bypass }];
    if (text.includes('AS database')) return [systemIdentity];
    if (text.includes('invalid_modes')) return [mode];
    return [];
  });
  const systemDb = { transaction: async (body: (tx: { execute: typeof execute }) => Promise<unknown>) => body({ execute }) } as unknown as DatabaseInstance;
  const appExecute = jest.fn(async (query: SQL) => new PgDialect().sqlToQuery(query).sql.includes('AS database') ? [applicationIdentity] : []);
  const appDb = { transaction: async (body: (tx: { execute: typeof appExecute }) => Promise<unknown>) => body({ execute: appExecute }) } as unknown as DatabaseInstance;
  return { appDb, systemDb, statements, execute, setMode: (value: typeof mode) => { mode = value; },
    setIdentity: (value: typeof identity) => { systemIdentity = value; },
    setApplicationIdentity: (value: typeof identity) => { applicationIdentity = value; },
    setBypass: (value: boolean) => { bypass = value; } };
}
describe('configuration-independent whole database startup admission', () => {
  it('allows untouched known unprotected state with configuration off, using system and read-only observations', async () => {
    const f = fixture(); await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).resolves.toBeUndefined();
    expect(f.statements.some(text => text === 'SET TRANSACTION READ ONLY')).toBe(true);
    const query = f.statements.find(text => text.includes('invalid_modes'))!;
    expect(query).toContain('IS NOT TRUE'); expect(query).toContain('a.attnotnull'); expect(query).toContain('count(*) = 6');
  });
  it('blocks flag-off when any served tenant is guarded or read-only, while configured catalog acceptance is not boot admission', async () => {
    const f = fixture(); f.setMode({ catalog_known: true, invalid_modes: '0', protected_modes: '2' });
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).rejects.toThrow('startup');
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, true)).resolves.toBeUndefined();
  });
  it.each([{ catalog_known: false, invalid_modes: '0', protected_modes: '0' },
    { catalog_known: true, invalid_modes: '1', protected_modes: '0' },
    { catalog_known: true, invalid_modes: '0', protected_modes: 'unknown' }])('refuses corrupt or unknown catalog/mode observation %j', async mode => {
    const f = fixture(); f.setMode(mode);
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, true)).rejects.toThrow('startup');
  });
  it.each(['database', 'oid', 'address', 'port', 'started'] as const)('does not use another %s identity as authority over the served database', async key => {
    const f = fixture(); f.setIdentity({ ...identity, [key]: key === 'port' ? 5433 : 'different' });
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).rejects.toThrow('application database');
    expect(f.statements.some(text => text.includes('invalid_modes'))).toBe(false);
  });
  it('refuses ordinary role authority and preserves unavailable inspection cause', async () => {
    const f = fixture(); f.setBypass(false);
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).rejects.toThrow('BYPASSRLS');
    const g = fixture(); const cause = new Error('unavailable'); g.execute.mockRejectedValueOnce(cause);
    await expect(requireDatabaseMemoryStartupAdmission(g.appDb, g.systemDb, false)).rejects.toBe(cause);
  });
  it.each([{ address: null, port: null }, { address: undefined, port: undefined },
    { address: 'unresolved-host', port: 5432 }, { address: '127.0.0.1', port: 0 },
    { address: '127.0.0.1', port: 1.5 }, { database: '' }, { oid: '' }, { started: '' }])(
    'refuses unknown server/database identity facts %j', async fields => {
      const f = fixture(); const unknown = { ...identity, ...fields } as typeof identity;
      f.setIdentity(unknown); f.setApplicationIdentity(unknown);
      await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).rejects.toThrow('application database');
      expect(f.statements.some(text => text.includes('invalid_modes'))).toBe(false);
    });
  it.each([null, undefined, new Error('private unavailable schema')])('preserves exact startup cause despite dual observer failure', async cause => {
    const f = fixture(); f.execute.mockRejectedValueOnce(cause);
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('monitor'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('logger'); });
    await expect(requireDatabaseMemoryStartupAdmission(f.appDb, f.systemDb, false)).rejects.toBe(cause);
  });
});
