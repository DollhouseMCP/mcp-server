import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { BlockMutation } from '../../../../src/state/IDangerZoneBlockStore.js';

const persisted = new Map<string, Record<string, unknown>>();
const apply = jest.fn(async (user: string, mutation: BlockMutation) => {
  const blocks = persisted.get(user) ?? {};
  if (mutation.kind === 'put') blocks[mutation.name] = mutation.block;
  persisted.set(user, blocks);
  return true;
});
jest.unstable_mockModule('../../../../src/state/DatabaseDangerZoneBlockStore.js', () => ({
  DatabaseDangerZoneBlockStore: class {
    constructor(_db: unknown, private readonly user: string) {}
    apply(mutation: BlockMutation) { return apply(this.user, mutation); }
  },
}));
const userIds: string[] = [];
const receipts: unknown[] = [];
const listUsers = jest.fn(async () => userIds.map(id => ({ id })));
jest.unstable_mockModule('../../../../src/database/rls.js', () => ({
  withUserRead: async () => { throw new Error('Unexpected database read in migration fixture'); },
  withUserContext: async (_db: unknown, _user: string, callback: (tx: unknown) => Promise<unknown>) => callback({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => receipts }) }) }),
    insert: () => ({ values: async (value: unknown) => { receipts.push(value); } }),
  }),
}));
jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: async (_db: unknown, callback: (tx: unknown) => Promise<unknown>) => callback({
    execute: async () => [], select: () => ({ from: listUsers }),
  }),
}));
const { runDangerZoneBlocksToDatabaseMigration } = await import('../../../../src/storage/migration/dangerZoneBlocksToDatabase.js');
const { DangerZoneEnforcer } = await import('../../../../src/security/DangerZoneEnforcer.js');
const { SecurityMonitor } = await import('../../../../src/security/securityMonitor.js');
const { logger } = await import('../../../../src/utils/logger.js');
const { CANARY_USER_UUID } = await import('../../../../src/database/internalUsers.js');
const { env } = await import('../../../../src/config/env.js');
const { DollhouseContainer } = await import('../../../../src/di/Container.js');
const { bootstrapWebContainer } = await import('../../../../src/index.js');
const roots: string[] = [];
afterEach(async () => {
  jest.restoreAllMocks(); apply.mockClear(); persisted.clear(); userIds.splice(0); receipts.splice(0);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(layout: 'flat' | 'per-user' = 'per-user') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'block-import-')); roots.push(root);
  const userId = randomUUID(); userIds.push(userId, CANARY_USER_UUID);
  const legacyRoot = path.join(root, 'legacy'), anchor = path.join(root, 'portfolio');
  const rootFile = path.join(legacyRoot, 'security', 'blocked-agents.json');
  const flatFile = path.join(anchor, 'security', 'blocked-agents.json');
  const database = { execute: async () => [], transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(database) } as unknown as DatabaseInstance;
  const options = { database, systemDatabase: database, userId, legacyRoot,
    pathResolver: { getLayout: () => layout, getAnchorRoot: () => anchor, getUserSecurityDir: () => path.dirname(flatFile) } };
  return { root, rootFile, flatFile, anchor, userId, options };
}
async function write(filename: string, blocks: Record<string, unknown> = { agent: { reason: 'Review', blockedAt: 'invalid', verificationId: 'code', requiresAdmin: true } }) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify({ version: 1, blocks }), { mode: 0o600 });
}
it('imports root state once for the sole non-internal user and retains private evidence', async () => {
  const f = await fixture(); await write(f.rootFile);
  const info = jest.spyOn(logger, 'info');
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(persisted.get(f.userId)).toEqual({ agent: { reason: 'Review', blockedAt: 'invalid', verificationId: 'code', requiresAdmin: true } });
  const files = await fs.readdir(path.dirname(f.rootFile));
  expect(files).toHaveLength(1); expect(files[0]).toMatch(/^blocked-agents.json.imported-/);
  expect(info).toHaveBeenCalledWith('Legacy block state imported', { userId: f.userId, sourcePath: f.rootFile, count: 1, agentNames: ['agent'] });
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(apply).toHaveBeenCalledTimes(1);
});
it('imports per-user files and reports unknown or non-UUID directories', async () => {
  const f = await fixture(), other = randomUUID(); userIds.push(other);
  const filename = (id: string) => path.join(f.anchor, 'users', id, 'security', 'blocked-agents.json');
  await Promise.all([write(filename(other)), write(filename(randomUUID())), write(filename('unknown'))]);
  const warn = jest.spyOn(logger, 'warn');
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect([...persisted.keys()]).toEqual([other]);
  expect(warn.mock.calls.filter(([message]) => message === 'Legacy block directory has no known user')).toHaveLength(2);
});
it.each(['root', 'flat'] as const)('retains an unattributed %s file without importing rows', async kind => {
  const f = await fixture('flat'); userIds.push(randomUUID());
  const filename = kind === 'root' ? f.rootFile : f.flatFile; await write(filename);
  const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(apply).not.toHaveBeenCalled();
  expect((await fs.readdir(path.dirname(filename)))[0]).toMatch(/\.unattributed-/);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ severity: 'HIGH', additionalData: expect.objectContaining({ writerCount: 2 }) }));
});
it('imports a distinct flat file for a single user', async () => {
  const f = await fixture('flat'); await write(f.flatFile);
  await runDangerZoneBlocksToDatabaseMigration(f.options); expect(persisted.has(f.userId)).toBe(true);
});
it('does nothing when no legacy file exists', async () => {
  const f = await fixture(); await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(apply).not.toHaveBeenCalled();
});
it('retains a committed import after a rename failure without repeating puts', async () => {
  const f = await fixture(); await write(f.rootFile);
  jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Rename unavailable'));
  await expect(runDangerZoneBlocksToDatabaseMigration(f.options)).rejects.toThrow(f.rootFile);
  persisted.set(f.userId, { agent: { reason: 'Newer review', blockedAt: '2099-01-01' } });
  const info = jest.spyOn(logger, 'info');
  const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(persisted.get(f.userId)).toEqual({ agent: { reason: 'Newer review', blockedAt: '2099-01-01' } });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(info).not.toHaveBeenCalledWith('Legacy block state imported', expect.anything());
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ details: 'Legacy block state imported' }));
});
it('preserves malformed entries for administrative handling', async () => {
  const f = await fixture(); await write(f.rootFile, { agent: null });
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  const enforcer = new DangerZoneEnforcer({ location: 'test', load: async () => ({ status: 'loaded', value: persisted.get(f.userId)! }),
    apply: async () => true, reset: async () => '' });
  expect(await enforcer.check('agent')).toMatchObject({ blocked: true });
  expect(await enforcer.unblock('agent')).toBe(false);
  expect(persisted.get(f.userId)).toEqual({ agent: null });
});
it.each(['invalid', 'version', 'shape', 'oversized', 'unreadable'])('refuses %s source without changing its bytes', async kind => {
  const f = await fixture(); await write(f.rootFile);
  if (kind === 'invalid') await fs.writeFile(f.rootFile, '{');
  if (kind === 'version') await fs.writeFile(f.rootFile, '{"version":2,"blocks":{}}');
  if (kind === 'shape') await fs.writeFile(f.rootFile, '{"version":1,"blocks":[]}');
  if (kind === 'oversized') await fs.writeFile(f.rootFile, ' '.repeat(10 * 1024 * 1024 + 1));
  const before = await fs.readFile(f.rootFile);
  if (kind === 'unreadable') jest.spyOn(fs, 'open').mockRejectedValueOnce(new Error('Read unavailable'));
  await expect(runDangerZoneBlocksToDatabaseMigration(f.options)).rejects.toThrow(f.rootFile);
  expect(await fs.readFile(f.rootFile)).toEqual(before); expect(apply).not.toHaveBeenCalled();
});
it('refuses web bootstrap for an invalid attributable snapshot', async () => {
  const f = await fixture(); await write(f.rootFile); await fs.writeFile(f.rootFile, '{');
  const backend = env.DOLLHOUSE_STORAGE_BACKEND;
  env.DOLLHOUSE_STORAGE_BACKEND = 'database';
  jest.spyOn(DollhouseContainer.prototype, 'preparePortfolio').mockImplementation(() => runDangerZoneBlocksToDatabaseMigration(f.options));
  const handlers = jest.spyOn(DollhouseContainer.prototype, 'bootstrapHandlers');
  try {
    await expect(bootstrapWebContainer()).rejects.toThrow(f.rootFile);
    expect(handlers).not.toHaveBeenCalled();
    expect(await fs.readFile(f.rootFile, 'utf8')).toBe('{');
  } finally { env.DOLLHOUSE_STORAGE_BACKEND = backend; }
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('legacy source filesystem properties', () => {
  it('retains evidence with private mode bits', async () => {
    const f = await fixture(); await write(f.rootFile);
    await runDangerZoneBlocksToDatabaseMigration(f.options);
    const [name] = await fs.readdir(path.dirname(f.rootFile));
    expect((await fs.stat(path.join(path.dirname(f.rootFile), name))).mode & 0o777).toBe(0o600);
  });
  it.each(['symlink', 'hardlink'])('refuses a %s source without changing its bytes', async kind => {
    const f = await fixture(); await write(f.rootFile);
    const target = path.join(f.root, 'target'); await fs.rename(f.rootFile, target);
    if (kind === 'symlink') await fs.symlink(target, f.rootFile); else await fs.link(target, f.rootFile);
    const before = await fs.readFile(f.rootFile);
    await expect(runDangerZoneBlocksToDatabaseMigration(f.options)).rejects.toThrow(f.rootFile);
    expect(await fs.readFile(f.rootFile)).toEqual(before); expect(apply).not.toHaveBeenCalled();
  });
});
it('compares canonical source and parent paths when the filesystem expands an alias', async () => {
  const f = await fixture(); await write(f.rootFile);
  jest.spyOn(fs, 'realpath').mockImplementation(async filename => path.join(f.root, 'canonical', path.relative(f.root, String(filename))));
  await runDangerZoneBlocksToDatabaseMigration(f.options);
  expect(persisted.has(f.userId)).toBe(true);
});

it.each([{ 'invalid/name': null }, { agent: null, ' agent ': null }])('refuses invalid snapshot names before import', async blocks => {
  const f = await fixture(); await write(f.rootFile, blocks);
  const before = await fs.readFile(f.rootFile);
  const { DangerZoneBlockMigrationError } = await import('../../../../src/storage/migration/DangerZoneBlockMigrationError.js');
  await expect(runDangerZoneBlocksToDatabaseMigration(f.options)).rejects.toBeInstanceOf(DangerZoneBlockMigrationError);
  expect(await fs.readFile(f.rootFile)).toEqual(before);
  expect(apply).not.toHaveBeenCalled(); expect(receipts).toEqual([]);
});

describe('actionable import failures', () => {
  async function failed(options: Parameters<typeof runDangerZoneBlocksToDatabaseMigration>[0], location: string, reason: string, cause?: Error) {
    const logs = jest.spyOn(logger, 'error');
    const events = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const error = await runDangerZoneBlocksToDatabaseMigration(options).catch(value => value as Error);
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toContain(location);
    expect(failure.message).toContain(reason);
    expect(failure.message).toContain('then restart');
    expect(failure.message).toContain('docs/security/architecture.md (Blocked-agent persistence)');
    expect(failure.cause).toBeDefined();
    if (cause) expect(failure.cause).toBe(cause);
    expect(logs).toHaveBeenCalledTimes(1);
    expect(logs).toHaveBeenCalledWith('Legacy block state import failed', expect.objectContaining({ reason: expect.stringContaining(reason) }));
    const failures = events.mock.calls.filter(([event]) => event.details === 'Legacy block state import failed');
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toMatchObject({ type: 'DANGER_ZONE_OPERATION', severity: 'HIGH' });
    const printed = '[DollhouseMCP] Server startup failed: ' + failure.message;
    expect(printed).toContain(reason);
    expect(printed).toContain('then restart');
    expect(printed).not.toContain('private-credential');
    expect(JSON.stringify(logs.mock.calls)).not.toContain('private-credential');
    expect(JSON.stringify(failures)).not.toContain('private-credential');
    return failure;
  }
  it.each([
    ['{private-credential', 'invalid JSON'],
    ['{"version":2,"blocks":{}}', 'unsupportedVersion'],
    ['{"version":1,"blocks":[]}', 'Invalid block snapshot'],
    ['{"version":1,"blocks":{"../bad":null}}', 'restore: Agent name contains invalid characters'],
    ['{"version":1,"blocks":{"agent":null," agent ":null}}', 'Duplicate persisted agent name'],
    [' '.repeat(10 * 1024 * 1024 + 1), 'Block snapshot exceeds size limit'],
  ])('classifies snapshot failure %#', async (content, reason) => {
    const f = await fixture(); await write(f.rootFile); await fs.writeFile(f.rootFile, content);
    await failed(f.options, f.rootFile, reason);
    expect(await fs.readFile(f.rootFile, 'utf8')).toBe(content);
  });
  it.each(['open', 'lstat', 'chmod', 'rename'] as const)('classifies %s errors and preserves their cause', async operation => {
    const f = await fixture(); await write(f.rootFile);
    const cause = Object.assign(new Error('private-credential'), { code: 'EACCES' });
    jest.spyOn(fs, operation).mockRejectedValueOnce(cause);
    const reasons = { open: 'could not read', lstat: 'could not inspect', chmod: 'could not set permissions', rename: 'could not rename the imported file' };
    const error = await failed(f.options, f.rootFile, reasons[operation], cause);
    expect(error.message).toContain('EACCES');
    if (operation === 'rename' || operation === 'chmod') {
      expect(error.message).toContain('The import itself was recorded');
      expect(error.message).toContain('retry only the retention rename');
    }
  });
  it.each(['retention', 'chmod', 'rename'] as const)('gives the set-aside remedy for an unattributed %s failure', async stage => {
    const f = await fixture(); userIds.push(randomUUID()); await write(f.rootFile);
    const cause = Object.assign(new Error('Retention unavailable'), { code: 'EACCES' });
    if (stage === 'retention') {
      const inspect = await fs.lstat(f.rootFile);
      jest.spyOn(fs, 'lstat').mockResolvedValueOnce(inspect).mockRejectedValueOnce(cause);
    } else {
      jest.spyOn(fs, stage).mockRejectedValueOnce(cause);
    }
    const reasons = { retention: 'could not inspect the file before retention', chmod: 'could not set permissions', rename: 'could not rename the unattributed file' };
    const error = await failed(f.options, f.rootFile, reasons[stage], cause);
    expect(error.message).toContain('could not set this file aside for review because it cannot be attributed to a single user');
    expect(error.message).toContain('Preserve the file, check permissions on the security directory, then restart.');
    expect(error.message).not.toContain('could not be imported');
    expect(error.message).not.toContain('The import itself was recorded');
    expect(apply).not.toHaveBeenCalled();
  });
  it('keeps the recorded-import remedy for a retention inspection failure', async () => {
    const f = await fixture(); await write(f.rootFile);
    const cause = Object.assign(new Error('Retention unavailable'), { code: 'EACCES' });
    const inspect = await fs.lstat(f.rootFile);
    jest.spyOn(fs, 'lstat').mockResolvedValueOnce(inspect).mockRejectedValueOnce(cause);
    const error = await failed(f.options, f.rootFile, 'could not inspect the file before retention', cause);
    expect(receipts).toHaveLength(1);
    expect(error.message).toContain('The import itself was recorded');
    expect(error.message).toContain('retry only the retention rename');
    expect(error.message).not.toContain('could not set this file aside');
  });
  it('classifies database errors without displaying their raw text', async () => {
    const f = await fixture(); await write(f.rootFile);
    const cause = Object.assign(new Error('postgres://private-credential@localhost/database'), { code: '08006' });
    jest.spyOn(f.options.database, 'transaction').mockRejectedValueOnce(cause);
    const error = await failed(f.options, f.rootFile, 'database error during import', cause);
    expect(error.message).toContain('08006');
  });
  it('classifies a user-list failure without requiring a source path', async () => {
    const f = await fixture();
    const cause = new Error('private-credential');
    listUsers.mockRejectedValueOnce(cause);
    await failed(f.options, 'listing users', 'could not list users', cause);
  });
  it('classifies a users-directory failure', async () => {
    const f = await fixture();
    const cause = Object.assign(new Error('private-credential'), { code: 'EACCES' });
    jest.spyOn(fs, 'readdir').mockRejectedValueOnce(cause);
    await failed(f.options, path.join(f.anchor, 'users'), 'could not list the users directory', cause);
  });
  it('classifies a file changed after import and preserves the source', async () => {
    const f = await fixture(); await write(f.rootFile);
    apply.mockImplementationOnce(async () => { await fs.appendFile(f.rootFile, ' '); return true; });
    await failed(f.options, f.rootFile, 'file changed during import');
    expect(await fs.stat(f.rootFile)).toBeDefined();
  });
  describePosix('linked sources', () => {
    it.each(['symlink', 'link'] as const)('classifies a %s', async operation => {
      const f = await fixture(); await write(f.rootFile);
      const target = path.join(f.root, 'target.json');
      await fs.rename(f.rootFile, target);
      await fs[operation](target, f.rootFile);
      await failed(f.options, f.rootFile, 'file is not a regular, singly linked file');
    });
  });
});
