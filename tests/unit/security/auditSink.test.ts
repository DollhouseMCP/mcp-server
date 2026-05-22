import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, expect, it, jest } from '@jest/globals';

let withSystemContextMock = jest.fn<(db: unknown, cb: (tx: unknown) => unknown) => Promise<unknown>>();

jest.unstable_mockModule('../../../src/database/admin.js', () => ({
  withSystemContext: (db: unknown, cb: (tx: unknown) => unknown) => withSystemContextMock(db, cb),
}));

const { FileAuditSink, DatabaseAuditSink } = await import('../../../src/security/auditSink.js');
type DatabaseInstance = import('../../../src/database/connection.js').DatabaseInstance;

describe('FileAuditSink', () => {
  it('writes durable JSONL events', async () => {
    const filePath = path.join(os.tmpdir(), `dollhouse-audit-${randomUUID()}`, 'security_events.jsonl');
    const sink = new FileAuditSink(filePath);

    await sink.write({
      eventType: 'audit.raw_input_accessed',
      actorId: 'tester',
      targetId: 'session:approval',
      metadata: { sessionId: 'session', approvalId: 'approval' },
    });

    const raw = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(raw.trim())).toEqual(expect.objectContaining({
      eventType: 'audit.raw_input_accessed',
      actorId: 'tester',
      targetId: 'session:approval',
    }));
  });

  it('propagates write failures (fail-closed contract: detail read must fail if sink fails)', async () => {
    // Point at a path under an unwritable parent — chmod the dir to read-only
    // after mkdir, then try to write. The chmod-then-write pattern reliably
    // triggers an EACCES on platforms that honour file mode (linux CI).
    if (process.platform === 'win32') return;  // ACL semantics differ
    const dir = path.join(os.tmpdir(), `dollhouse-audit-failclosed-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o500);  // read+execute only
    const sink = new FileAuditSink(path.join(dir, 'nested', 'events.jsonl'));

    try {
      await expect(sink.write({
        eventType: 'audit.raw_input_accessed',
        metadata: {},
      })).rejects.toBeDefined();
    } finally {
      await fs.chmod(dir, 0o700).catch(() => undefined);
    }
  });
});

describe('DatabaseAuditSink', () => {
  it('propagates DB INSERT failures so callers can fail-closed', async () => {
    withSystemContextMock = jest.fn().mockImplementation(async () => {
      throw new Error('database unavailable');
    });
    const sink = new DatabaseAuditSink({} as DatabaseInstance);

    await expect(sink.write({
      eventType: 'audit.raw_input_accessed',
      metadata: {},
    })).rejects.toThrow(/database unavailable/);
  });
});
