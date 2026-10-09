import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { DatabaseMemoryStorageLayer } from '../../../src/storage/DatabaseMemoryStorageLayer.js';
import { DatabaseStorageLayerFactory } from '../../../src/storage/DatabaseStorageLayerFactory.js';
import { DatabaseMemoryModeEnforcingStorageLayerFactory } from '../../../src/storage/DatabaseMemoryModeEnforcingStorageLayerFactory.js';
import { DATABASE_MEMORY_LEGACY_PROFILE as profile } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

function fixture() {
  let tenant = randomUUID();
  const owner = randomUUID();
  let modes: Record<string, unknown>[] = [{ protocol_version: 1, profile, mode: 'legacy', generation: '1' }];
  let role = { rolsuper: false, rolbypassrls: false };
  let afterMode: (() => void) | undefined;
  let bodyFailure: unknown;
  let failBody = false;
  let settled = false;
  const statements: string[] = [];
  const writes: string[] = [];
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const name of ['from', 'where', 'limit', 'returning', 'onConflictDoUpdate', 'onConflictDoNothing']) {
      value[name] = () => value;
    }
    value.values = () => value;
    value.set = () => value;
    value.then = (resolve: (rows: unknown[]) => unknown, reject: (cause: unknown) => unknown) =>
      (failBody ? Promise.reject(bodyFailure) : Promise.resolve(rows)).then(resolve, reject);
    return value;
  };
  const tx = {
    execute: jest.fn(async (query: SQL) => {
      const statement = new PgDialect().sqlToQuery(query).sql;
      statements.push(statement);
      if (statement.includes('pg_roles')) return [role];
      if (statement.includes('memory_backend_modes')) { const result = modes; afterMode?.(); return result; }
      return [];
    }),
    delete: jest.fn(() => { writes.push('delete'); return chain([{ id: owner }]); }),
    insert: jest.fn(() => { writes.push('insert'); return chain([{ id: owner }]); }),
    update: jest.fn(() => { writes.push('update'); return chain([{ id: owner }]); }),
    select: jest.fn(() => chain([{ id: owner, name: 'head', revision: 1n }])),
  };
  const transaction = jest.fn(async (body: (value: typeof tx) => Promise<unknown>) => {
    settled = false;
    try { return await body(tx); } finally { settled = true; }
  });
  const db = { transaction } as unknown as DatabaseInstance;
  const resolver = () => tenant;
  const factory = new DatabaseMemoryModeEnforcingStorageLayerFactory(db, resolver);
  const store = factory.createForElement('memories', { elementDir: '/unused', fileExtension: '.yaml', scanCooldownMs: 0 }) as DatabaseMemoryStorageLayer;
  return { store, factory, tx, db, resolver, owner, statements, writes, transaction,
    setModes: (value: typeof modes) => { modes = value; },
    setRole: (value: typeof role) => { role = value; },
    changeTenant: () => { tenant = randomUUID(); },
    afterMode: (value: () => void) => { afterMode = value; },
    failBody: (cause: unknown) => { failBody = true; bodyFailure = cause; },
    settled: () => settled };
}

afterEach(() => { jest.restoreAllMocks(); });
const operations = ['raw-write', 'ordinary-cas', 'child-add', 'child-remove', 'expiry-purge', 'identity-delete', 'delete'] as const;
async function invoke(f: ReturnType<typeof fixture>, operation: typeof operations[number]) {
  switch (operation) {
    case 'raw-write': return f.store.writeContent('memories', 'head', 'metadata:\n  name: head\nentries: []', { author: '', version: '1', description: '', tags: [] });
    case 'ordinary-cas': return f.store.writeHeadIfCurrent({ backend: 'database', userId: f.resolver(), ownerId: f.owner, locator: f.owner, name: 'head', revision: '1' }, 'head', 'metadata:\n  name: head\nentries: []', { author: '', version: '1', description: '', tags: [] });
    case 'child-add': return f.store.addEntry(f.owner, { entryId: 'entry', timestamp: new Date(), content: 'entry' });
    case 'child-remove': return f.store.removeEntry(f.owner, 'entry');
    case 'expiry-purge': return f.store.purgeExpiredEntries();
    case 'identity-delete': return f.store.deleteContentByIdentity('memories', 'head');
    case 'delete': return f.store.deleteContent('memories', 'head');
  }
}

describe('dormant explicit legacy database mutation permission', () => {
  it.each(operations)('denies %s through the actual enforcing factory before any DML', async operation => {
    const f = fixture(); f.setModes([{ protocol_version: 1, profile: 'existing-owner-archive-free-update-v1', mode: 'guarded', generation: '1' }]);
    const observations: boolean[] = [];
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { observations.push(f.settled()); });
    await expect(invoke(f, operation)).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(f.writes).toEqual([]);
    expect(events).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([true]);
    expect(events.mock.calls[0][0]).toMatchObject({ type: 'OPERATION_FAILED', source: 'DatabaseMemoryLegacyMutationGuard' });
    expect(f.statements.at(-1)).toContain('FOR SHARE');
  });
  it.each([[], [{ protocol_version: 1, profile, mode: 'read_only', generation: '1' }],
    [{ protocol_version: 2, profile, mode: 'legacy', generation: '1' }],
    [{ protocol_version: 1, profile: 'unknown', mode: 'legacy', generation: '1' }],
    ...['0', '-1', '1x', '9223372036854775808'].map(generation => [{ protocol_version: 1, profile, mode: 'legacy', generation }])].map(modes => ({ modes })))(
    'does not infer legacy from missing or unsupported mode %j', async ({ modes }) => {
      const f = fixture(); f.setModes(modes); await expect(f.store.removeEntry(f.owner, 'entry')).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
      expect(f.writes).toEqual([]);
    });
  it('allows explicit legacy child mutation only in the mode-lock transaction', async () => {
    const f = fixture(); await f.store.removeEntry(f.owner, 'entry');
    expect(f.writes).toEqual(['delete']); expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.statements.some(value => value.includes('FOR SHARE'))).toBe(true);
  });
  it('fails closed on tenant drift after mode read before DML', async () => {
    const f = fixture(); f.afterMode(f.changeTenant);
    await expect(f.store.removeEntry(f.owner, 'entry')).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(f.writes).toEqual([]);
  });
  it('refuses privileged role and unavailable mode queries without fallback', async () => {
    const f = fixture(); f.setRole({ rolsuper: true, rolbypassrls: false });
    await expect(f.store.removeEntry(f.owner, 'entry')).rejects.toMatchObject({ code: 'EMEMORYLEGACYDENIED' });
    expect(f.writes).toEqual([]);
    const g = fixture(); const cause = new Error('private unavailable relation');
    g.tx.execute.mockRejectedValueOnce(cause);
    await expect(g.store.removeEntry(g.owner, 'entry')).rejects.toBe(cause); expect(g.writes).toEqual([]);
  });
  it.each([null, undefined, new Error('private SQL failure')])('preserves primitive or object body cause despite dual observer failure', async cause => {
    const f = fixture(); f.failBody(cause);
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('monitor'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('logger'); });
    await expect(f.store.removeEntry(f.owner, 'entry')).rejects.toBe(cause);
  });
  it('preserves default unwired legacy and non-memory factory compatibility without calling it protection', async () => {
    const f = fixture(); f.setModes([]);
    const old = new DatabaseStorageLayerFactory(f.db, f.resolver).createForElement('memories', { elementDir: '/unused', fileExtension: '.yaml', scanCooldownMs: 0 }) as DatabaseMemoryStorageLayer;
    await old.removeEntry(f.owner, 'entry'); expect(f.writes).toEqual(['delete']);
    expect(f.statements.some(value => value.includes('memory_backend_modes'))).toBe(false);
    expect(f.factory.createForElement('skills', { elementDir: '/unused', fileExtension: '.yaml', scanCooldownMs: 0 })).not.toBeInstanceOf(DatabaseMemoryStorageLayer);
  });
});
