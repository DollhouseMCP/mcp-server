import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FileHandle } from 'node:fs/promises';
import type { Stats, BigIntStats } from 'node:fs';
import { DangerZoneOfflineRecovery, type OfflineRecoveryConfirmation } from '../../../src/security/DangerZoneOfflineRecovery.js';

const token = 'configured-token-secret';
const target = 'orphan';
const roots: string[] = [];
const snapshot = JSON.stringify({ version: 1, blocks: {
  orphan: { reason: 'Stopped', blockedAt: '2026-01-01', eventId: 'old-event', verificationId: 'legacy-challenge', private: 'block-private' },
  bystander: { reason: 'Keep', sessionId: 'another-session', extra: { preserved: 'é' } },
}, extension: { unchanged: true } }, null, 2)+'\n';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-dz-')); roots.push(root);
  const namespace = await fs.realpath(root);
  const filename = path.join(namespace, 'blocked-agents.json');
  const activation = path.join(namespace, 'activation.json');
  const evidencePath = path.join(namespace, 'operator-evidence.json');
  await fs.writeFile(filename, snapshot, { mode: 0o600 });
  await fs.writeFile(activation, 'ACTIVATION-MUST-NOT-CHANGE', { mode: 0o600 });
  await fs.writeFile(evidencePath, JSON.stringify({ namespace, writers: [{ identity: 'operator-inventory', stopDrainEvidence: 'reviewed stop/drain observation' }], exclusiveControlEvidence: 'reviewed exclusive volume observation' }), { mode: 0o600 });
  const operator = os.userInfo();
  const options = { securityDir: namespace, evidencePath, operator, configuredAdminToken: token,
    confirm: async (proposal: OfflineRecoveryConfirmation) => proposal.code };
  return { namespace, filename, activation, evidencePath, options };
}
afterEach(async () => { jest.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

/** Real I/O, selectively controlled boundary; preserves native handle binding. */
function wrapHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, { get(object, key) {
    const replacement = Reflect.get(overrides, key);
    if (replacement !== undefined) return replacement;
    const value = Reflect.get(object, key); return typeof value === 'function' ? value.bind(object) : value;
  } });
}

// The operator CLI requires POSIX uid/permissions, O_NOFOLLOW and directory sync.
const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('Authenticated offline one-block recovery (external exclusion is a prerequisite)', () => {
  it('refuses root cross-owner replacement before confirmation while retaining exact target bytes', async () => {
    const f = await fixture(); const confirm = jest.fn(f.options.confirm);
    const rename = jest.fn<typeof fs.rename>(fs.rename);
    // Controlled target identity models a service-owned file under a root operator.
    const foreignUid = (await fs.stat(f.filename)).uid === 1001 ? 1002 : 1001;
    const identity = <T extends Stats | BigIntStats>(stat: T): T => Object.assign(stat,
      { uid: typeof stat.uid === 'bigint' ? BigInt(foreignUid) : foreignUid });
    const io = { ...fs, rename,
      lstat: (async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await fs.lstat(...args);
        return String(args[0]) === f.filename ? identity(stat) : stat;
      }) as typeof fs.lstat,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        return String(args[0]) === f.filename
          ? wrapHandle(handle, { stat: (async (options?: Parameters<FileHandle['stat']>[0]) =>
            identity(await handle.stat(options))) as FileHandle['stat'] }) : handle;
      },
    } as typeof fs;
    const result = await new DangerZoneOfflineRecovery({ ...f.options,
      operator: { ...f.options.operator, uid: 0 }, confirm }, io).run(token, target);
    expect(result.status).toBe('refused'); expect(confirm).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled(); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
    expect(await fs.readFile(f.activation, 'utf8')).toBe('ACTIVATION-MUST-NOT-CHANGE');
  });

  it('backs up exact original bytes, preserves bystanders/activation and persists redacted outcome', async () => {
    const f = await fixture(); let displayedCode = '';
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm: async proposal => { displayedCode = proposal.code; return proposal.code; } }).run(token, target);
    expect(result.status).toBe('completed');
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe(snapshot);
    const updated = JSON.parse(await fs.readFile(f.filename, 'utf8'));
    const expected = JSON.parse(snapshot); delete expected.blocks.orphan;
    expect(updated).toEqual(expected);
    expect(await fs.readFile(f.activation, 'utf8')).toBe('ACTIVATION-MUST-NOT-CHANGE');
    const audit = await fs.readFile(result.auditPath, 'utf8');
    expect(audit.trim().split('\n').map(line => JSON.parse(line).outcome)).toEqual(['requested', 'approved', 'replacement-prepared', 'completed']);
    for (const secret of [token, displayedCode, 'block-private', 'legacy-challenge', f.namespace, target]) expect(audit).not.toContain(secret);
    expect((await fs.stat(result.backupPath!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(result.auditPath)).mode & 0o777).toBe(0o600);
  });

  it.each([undefined, ''])('refuses absent/empty configured authority %p without reading the target or prompting', async configuredAdminToken => {
    const f = await fixture(); const confirm = jest.fn(f.options.confirm);
    const reads: string[] = [];
    const io = { ...fs, realpath: async (filename: Parameters<typeof fs.realpath>[0]) => { reads.push(String(filename)); return fs.realpath(filename); } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery({ ...f.options, configuredAdminToken, confirm }, io).run(token, target);
    expect(result.status).toBe('refused'); expect(confirm).not.toHaveBeenCalled(); expect(reads).not.toContain(f.filename);
    expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
    expect(await fs.readFile(result.auditPath, 'utf8')).toContain('"outcome":"denied"');
  });
  it.each(['', 'wrong-token'])('refuses supplied credential %p with configured authority intact', async provided => {
    const f = await fixture(); const confirm = jest.fn(f.options.confirm);
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm }).run(provided, target);
    expect(result.status).toBe('refused'); expect(confirm).not.toHaveBeenCalled(); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it.each(['wrong', 'expired'])('consumes the %s challenge and never changes the target', async kind => {
    const f = await fixture(); const recovery = new DangerZoneOfflineRecovery({ ...f.options, confirm: async proposal => {
      if (kind === 'expired') { const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 5*60*1000 + 1); return proposal.code; }
      return 'incorrect-code';
    } });
    const result = await recovery.run(token, target); expect(result.status).toBe('refused');
    expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
    const privateStore = Reflect.get(recovery, 'challenges'); expect(privateStore.size()).toBe(0);
  });
  it.each(['wrong-namespace', 'empty-writers', 'no-exclusion', 'public-evidence'])('refuses incomplete/untrusted operational evidence %s', async kind => {
    const f = await fixture(); const value = JSON.parse(await fs.readFile(f.evidencePath, 'utf8'));
    if (kind === 'wrong-namespace') value.namespace += '-other';
    if (kind === 'empty-writers') value.writers = [];
    if (kind === 'no-exclusion') delete value.exclusiveControlEvidence;
    await fs.writeFile(f.evidencePath, JSON.stringify(value));
    if (kind === 'public-evidence') await fs.chmod(f.evidencePath, 0o644);
    const confirm = jest.fn(f.options.confirm);
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm }).run(token, target);
    expect(result.status).toBe('refused'); expect(confirm).not.toHaveBeenCalled(); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it.each(['target-bytes', 'target-identity', 'evidence', 'parent-identity'])('rejects changed %s after the actual prompt await', async kind => {
    const f = await fixture(); const displaced = f.namespace+'-displaced';
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm: async proposal => {
      if (kind === 'target-bytes') await fs.appendFile(f.filename, ' ');
      if (kind === 'target-identity') { await fs.rename(f.filename, f.filename+'.old'); await fs.writeFile(f.filename, snapshot, { mode: 0o600 }); }
      if (kind === 'evidence') await fs.appendFile(f.evidencePath, ' ');
      if (kind === 'parent-identity') { await fs.rename(f.namespace, displaced); roots.push(displaced); await fs.mkdir(f.namespace, { mode: 0o700 }); }
      return proposal.code;
    } }).run(token, target);
    expect(result.status).not.toBe('completed');
    const actual = kind === 'parent-identity' ? path.join(displaced, 'blocked-agents.json') : f.filename;
    expect(await fs.readFile(actual, 'utf8')).toBe(snapshot + (kind === 'target-bytes' ? ' ' : ''));
  });
  it.each(['symlink', 'hardlink', 'utf8', 'bom', 'duplicate-key', 'unsupported-version'])('refuses unsafe target %s before confirmation', async kind => {
    const f = await fixture();
    if (kind === 'symlink') { await fs.rename(f.filename, f.filename+'.old'); await fs.symlink(f.filename+'.old', f.filename); }
    if (kind === 'hardlink') await fs.link(f.filename, f.filename+'.alias');
    if (kind === 'utf8') await fs.writeFile(f.filename, Buffer.from([0xff]));
    if (kind === 'bom') await fs.writeFile(f.filename, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(snapshot)]));
    if (kind === 'duplicate-key') await fs.writeFile(f.filename, '{"version":1,"blocks":{"orphan":{},"orphan":{}}}');
    if (kind === 'unsupported-version') await fs.writeFile(f.filename, snapshot.replace('"version": 1', '"version": 2'));
    const before = await fs.readFile(f.filename); const confirm = jest.fn(f.options.confirm);
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm }).run(token, target);
    expect(result.status).not.toBe('completed'); expect(confirm).not.toHaveBeenCalled(); expect(await fs.readFile(f.filename)).toEqual(before);
  });
  it('refuses zero write progress before target replacement', async () => {
    const f = await fixture();
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('original.json')) return wrapHandle(handle, { write: (async (buffer: Buffer) => ({ bytesWritten: 0, buffer })) as unknown as FileHandle['write'] });
      return handle;
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).not.toBe('completed'); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it('completes forced partial backup/stage writes without losing bytes', async () => {
    const f = await fixture(); let partialWrites = 0;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[1]) !== 'wx' || String(args[0]).endsWith('audit.jsonl')) return handle;
      return wrapHandle(handle, { write: (async (buffer: Buffer, offset: number, _length: number, position: number) => {
        partialWrites++; return handle.write(buffer, offset, 1, position);
      }) as FileHandle['write'] });
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).toBe('completed'); expect(partialWrites).toBeGreaterThan(100);
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe(snapshot);
    expect(Object.hasOwn(JSON.parse(await fs.readFile(f.filename, 'utf8')).blocks, target)).toBe(false);
  });
  it('refuses parent-directory durability failure before any rename', async () => {
    const f = await fixture(); const cause = new Error('private-parent-sync');
    const rename = jest.fn(fs.rename);
    const io = { ...fs, rename, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return String(args[0]) === f.namespace ? wrapHandle(handle, { sync: async () => { throw cause; } }) : handle;
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).toBe('failed'); expect(result.cause).toBe(cause); expect(rename).not.toHaveBeenCalled();
    expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it('refuses a replaced backup identity even when its bytes match', async () => {
    const f = await fixture(); let replaced = false;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith('.tmp') && String(args[1]) === 'wx') {
        const artifact = (await fs.readdir(f.namespace)).find(entry => entry.startsWith('offline-recovery-'))!;
        const backup = path.join(f.namespace, artifact, 'original.json');
        await fs.rename(backup, backup+'.old'); await fs.writeFile(backup, snapshot, { mode: 0o600 }); replaced = true;
      }
      return fs.open(...args);
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(replaced).toBe(true); expect(result.status).toBe('refused');
    expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it('refuses audit-path replacement during the prompt without modifying the target', async () => {
    const f = await fixture();
    const result = await new DangerZoneOfflineRecovery({ ...f.options, confirm: async proposal => {
      const artifact = (await fs.readdir(f.namespace)).find(entry => entry.startsWith('offline-recovery-'))!;
      const audit = path.join(f.namespace, artifact, 'audit.jsonl');
      await fs.rename(audit, audit+'.old'); await fs.writeFile(audit, '', { mode: 0o600 }); return proposal.code;
    } }).run(token, target);
    expect(result.status).toBe('refused'); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it('preserves exact body and close causes before any replacement', async () => {
    const f = await fixture(); const primary = null; const closeCause = new Error('private-close');
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      return String(args[0]) === f.filename ? wrapHandle(handle, {
        read: (async () => { throw primary; }) as FileHandle['read'],
        close: async () => { await handle.close(); throw closeCause; },
      }) : handle;
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).toBe('failed'); expect(result.cause).toBeInstanceOf(AggregateError);
    expect((result.cause as AggregateError).errors).toEqual([primary, closeCause]); expect(await fs.readFile(f.filename, 'utf8')).toBe(snapshot);
  });
  it.each([false, true])('does not infer rename rollback when replacement happened=%p', async apply => {
    const f = await fixture(); const cause = new Error('private-rename');
    const io = { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => { if (apply) await fs.rename(...args); throw cause; } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).toBe('replacement-unknown'); expect(result.cause).toBe(cause);
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe(snapshot);
    expect(Object.hasOwn(JSON.parse(await fs.readFile(f.filename, 'utf8')).blocks, target)).toBe(!apply);
    expect(await fs.readFile(result.auditPath, 'utf8')).not.toContain(cause.message);
  });
  it('retains known replacement when completed-audit sync fails, without false success/rollback', async () => {
    const f = await fixture(); const cause = new Error('private-audit-sync'); let completed = false;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (!String(args[0]).endsWith('audit.jsonl')) return handle;
      return wrapHandle(handle, { write: (async (...writeArgs: unknown[]) => {
        if (String(writeArgs[0]).includes('"outcome":"completed"')) completed = true;
        return Reflect.apply(handle.write, handle, writeArgs);
      }) as FileHandle['write'], sync: async () => { if (completed) throw cause; await handle.sync(); } });
    } } as typeof fs;
    const result = await new DangerZoneOfflineRecovery(f.options, io).run(token, target);
    expect(result.status).toBe('committed-audit-incomplete'); expect(result.cause).toBe(cause);
    expect(Object.hasOwn(JSON.parse(await fs.readFile(f.filename, 'utf8')).blocks, target)).toBe(false);
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe(snapshot);
  });
});
