import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import type { DatabaseInstance } from '../../../src/database/connection.js';

let withSystemContextMock = jest.fn<(db: unknown, cb: (tx: unknown) => unknown) => Promise<unknown>>();
const logSecurityEventMock = jest.fn();

jest.unstable_mockModule('../../../src/database/admin.js', () => ({
  withSystemContext: (db: unknown, cb: (tx: unknown) => unknown) => withSystemContextMock(db, cb),
}));
jest.unstable_mockModule('../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: logSecurityEventMock,
  },
}));

const { AuditHmacKeyResolver, StaticAuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');

const STATIC_KEY_ID = 'audit-hmac-fixture';

describe('StaticAuditHmacKeyResolver', () => {
  it('rejects weak or malformed keys', () => {
    expect(() => new StaticAuditHmacKeyResolver('not-hex')).toThrow(/hex/);
    expect(() => new StaticAuditHmacKeyResolver('aa')).toThrow(/at least 32 bytes/);
  });

  it('returns explicit key material with default keyId="static"', async () => {
    const resolver = new StaticAuditHmacKeyResolver('aa'.repeat(32));
    await expect(resolver.resolve()).resolves.toEqual({
      keyId: 'static',
      key: Buffer.alloc(32, 0xaa),
    });
  });

  it('honours an explicit keyId override', async () => {
    const resolver = new StaticAuditHmacKeyResolver('aa'.repeat(32), STATIC_KEY_ID);
    await expect(resolver.resolve()).resolves.toEqual({
      keyId: STATIC_KEY_ID,
      key: Buffer.alloc(32, 0xaa),
    });
  });

  it('resolves explicit key IDs only when they match the retained static key', async () => {
    const resolver = new StaticAuditHmacKeyResolver('aa'.repeat(32), STATIC_KEY_ID);

    await expect(resolver.resolveForKeyId(STATIC_KEY_ID)).resolves.toEqual({
      keyId: STATIC_KEY_ID,
      key: Buffer.alloc(32, 0xaa),
    });
    await expect(resolver.resolveForKeyId('other-key')).resolves.toBeNull();
  });
});

describe('AuditHmacKeyResolver — file mode', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = path.join(os.tmpdir(), `audit-hmac-${randomUUID()}`, 'audit-hmac-key');
  });

  it('auto-generates a 32-byte key on first resolve and persists it at 0600', async () => {
    delete process.env.DOLLHOUSE_AUDIT_HMAC_SECRET;
    const resolver = new AuditHmacKeyResolver({ rootDir });

    const material = await resolver.resolve();
    expect(material.keyId).toBe('file');
    expect(material.key.length).toBe(32);

    const stat = await fs.stat(rootDir);
    expect(stat.mode & 0o777).toBe(0o600);
    const persisted = await fs.readFile(rootDir, 'utf8');
    expect(persisted.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads back the persisted key on subsequent resolves (parity across processes)', async () => {
    delete process.env.DOLLHOUSE_AUDIT_HMAC_SECRET;
    const r1 = new AuditHmacKeyResolver({ rootDir });
    const first = await r1.resolve();

    const r2 = new AuditHmacKeyResolver({ rootDir });
    const second = await r2.resolve();

    expect(second.key.equals(first.key)).toBe(true);
    expect(second.keyId).toBe('file');
  });

  it('throws on an empty key file rather than silently returning a zero-byte HMAC key', async () => {
    // Reviewer finding 2026-05-22: empty / corrupt file used to silently
    // produce Buffer.alloc(0) which createHmac('sha256', ...) accepts.
    // Every audit hash would collapse to one value space. Now validates.
    await fs.mkdir(path.dirname(rootDir), { recursive: true });
    await fs.writeFile(rootDir, '', { mode: 0o600 });
    const resolver = new AuditHmacKeyResolver({ rootDir });

    await expect(resolver.resolve()).rejects.toThrow(/empty/);
  });

  it('throws on non-hex key file content', async () => {
    await fs.mkdir(path.dirname(rootDir), { recursive: true });
    await fs.writeFile(rootDir, 'this is not a hex key at all', { mode: 0o600 });
    const resolver = new AuditHmacKeyResolver({ rootDir });

    await expect(resolver.resolve()).rejects.toThrow(/hex-encoded/);
  });

  it('throws on key file that decodes to fewer than 32 bytes', async () => {
    await fs.mkdir(path.dirname(rootDir), { recursive: true });
    // 16 bytes of hex = 8 actual bytes, well under the 32-byte minimum.
    await fs.writeFile(rootDir, 'aa'.repeat(8), { mode: 0o600 });
    const resolver = new AuditHmacKeyResolver({ rootDir });

    await expect(resolver.resolve()).rejects.toThrow(/at least 32 bytes/);
  });

  it('throws on key file that decodes to more than 128 bytes (likely misconfig)', async () => {
    await fs.mkdir(path.dirname(rootDir), { recursive: true });
    await fs.writeFile(rootDir, 'ab'.repeat(200), { mode: 0o600 });
    const resolver = new AuditHmacKeyResolver({ rootDir });

    await expect(resolver.resolve()).rejects.toThrow(/cap is 128/);
  });
});

/**
 * Build a fake Drizzle transaction whose `select(...).from(...).where(...).limit(...)`
 * chain resolves to `rowsFn()` and whose `insert(...).values(...)` resolves to
 * `valuesFn()`. Keeps the test bodies flat instead of inlining the 5-level
 * fluent-builder boilerplate at every call site.
 */
function makeDrizzleTx(opts: {
  rowsFn: () => unknown[] | Promise<unknown[]>;
  valuesFn: () => Promise<unknown>;
}): unknown {
  const limit = () => Promise.resolve(opts.rowsFn());
  const where = () => ({ limit });
  const from = () => ({ where });
  const select = () => ({ from });
  const values = () => opts.valuesFn();
  const insert = () => ({ values });
  return { select, insert };
}

describe('AuditHmacKeyResolver — DB mode race', () => {
  beforeEach(() => {
    delete process.env.DOLLHOUSE_AUDIT_HMAC_SECRET;
    withSystemContextMock = jest.fn();
    logSecurityEventMock.mockClear();
  });

  it('on unique-violation conflict re-reads the winning row instead of failing', async () => {
    const winnerKid = 'audit-hmac-winner';
    const winnerSecret = Buffer.alloc(32, 0x42).toString('base64');
    const calls: Array<'read' | 'insert'> = [];

    // First call: SELECT active=true -> empty (we lose the race here).
    // Second call: INSERT -> throws unique-violation (winner already inserted).
    // Third call: SELECT active=true -> winner row.
    const rowsFn = () => {
      calls.push('read');
      if (calls.filter(c => c === 'read').length === 1) return [];
      return [{ kid: winnerKid, secret: winnerSecret, active: true }];
    };
    const valuesFn = () => {
      calls.push('insert');
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      return Promise.reject(err);
    };

    withSystemContextMock.mockImplementation((_db, cb) => Promise.resolve(cb(makeDrizzleTx({ rowsFn, valuesFn }))));

    const resolver = new AuditHmacKeyResolver({ database: {} as DatabaseInstance });
    const material = await resolver.resolve();

    expect(material.keyId).toBe(winnerKid);
    expect(material.key).toEqual(Buffer.alloc(32, 0x42));
    expect(calls).toEqual(['read', 'insert', 'read']);
    expect(logSecurityEventMock).not.toHaveBeenCalled();
  });

  it('logs a security event when DB mode auto-generates the active key', async () => {
    const calls: Array<'read' | 'insert'> = [];
    const rowsFn = () => {
      calls.push('read');
      return [];
    };
    const valuesFn = () => {
      calls.push('insert');
      return Promise.resolve();
    };

    withSystemContextMock
      .mockImplementationOnce((_db, cb) => Promise.resolve(cb(makeDrizzleTx({ rowsFn, valuesFn }))))
      .mockImplementationOnce((_db, cb) => Promise.resolve(cb(makeDrizzleTx({
        rowsFn: () => [{
          kid: 'audit-hmac-generated',
          secret: Buffer.alloc(32, 0x33).toString('base64'),
          active: true,
        }],
        valuesFn,
      }))));

    const resolver = new AuditHmacKeyResolver({ database: {} as DatabaseInstance });
    const material = await resolver.resolve();

    expect(material.keyId).toMatch(/^audit-hmac-/);
    expect(material.key.length).toBe(32);
    expect(calls).toEqual(['read', 'insert']);
    expect(logSecurityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'AUDIT_HMAC_KEY_AUTOGENERATED',
      severity: 'HIGH',
      source: 'AuditHmacKeyResolver.resolveFromDatabase',
      additionalData: expect.objectContaining({ source: 'db' }),
    }));
  });

  it('propagates non-unique-violation errors instead of swallowing them', async () => {
    const rowsFn = () => [];
    const valuesFn = (): Promise<unknown> => Promise.reject(new Error('connection refused'));

    withSystemContextMock.mockImplementation((_db, cb) => Promise.resolve(cb(makeDrizzleTx({ rowsFn, valuesFn }))));

    const resolver = new AuditHmacKeyResolver({ database: {} as DatabaseInstance });
    await expect(resolver.resolve()).rejects.toThrow(/connection refused/);
  });

  it('looks up retained historical DB keys by key ID for audit verification', async () => {
    const historicalKid = 'audit-hmac-previous';
    const historicalSecret = Buffer.alloc(32, 0x66).toString('base64');
    const rowsFn = () => [{ kid: historicalKid, secret: historicalSecret, active: false }];
    const valuesFn = () => Promise.resolve();

    withSystemContextMock.mockImplementation((_db, cb) => Promise.resolve(cb(makeDrizzleTx({ rowsFn, valuesFn }))));

    const resolver = new AuditHmacKeyResolver({ database: {} as DatabaseInstance });

    await expect(resolver.resolveForKeyId(historicalKid)).resolves.toEqual({
      keyId: historicalKid,
      key: Buffer.alloc(32, 0x66),
    });
    await expect(resolver.resolveForKeyId(historicalKid)).resolves.toEqual({
      keyId: historicalKid,
      key: Buffer.alloc(32, 0x66),
    });
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
  });
});
