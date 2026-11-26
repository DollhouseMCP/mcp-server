import { afterEach, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { env } from '../../../src/config/env.js';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { FileDangerZoneBlockStore } from '../../../src/state/FileDangerZoneBlockStore.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../../src/services/FileOperationsService.js';
import { logger } from '../../../src/utils/logger.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { createHttpSession } from '../../../src/context/HttpSession.js';

const { bootstrapWebContainer } = await import('../../../src/index.js');

interface Boundary {
  migrateLegacyDangerZoneBlocks(): Promise<void>;
  deferredDangerZoneInit(): Promise<void>;
  getUserDangerZoneEnforcer(userId: string, directory: string): Promise<DangerZoneEnforcer>;
}
const originalBackend = env.DOLLHOUSE_STORAGE_BACKEND;
afterEach(() => { jest.restoreAllMocks(); env.DOLLHOUSE_STORAGE_BACKEND = originalBackend; });
it('holds initialization and HTTP session creation until migration completes', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  const container = new DollhouseContainer();
  const boundary = container as unknown as Boundary;
  let release!: () => void;
  const migration = jest.spyOn(boundary, 'migrateLegacyDangerZoneBlocks').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const initialize = jest.fn<() => Promise<void>>().mockResolvedValue();
  const shutdown = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const factory = jest.fn(() => ({ load: async () => ({ status: 'absent' as const }) }));
  container.register('DangerZoneEnforcer', () => ({ initialize, shutdown }), { override: true });
  container.register('DangerZoneBlockStoreFactory', () => factory, { override: true });
  const root = boundary.deferredDangerZoneInit();
  const user = boundary.getUserDangerZoneEnforcer('fixture', path.join(os.tmpdir(), 'unused'));
  let sessionSettled = false;
  const session = container.createServerForHttpSession(createHttpSession({ userId: 'fixture' }))
    .catch(error => { sessionSettled = true; return error as Error; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(initialize).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled();
    expect(sessionSettled).toBe(false); expect(migration).toHaveBeenCalledTimes(1);
    release();
    await root; await user;
    expect(await session).toEqual(expect.objectContaining({ message: expect.stringContaining('HTTP handler bundle not initialized') }));
    expect(initialize).toHaveBeenCalledTimes(1); expect(factory).toHaveBeenCalledTimes(1);
  } finally { release(); await container.dispose(); }
  expect(shutdown).toHaveBeenCalledTimes(1);
});
it('reads the file in place without invoking migration in file mode', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'file';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'block-file-startup-'));
  const filename = path.join(directory, 'blocked-agents.json');
  const content = JSON.stringify({ version: 1, blocks: { agent: { reason: 'Review required', blockedAt: new Date(0).toISOString() } } });
  await fs.writeFile(filename, content);
  const container = new DollhouseContainer();
  const boundary = container as unknown as Boundary;
  const migration = jest.spyOn(boundary, 'migrateLegacyDangerZoneBlocks');
  const enforcer = new DangerZoneEnforcer(new FileDangerZoneBlockStore(new FileOperationsService(new FileLockManager()), directory));
  container.register('DangerZoneEnforcer', () => enforcer, { override: true });
  try {
    await boundary.deferredDangerZoneInit();
    expect(migration).not.toHaveBeenCalled();
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, reason: 'Review required' });
    expect(await fs.readFile(filename, 'utf8')).toBe(content);
    expect(await fs.readdir(directory)).toEqual(['blocked-agents.json']);
  } finally { await container.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
});

it('propagates migration setup failures through web bootstrap', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  const { DangerZoneBlockMigrationError } = await import('../../../src/storage/migration/DangerZoneBlockMigrationError.js');
  const cause = new Error('Database setup unavailable');
  const logs = jest.spyOn(logger, 'error');
  const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  jest.spyOn(DollhouseContainer.prototype, 'preparePortfolio').mockImplementation(async function (this: DollhouseContainer) {
    this.register('SystemDatabaseInstance', () => { throw cause; }, { override: true });
    this.register('DatabaseInstance', () => ({}), { override: true });
    await (this as unknown as Boundary).migrateLegacyDangerZoneBlocks();
  });
  const handlers = jest.spyOn(DollhouseContainer.prototype, 'bootstrapHandlers');
  const failure = await bootstrapWebContainer().catch(error => error as Error);
  expect(failure).toBeInstanceOf(DangerZoneBlockMigrationError);
  expect(failure).toMatchObject({ message: expect.stringContaining('setup (resolving SystemDatabaseInstance)') });
  const message = (failure as Error).message;
  expect(message).toContain('could not initialize the blocked-agent import');
  expect(message).toContain('then restart');
  expect(message).toContain('docs/security/architecture.md (Blocked-agent persistence)');
  expect((failure as Error).cause).toBe(cause);
  expect(logs.mock.calls.filter(([text]) => text === 'Legacy block state import failed')).toHaveLength(1);
  expect(events.mock.calls.filter(([event]) => event.details === 'Legacy block state import failed')).toHaveLength(1);
  expect(handlers).not.toHaveBeenCalled();
});
