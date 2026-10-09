import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { ElementManagerDeps } from '../../../src/elements/base/BaseElementManager.js';
import { admittedMemoryContainer } from '../../helpers/storage/admitted-memory-container.js';
import { DatabaseTenantMemoryRegistry } from '../../../src/storage/DatabaseTenantMemoryRegistry.js';
import { DATABASE_MEMORY_ADMISSION_PROFILE } from '../../../src/storage/DatabaseMemoryAdmissionGate.js';
import { DATABASE_MEMORY_LEGACY_PROFILE } from '../../../src/storage/DatabaseMemoryLegacyMutationGuard.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';

const owned: { directory: string; dispose: () => Promise<void> }[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const f of owned.splice(0)) {
    try { await f.dispose(); } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tenant-memory-registry-'));
  const scope = new AsyncLocalStorage<string>();
  const first = randomUUID();
  const second = randomUUID();
  const modes = new Map<string, Record<string, unknown>[]>([first, second].map(tenant =>
    [tenant, [{ protocol_version: 1, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '1' }]]));
  let pause: Promise<void> | undefined;
  let role = { rolsuper: false, rolbypassrls: false };
  let failure: { cause: unknown } | undefined;
  const execute = jest.fn(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes('pg_roles')) return [role];
    if (compiled.sql.includes('memory_backend_modes')) {
      await pause;
      if (failure) throw failure.cause;
      return modes.get(String(compiled.params[0])) ?? [];
    }
    return [];
  });
  const transaction = jest.fn(async (body: (tx: { execute: typeof execute }) => Promise<unknown>) => body({ execute }));
  const db = { transaction } as unknown as DatabaseInstance;
  const getTenant = () => scope.getStore() ?? first;
  let template!: ElementManagerDeps;
  const root = admittedMemoryContainer(db, getTenant, directory, factory => incoming => {
    template = incoming; return factory.createAdmittedMemoryManager(incoming);
  });
  root.manager();
  owned.push({ directory, dispose: () => root.container.dispose() });
  const builds = jest.fn((factory: ElementManagerDeps['storageLayerFactory'], resolver: () => string) =>
    ({ ...template, storageLayerFactory: factory, getCurrentUserId: resolver }));
  const registry = new DatabaseTenantMemoryRegistry({ db, getEffectiveTenant: getTenant,
    createManagerDeps: builds, getAttribution: () => ({ contextRoot: 'trusted-test-root', sessionId: 'test-session', transport: 'http' }) });
  return { registry, db, scope, first, second, modes, builds, execute, transaction,
    setPause: (value: Promise<void>) => { pause = value; },
    setRole: (value: typeof role) => { role = value; },
    fail: (cause: unknown) => { failure = { cause }; } };
}

describe('private tenant memory composition', () => {
  it('shares one actual manager and initialization flight across concurrent same-tenant sessions', async () => {
    const f = await fixture(); const barrier = deferred(); f.setPause(barrier.promise);
    const a = f.scope.run(f.first, () => f.registry.resolve(f.registry.capture()));
    const b = f.scope.run(f.first, () => f.registry.resolve(f.registry.capture()));
    barrier.resolve(); const [left, right] = await Promise.all([a, b]);
    expect(left).toBe(right); expect(left.isGuardedHeadUpdateEnabled()).toBe(true);
    expect(f.builds).toHaveBeenCalledTimes(1); expect(f.transaction).toHaveBeenCalledTimes(1);
  });
  it('isolates actual manager/factory/resolver across concurrent different effective tenant scopes', async () => {
    const f = await fixture(); const barrier = deferred(); f.setPause(barrier.promise);
    const a = f.scope.run(f.first, () => f.registry.resolve(f.registry.capture()));
    const b = f.scope.run(f.second, () => f.registry.resolve(f.registry.capture()));
    barrier.resolve(); const [left, right] = await Promise.all([a, b]);
    expect(left).not.toBe(right); expect(f.builds).toHaveBeenCalledTimes(2);
    const [first, second] = f.builds.mock.calls;
    expect(first[0]).not.toBe(second[0]); expect(first[1]).not.toBe(second[1]);
    expect(f.scope.run(f.first, first[1])).toBe(f.first);
    expect(() => f.scope.run(f.second, first[1])).toThrow('binding');
  });
  it('uses an ordinary actual manager only for the explicit durable legacy tuple', async () => {
    const f = await fixture();
    f.modes.set(f.first, [{ protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'legacy', generation: '1' }]);
    const manager = await f.registry.resolve(f.registry.capture());
    expect(manager.isGuardedHeadUpdateEnabled()).toBe(false);
    await expect(f.registry.qualify(f.registry.capture(), async () => {})).rejects.toThrow('Legacy');
  });
  it.each([[], [{ protocol_version: 1, profile: DATABASE_MEMORY_LEGACY_PROFILE, mode: 'guarded', generation: '1' }],
    [{ protocol_version: 2, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '1' }],
    [{ protocol_version: 1, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '0' }],
    [{ protocol_version: 1, profile: DATABASE_MEMORY_ADMISSION_PROFILE, mode: 'guarded', generation: '9223372036854775808' }]].map(modes => ({ modes })))(
    'does not infer a mode or construct a manager from invalid state %j', async ({ modes }) => {
      const f = await fixture(); f.modes.set(f.first, modes);
      await expect(f.registry.resolve(f.registry.capture())).rejects.toThrow();
      await expect(f.registry.resolve(f.registry.capture())).rejects.toThrow();
      expect(f.builds).not.toHaveBeenCalled(); expect(f.transaction).toHaveBeenCalledTimes(1);
    });
  it('retains exact initialization failure despite audit and fallback observer exceptions', async () => {
    const f = await fixture(); const cause = new Error('private failure'); f.fail(cause);
    jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('sink'); });
    jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('logger'); });
    await expect(f.registry.resolve(f.registry.capture())).rejects.toBe(cause);
    await expect(f.registry.resolve(f.registry.capture())).rejects.toBe(cause);
    expect(f.transaction).toHaveBeenCalledTimes(1); expect(f.builds).not.toHaveBeenCalled();
  });
  it('refuses privileged mode reads and forged or cross-tenant captures', async () => {
    const f = await fixture(); f.setRole({ rolsuper: false, rolbypassrls: true });
    await expect(f.registry.resolve(f.registry.capture())).rejects.toThrow('Ordinary');
    expect(f.builds).not.toHaveBeenCalled();
    await expect(f.registry.resolve({ protocolVersion: 1 })).rejects.toThrow('Authentic');
    const capture = f.registry.capture();
    await expect(f.scope.run(f.second, () => f.registry.resolve(capture))).rejects.toThrow('binding');
  });
  it('closes a pending initialization without returning a manager or discarding its slot', async () => {
    const f = await fixture(); const barrier = deferred(); f.setPause(barrier.promise);
    const pending = f.registry.resolve(f.registry.capture());
    f.registry.close(); barrier.resolve();
    await expect(pending).rejects.toThrow('closed'); expect(f.builds).not.toHaveBeenCalled();
    expect(() => f.registry.capture()).toThrow('closed');
  });
  it('shares only an in-flight qualification and refuses a completed attempt instead of stale success', async () => {
    const f = await fixture(); const capture = f.registry.capture(); await f.registry.resolve(capture);
    const barrier = deferred(); const inspection = jest.fn(async () => { await barrier.promise; });
    const a = f.registry.qualify(capture, inspection);
    const b = f.registry.qualify(capture, inspection);
    barrier.resolve(); await Promise.all([a, b]);
    expect(inspection).toHaveBeenCalledTimes(1);
    await expect(f.registry.qualify(capture, inspection)).rejects.toThrow('already completed');
    expect(inspection).toHaveBeenCalledTimes(1);
  });
  it('invalidates a real pending boot qualification on stop without pretending it completed', async () => {
    const f = await fixture(); const capture = f.registry.capture(); await f.registry.resolve(capture);
    const entered = deferred(); const release = deferred();
    const pending = f.registry.qualify(capture, async () => { entered.resolve(); await release.promise; });
    await entered.promise; f.registry.close(); release.resolve();
    await expect(pending).rejects.toThrow('binding changed or closed');
    await expect(f.registry.resolve(capture)).rejects.toThrow('closed');
  });
});
