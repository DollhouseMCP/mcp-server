import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

let withSystemContextMock = jest.fn<(db: unknown, cb: (tx: unknown) => unknown) => Promise<unknown>>();

jest.unstable_mockModule('../../../src/database/admin.js', () => ({
  withSystemContext: (db: unknown, cb: (tx: unknown) => unknown) => withSystemContextMock(db, cb),
}));

const { AuditHmacKeyResolver, StaticAuditHmacKeyResolver } = await import('../../../src/security/auditHmacKey.js');

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
    const resolver = new StaticAuditHmacKeyResolver('aa'.repeat(32), 'audit-hmac-fixture');
    await expect(resolver.resolve()).resolves.toEqual({
      keyId: 'audit-hmac-fixture',
      key: Buffer.alloc(32, 0xaa),
    });
  });
});

describe('AuditHmacKeyResolver — file mode', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = path.join(os.tmpdir(), `audit-hmac-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'audit-hmac-key');
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

describe('AuditHmacKeyResolver — DB mode race', () => {
  beforeEach(() => {
    delete process.env.DOLLHOUSE_AUDIT_HMAC_SECRET;
    withSystemContextMock = jest.fn();
  });

  it('on unique-violation conflict re-reads the winning row instead of failing', async () => {
    const winnerKid = 'audit-hmac-winner';
    const winnerSecret = Buffer.alloc(32, 0x42).toString('base64');
    const calls: Array<'read' | 'insert'> = [];

    withSystemContextMock.mockImplementation(async (_db, cb) => {
      // First call: SELECT active=true -> empty (we lose the race here).
      // Second call: INSERT -> throws unique-violation (winner already inserted).
      // Third call: SELECT active=true -> winner row.
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                calls.push('read');
                if (calls.filter(c => c === 'read').length === 1) return [];
                return [{ kid: winnerKid, secret: winnerSecret, active: true }];
              },
            }),
          }),
        }),
        insert: () => ({
          values: async () => {
            calls.push('insert');
            const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
            err.code = '23505';
            throw err;
          },
        }),
      };
      return cb(tx as never);
    });

    const resolver = new AuditHmacKeyResolver({ database: {} as never });
    const material = await resolver.resolve();

    expect(material.keyId).toBe(winnerKid);
    expect(material.key).toEqual(Buffer.alloc(32, 0x42));
    expect(calls).toEqual(['read', 'insert', 'read']);
  });

  it('propagates non-unique-violation errors instead of swallowing them', async () => {
    withSystemContextMock.mockImplementation(async (_db, cb) => {
      const tx = {
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        }),
        insert: () => ({
          values: async () => {
            throw new Error('connection refused');
          },
        }),
      };
      return cb(tx as never);
    });

    const resolver = new AuditHmacKeyResolver({ database: {} as never });
    await expect(resolver.resolve()).rejects.toThrow(/connection refused/);
  });
});
