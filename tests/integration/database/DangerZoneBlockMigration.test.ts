import { afterAll, afterEach, beforeAll, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { runDangerZoneBlocksToDatabaseMigration } from '../../../src/storage/migration/dangerZoneBlocksToDatabase.js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabaseConnection } from '../../../src/database/connection.js';
import { users } from '../../../src/database/schema/users.js';
import { dangerZoneBlocks, dangerZoneBlockEvidence } from '../../../src/database/schema/dangerZoneBlocks.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { env } from '../../../src/config/env.js';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { DangerZoneEnforcer } from '../../../src/security/DangerZoneEnforcer.js';
import { DatabaseDangerZoneBlockStore } from '../../../src/state/DatabaseDangerZoneBlockStore.js';
import { TEST_DB_ADMIN_URL, TEST_DB_URL } from './test-db-helpers.js';

const databaseName = `block_import_${randomUUID().replaceAll('-', '')}`;
let admin: Sql;
let created = false;
let system: ReturnType<typeof createDatabaseConnection>;
let application: ReturnType<typeof createDatabaseConnection>;
let root: string;
let user: string;
const originalBackend = env.DOLLHOUSE_STORAGE_BACKEND;
interface StartupBoundary {
  runLegacyDangerZoneMigrationIfEnabled(): Promise<void>;
  deferredDangerZoneInit(): Promise<void>;
  getUserDangerZoneEnforcer(userId: string, securityDir: string): Promise<DangerZoneEnforcer>;
}
function container() {
  const value = new DollhouseContainer();
  value.register('DatabaseInstance', () => application.db, { override: true });
  value.register('SystemDatabaseInstance', () => system.db, { override: true });
  value.register('BootstrappedUserId', () => user, { override: true });
  value.register('UserPathResolver', () => ({ getLayout: () => 'per-user', getAnchorRoot: () => path.join(root, 'portfolio') }), { override: true });
  value.register('DangerZoneBlockStoreFactory', () => (id: string) => new DatabaseDangerZoneBlockStore(application.db, id), { override: true });
  value.register('DangerZoneEnforcer', () => new DangerZoneEnforcer(new DatabaseDangerZoneBlockStore(application.db, user)), { override: true });
  return { value, boundary: value as unknown as StartupBoundary };
}
beforeAll(async () => {
  const url = new URL(TEST_DB_ADMIN_URL); url.pathname = 'postgres';
  admin = postgres(url.toString(), { max: 1 });
  await admin`CREATE DATABASE ${admin(databaseName)}`;
  created = true;
  url.pathname = databaseName;
  system = createDatabaseConnection({ connectionUrl: url.toString(), ssl: 'disable' });
  await migrate(system.db, { migrationsFolder: path.join(process.cwd(), 'src/database/migrations') });
  await system.db.execute('GRANT USAGE ON SCHEMA public TO dollhouse_app');
  await system.db.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dollhouse_app');
  const appUrl = new URL(TEST_DB_URL); appUrl.pathname = databaseName;
  application = createDatabaseConnection({ connectionUrl: appUrl.toString(), ssl: 'disable' });
  const [row] = await system.db.insert(users).values({ username: 'block-import-owner' }).returning({ id: users.id });
  user = row.id;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-import-pg-'));
});
afterEach(async () => {
  jest.restoreAllMocks(); env.DOLLHOUSE_STORAGE_BACKEND = originalBackend;
  await system.db.delete(dangerZoneBlocks);
  await system.db.delete(dangerZoneBlockEvidence);
  await system.db.delete(users).where(eq(users.username, 'block-import-other'));
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root);
});
afterAll(async () => {
  await application?.close(); await system?.close();
  if (created) await admin`DROP DATABASE ${admin(databaseName)}`;
  await admin?.end();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it('imports before root and user enforcer initialization and retains user isolation', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  jest.spyOn(os, 'homedir').mockReturnValue(root);
  const directory = path.join(root, '.dollhouse/security');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'blocked-agents.json');
  await fs.writeFile(filename, JSON.stringify({ version: 1, blocks: {
    agent: { reason: 'Review required', blockedAt: 'invalid date', verificationId: 'challenge' },
    malformed: null,
  } }));
  const { value, boundary } = container();
  try {
    await boundary.deferredDangerZoneInit();
    const enforcer = value.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'challenge' });
    expect(await enforcer.unblock('malformed')).toBe(false);
    const rows = await system.db.select().from(dangerZoneBlocks);
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.blockedAt.getTime() === 0)).toBe(true);
    expect(rows.find(row => row.agentName === 'malformed')?.block).toBeNull();
    expect(await fs.readdir(directory)).toEqual([expect.stringMatching(/^blocked-agents.json.imported-/)]);
    const [other] = await system.db.insert(users).values({ username: 'block-import-other' }).returning({ id: users.id });
    const otherEnforcer = await boundary.getUserDangerZoneEnforcer(other.id, directory);
    expect(await otherEnforcer.check('agent')).toMatchObject({ blocked: false });
    expect(await application.db.select().from(dangerZoneBlocks)).toEqual([]);
    await boundary.runLegacyDangerZoneMigrationIfEnabled();
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true });
  } finally { await value.dispose(); }
});
it.each(['released', 'newer'])('retains a committed import after retention failure with a %s row', async state => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  jest.spyOn(os, 'homedir').mockReturnValue(root);
  const directory = path.join(root, 'portfolio/users', user, 'security');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'blocked-agents.json');
  await fs.writeFile(filename, JSON.stringify({ version: 1, blocks: {
    replay: { reason: 'Review required', blockedAt: new Date(0).toISOString(), eventId: 'earlier' },
  } }));
  const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Retention unavailable'));
  const first = container();
  const second = container();
  try {
    await expect(first.boundary.runLegacyDangerZoneMigrationIfEnabled()).rejects.toThrow(filename);
    const store = new DatabaseDangerZoneBlockStore(application.db, user);
    expect(await store.load()).toMatchObject({ value: { replay: { eventId: 'earlier' } } });
    if (state === 'released') expect(await store.apply({ kind: 'remove', name: 'replay', eventId: 'earlier' })).toBe(true);
    else await store.apply({ kind: 'put', name: 'replay', block: { reason: 'Review required', blockedAt: new Date().toISOString(), eventId: 'current' } });
    rename.mockRestore();
    await second.boundary.runLegacyDangerZoneMigrationIfEnabled();
    if (state === 'released') expect(await store.load()).toEqual({ status: 'loaded', value: {} });
    else expect(await store.load()).toMatchObject({ value: { replay: { eventId: 'current' } } });
    const receipts = await system.db.select().from(dangerZoneBlockEvidence);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].snapshot).toMatchObject({ kind: 'legacy-agent-block-import', source: filename, sha256: expect.any(String) });
    expect(await fs.readdir(directory)).toEqual([expect.stringMatching(/^blocked-agents.json.imported-/)]);
  } finally { await first.value.dispose(); await second.value.dispose(); }
});

async function waitForImportWaiters(deadline = Date.now() + 5000): Promise<void> {
  const [row] = await admin`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted
    AND database=(SELECT oid FROM pg_database WHERE datname=${databaseName})`;
  if (row.count >= 2) return;
  if (Date.now() >= deadline) throw new Error('Concurrent imports did not wait on the shared lock');
  await new Promise(resolve => setTimeout(resolve, 20));
  await waitForImportWaiters(deadline);
}
async function runConcurrentImports(options: Parameters<typeof runDangerZoneBlocksToDatabaseMigration>[0]) {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const holder = system.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('legacy-agent-block-import', 0))`);
    entered(); await held;
  });
  await acquired;
  const opened = jest.spyOn(fs, 'open');
  const results = Promise.allSettled([runDangerZoneBlocksToDatabaseMigration(options), runDangerZoneBlocksToDatabaseMigration(options)]);
  try {
    await waitForImportWaiters();
    expect(opened.mock.calls.length).toBeGreaterThanOrEqual(2);
  }
  finally { release(); await holder; }
  expect(await results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
}
it.each(['attributed', 'unattributed'])('serializes concurrent %s startup imports and source retention', async attribution => {
  if (attribution === 'unattributed') await system.db.insert(users).values({ username: 'block-import-other' });
  const anchor = path.join(root, 'portfolio'), legacyRoot = path.join(root, 'legacy');
  const rootFile = path.join(legacyRoot, 'security', 'blocked-agents.json');
  const userFile = path.join(anchor, 'users', user, 'security', 'blocked-agents.json');
  const blocks = { concurrent: { reason: 'Review required', blockedAt: new Date(0).toISOString() } };
  const content = JSON.stringify({ version: 1, blocks });
  await Promise.all([rootFile, userFile].map(async filename => {
    await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content);
  }));
  const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  await runConcurrentImports({ database: application.db, systemDatabase: system.db, userId: user, legacyRoot,
    pathResolver: { getLayout: () => 'per-user', getAnchorRoot: () => anchor, getUserSecurityDir: () => path.dirname(userFile) } });
  if (attribution === 'unattributed') expect(events.mock.calls.filter(([event]) => event.details === 'Legacy block file retained without user attribution')).toHaveLength(1);
  expect(await fs.readdir(path.dirname(rootFile))).toEqual([expect.stringMatching(attribution === 'attributed' ? /\.imported-/ : /\.unattributed-/)]);
  expect(await fs.readdir(path.dirname(userFile))).toEqual([expect.stringMatching(/\.imported-/)]);
  const receipts = await system.db.select().from(dangerZoneBlockEvidence);
  expect(receipts).toHaveLength(attribution === 'attributed' ? 2 : 1);
  const imported = events.mock.calls.filter(([event]) => event.details === 'Legacy block state imported').map(([event]) => event);
  expect(imported).toHaveLength(receipts.length);
  for (const receipt of receipts) {
    const snapshot = receipt.snapshot as { source: string };
    expect(imported.filter(event => event.additionalData?.sourcePath === snapshot.source)).toHaveLength(1);
  }
  expect(receipts.map(row => row.snapshot)).toContainEqual({ kind: 'legacy-agent-block-import', source: userFile,
    sha256: createHash('sha256').update(content).digest('hex'), blocks });
  expect(await system.db.select().from(dangerZoneBlocks)).toHaveLength(1);
});
it('rolls back block writes and the receipt together when import fails', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  jest.spyOn(os, 'homedir').mockReturnValue(root);
  const directory = path.join(root, '.dollhouse', 'security');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'blocked-agents.json');
  const content = JSON.stringify({ version: 1, blocks: { first: null, second: null } });
  await fs.writeFile(filename, content);
  const apply = DatabaseDangerZoneBlockStore.prototype.apply;
  jest.spyOn(DatabaseDangerZoneBlockStore.prototype, 'apply').mockImplementation(async function (this: DatabaseDangerZoneBlockStore, mutation) {
    if (mutation.kind === 'put' && mutation.name === 'second') throw new Error('Import unavailable');
    return apply.call(this, mutation);
  });
  const { value, boundary } = container();
  try {
    await expect(boundary.runLegacyDangerZoneMigrationIfEnabled()).rejects.toThrow(filename);
    expect(await system.db.select().from(dangerZoneBlocks)).toEqual([]);
    expect(await system.db.select().from(dangerZoneBlockEvidence)).toEqual([]);
    expect(await fs.readFile(filename, 'utf8')).toBe(content);
  } finally { await value.dispose(); }
});
it('completes with one shared connection for system and import transactions', async () => {
  const url = new URL(TEST_DB_ADMIN_URL); url.pathname = databaseName;
  const single = createDatabaseConnection({ connectionUrl: url.toString(), poolSize: 1, ssl: 'disable' });
  const legacyRoot = path.join(root, 'single');
  const directory = path.join(legacyRoot, 'security');
  const filename = path.join(directory, 'blocked-agents.json');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filename, JSON.stringify({ version: 1, blocks: { single: null } }));
  try {
    await runDangerZoneBlocksToDatabaseMigration({ database: single.db, systemDatabase: single.db, userId: user, legacyRoot,
      pathResolver: { getLayout: () => 'flat', getAnchorRoot: () => legacyRoot, getUserSecurityDir: () => directory } });
    expect(await single.db.select().from(dangerZoneBlockEvidence)).toHaveLength(1);
    expect(await fs.readdir(directory)).toEqual([expect.stringMatching(/\.imported-/)]);
  } finally { await single.close(); }
});

it('imports a padded key as the canonical row used by check and release', async () => {
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  jest.spyOn(os, 'homedir').mockReturnValue(root);
  const directory = path.join(root, '.dollhouse', 'security');
  await fs.mkdir(directory, { recursive: true });
  const block = { agentName: 'payload-name', reason: 'Review required', blockedAt: new Date(0).toISOString(), verificationId: 'code' };
  await fs.writeFile(path.join(directory, 'blocked-agents.json'), JSON.stringify({ version: 1, blocks: { ' agent ': block } }));
  const { value, boundary } = container();
  try {
    await boundary.deferredDangerZoneInit();
    const enforcer = value.resolve<DangerZoneEnforcer>('DangerZoneEnforcer');
    expect(await enforcer.check('agent')).toMatchObject({ blocked: true, verificationId: 'code' });
    const rows = await system.db.select().from(dangerZoneBlocks);
    expect(rows).toEqual([expect.objectContaining({ agentName: 'agent', block })]);
    expect(await enforcer.unblock('agent', 'code')).toBe(true);
    expect(await system.db.select().from(dangerZoneBlocks)).toEqual([]);
  } finally { await value.dispose(); }
});

it('keeps an attributed invalid source in place with an actionable failure', async () => {
  const legacyRoot = path.join(root, 'invalid');
  const directory = path.join(legacyRoot, 'security');
  const filename = path.join(directory, 'blocked-agents.json');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filename, '{');
  const failure = await runDangerZoneBlocksToDatabaseMigration({
    database: application.db, systemDatabase: system.db, userId: user, legacyRoot,
    pathResolver: { getLayout: () => 'flat', getAnchorRoot: () => legacyRoot, getUserSecurityDir: () => directory },
  }).catch(error => error as Error);
  expect(failure).toMatchObject({ message: expect.stringContaining(
    filename + ': file is not valid block state (invalid: invalid JSON).',
  ), cause: expect.any(Error) });
  expect((failure as Error).message).toContain('then restart');
  expect((failure as Error).message).toContain('docs/security/architecture.md (Blocked-agent persistence)');
  expect(await fs.readFile(filename, 'utf8')).toBe('{');
  expect(await system.db.select().from(dangerZoneBlocks)).toEqual([]);
  expect(await system.db.select().from(dangerZoneBlockEvidence)).toEqual([]);
});
