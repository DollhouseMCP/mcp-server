import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const withSystemContextMock = jest.fn(async (
  db: unknown,
  callback: (transaction: unknown) => Promise<unknown>,
) => callback(db));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const {
  PostgresAdminAuditQuery,
  computeAdminAuditChainHmac,
} = await import('../../../../src/web-console/index.js');

const NOW = new Date('2099-05-31T12:00:00.000Z');
const SESSION_HASH = Buffer.alloc(32, 7);
const AUDIT_KEY_ID = 'audit-key-1';
const AUDIT_KEY = Buffer.alloc(32, 3);
const AUDIT_KEY_MATERIAL = { keyId: AUDIT_KEY_ID, key: AUDIT_KEY };
const OLD_AUDIT_KEY_ID = 'audit-key-0';
const OLD_AUDIT_KEY = Buffer.alloc(32, 4);
const OLD_AUDIT_KEY_MATERIAL = { keyId: OLD_AUDIT_KEY_ID, key: OLD_AUDIT_KEY };

describe('PostgresAdminAuditQuery', () => {
  beforeEach(() => {
    withSystemContextMock.mockClear();
  });

  it('uses sequence-id seek pagination and emits the last seen sequence as the cursor', async () => {
    const rows = continuousAdminAuditRows(3);
    const db = adminAuditDb(rows);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    const firstPage = await query.listAdminAudit({ limit: 1, cursor: null });
    const secondPage = await query.listAdminAudit({ limit: 1, cursor: firstPage.page.next_cursor });

    expect(firstPage.items).toMatchObject([
      { sequence_id: 1, integrity: { status: 'verified', reason: null } },
    ]);
    expect(secondPage.items).toMatchObject([
      { sequence_id: 2, integrity: { status: 'verified', reason: null } },
    ]);
    expect(secondPage.page.cursor).toBe(firstPage.page.next_cursor);
    expect(secondPage.page.next_cursor).toEqual(expect.any(String));
    expect(db.sqlTexts.join('\n')).toContain('WHERE sequence_id >');
    expect(db.sqlTexts.join('\n')).toContain('WHERE sequence_id <');
    expect(db.sqlTexts.join('\n')).not.toContain('OFFSET');
    expect(db.seekAfterValues).toEqual([0, 1]);
  });

  it('does not fetch a previous chain seed for the first page', async () => {
    const rows = continuousAdminAuditRows(2);
    const db = adminAuditDb(rows);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    await expect(query.listAdminAudit({ limit: 1, cursor: null })).resolves.toMatchObject({
      items: [{ sequence_id: 1 }],
    });

    expect(db.sqlTexts.join('\n')).toContain('WHERE sequence_id >');
    expect(db.sqlTexts.join('\n')).not.toContain('WHERE sequence_id <');
  });

  it('falls back to the first page for invalid cursors', async () => {
    const rows = continuousAdminAuditRows(2);
    const db = adminAuditDb(rows);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    await expect(query.listAdminAudit({ limit: 1, cursor: Buffer.from('-1').toString('base64url') }))
      .resolves.toMatchObject({ items: [{ sequence_id: 1 }] });
    await expect(query.listAdminAudit({ limit: 1, cursor: Buffer.from('9007199254740992').toString('base64url') }))
      .resolves.toMatchObject({ items: [{ sequence_id: 1 }] });
    await expect(query.listAdminAudit({ limit: 1, cursor: 'not-base64-json' }))
      .resolves.toMatchObject({ items: [{ sequence_id: 1 }] });

    expect(db.seekAfterValues).toEqual([0, 0, 0]);
    expect(db.sqlTexts.join('\n')).not.toContain('WHERE sequence_id <');
  });

  it('seeds page-boundary verification from the prior sequence row so gaps still fail', async () => {
    const [first, , third] = continuousAdminAuditRows(3);
    const rowAfterGap = adminAuditRow(3, first.chain_hmac);
    const db = adminAuditDb([first, rowAfterGap]);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    const firstPage = await query.listAdminAudit({ limit: 1, cursor: null });
    const secondPage = await query.listAdminAudit({ limit: 1, cursor: firstPage.page.next_cursor });

    expect(third.sequence_id).toBe(3);
    expect(secondPage.items).toMatchObject([
      { sequence_id: 3, integrity: { status: 'failed', reason: 'sequence_gap' } },
    ]);
  });

  it('streams admin audit rows with seek batches and verifies the first batch boundary', async () => {
    const [first, , third] = continuousAdminAuditRows(3);
    const db = adminAuditDb([first, adminAuditRow(3, first.chain_hmac)]);
    const query = new PostgresAdminAuditQuery(db, keyResolver());
    const firstPage = await query.listAdminAudit({ limit: 1, cursor: null });

    const streamed = [];
    for await (const row of query.streamAdminAudit({ batchSize: 2, cursor: firstPage.page.next_cursor })) {
      streamed.push(row);
    }

    expect(third.sequence_id).toBe(3);
    expect(streamed).toMatchObject([
      { sequence_id: 3, integrity: { status: 'failed', reason: 'sequence_gap' } },
    ]);
    expect(db.seekAfterValues).toContain(1);
  });

  it('maps rows and verifies HMAC content with the configured audit key', async () => {
    const [first] = continuousAdminAuditRows(1);
    const db = adminAuditDb([first]);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    const result = await query.listAdminAudit({ limit: 10, cursor: null });

    expect(result.items).toEqual([
      expect.objectContaining({
        id: first.id,
        args_redacted: { reason_present: true },
        chain_hmac: first.chain_hmac.toString('hex'),
        integrity: { status: 'verified', reason: null },
      }),
    ]);
    expect(withSystemContextMock).toHaveBeenCalled();
  });

  it('coerces unknown persisted enum values to admin audit DTO fallbacks', async () => {
    const rowWithUnknownEnums = adminAuditRow(1, null, {
      actorCapabilityRole: 'bogus',
      capability: 'nope',
      result: 'something_unknown',
    });
    const db = adminAuditDb([rowWithUnknownEnums]);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    const result = await query.listAdminAudit({ limit: 10, cursor: null });

    expect(result.items).toMatchObject([
      {
        actor_capability_role: 'auditor',
        capability: 'console:admin:audit',
        result: 'failed',
      },
    ]);
  });

  it('marks content tampering failed without throwing or hiding the row', async () => {
    const [original] = continuousAdminAuditRows(1);
    const tampered = { ...original, result: 'failed' as const };
    const db = adminAuditDb([tampered]);
    const query = new PostgresAdminAuditQuery(db, keyResolver());

    await expect(query.getAdminAudit(original.id)).resolves.toMatchObject({
      id: original.id,
      result: 'failed',
      integrity: { status: 'failed', reason: 'chain_hmac_mismatch' },
    });
  });

  it('verifies rotated historical rows through retained key lookup', async () => {
    const historical = adminAuditRow(1, null, {
      chainKeyId: OLD_AUDIT_KEY_ID,
      key: OLD_AUDIT_KEY,
    });
    const resolver = keyResolver();
    const db = adminAuditDb([historical]);
    const query = new PostgresAdminAuditQuery(db, resolver);

    await expect(query.getAdminAudit(historical.id)).resolves.toMatchObject({
      id: historical.id,
      chain_key_id: OLD_AUDIT_KEY_ID,
      integrity: { status: 'verified', reason: null },
    });
    expect(resolver.resolveForKeyId).toHaveBeenCalledWith(OLD_AUDIT_KEY_ID);
  });
});

function keyResolver() {
  return {
    resolve: jest.fn(() => Promise.resolve(AUDIT_KEY_MATERIAL)),
    resolveForKeyId: jest.fn((keyId: string) => {
      if (keyId === AUDIT_KEY_ID) return Promise.resolve(AUDIT_KEY_MATERIAL);
      if (keyId === OLD_AUDIT_KEY_ID) return Promise.resolve(OLD_AUDIT_KEY_MATERIAL);
      return Promise.resolve(null);
    }),
  };
}

function continuousAdminAuditRows(count: number): AdminAuditDbRowFixture[] {
  const rows: AdminAuditDbRowFixture[] = [];
  let previous: Buffer | null = null;
  for (let sequenceId = 1; sequenceId <= count; sequenceId += 1) {
    const row = adminAuditRow(sequenceId, previous);
    rows.push(row);
    previous = row.chain_hmac;
  }
  return rows;
}

function adminAuditRow(
  sequenceId: number,
  chainPrev: Buffer | null,
  options: {
    readonly chainKeyId?: string;
    readonly key?: Buffer;
    readonly actorCapabilityRole?: string;
    readonly capability?: string;
    readonly result?: string;
  } = {},
): AdminAuditDbRowFixture {
  const chainKeyId = options.chainKeyId ?? AUDIT_KEY_ID;
  const key = options.key ?? AUDIT_KEY;
  const event = {
    occurredAt: new Date(NOW.getTime() + sequenceId),
    actorUserId: '018f3d47-73ae-7f10-a0de-0742618d4fa1',
    actorSub: 'github_123',
    actorRole: null,
    actorCapabilityRole: 'account_admin',
    actorConsoleSessionHash: SESSION_HASH,
    capability: 'console:admin:accounts',
    elevationAcr: 'urn:dollhouse:acr:admin-stepup',
    elevationAmr: ['otp'],
    elevationAuthTime: new Date('2099-05-31T11:55:00.000Z'),
    correlationId: `018f3d47-73ae-7f10-a0de-0742618d4f${sequenceId.toString().padStart(2, '0')}`,
    endpoint: 'POST /api/v1/admin/accounts/users/{user_id}/disable',
    operation: 'accounts.users.disable',
    resourceKind: 'user_principal',
    resourceId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    targetUserId: '018f3d47-73ae-7f10-a0de-0742618d4fb2',
    argsRedacted: { reason_present: true },
    result: 'approved',
    errorCode: null,
    resultDetailRedacted: { runtime_commands: 1 },
    clientIp: '203.0.113.10',
    userAgent: 'Mozilla/5.0',
  } as const;
  return {
    id: `admin-audit-${sequenceId}`,
    sequence_id: sequenceId,
    occurred_at: event.occurredAt,
    actor_user_id: event.actorUserId,
    actor_sub: event.actorSub,
    actor_role: event.actorRole,
    actor_capability_role: options.actorCapabilityRole ?? event.actorCapabilityRole,
    actor_console_session_hash: event.actorConsoleSessionHash,
    capability: options.capability ?? event.capability,
    elevation_acr: event.elevationAcr,
    elevation_amr: event.elevationAmr,
    elevation_auth_time: event.elevationAuthTime,
    endpoint: event.endpoint,
    operation: event.operation,
    resource_kind: event.resourceKind,
    resource_id: event.resourceId,
    target_user_id: event.targetUserId,
    args_redacted: event.argsRedacted,
    result: options.result ?? event.result,
    error_code: event.errorCode,
    result_detail_redacted: event.resultDetailRedacted,
    correlation_id: event.correlationId,
    client_ip: event.clientIp,
    user_agent: event.userAgent,
    chain_key_id: chainKeyId,
    chain_prev: chainPrev,
    chain_hmac: computeAdminAuditChainHmac(event, key, chainPrev),
  };
}

function adminAuditDb(rows: readonly AdminAuditDbRowFixture[]) {
  const sqlTexts: string[] = [];
  const seekAfterValues: number[] = [];
  return {
    sqlTexts,
    seekAfterValues,
    execute: jest.fn((query: unknown) => {
      const { text, params } = inspectSql(query);
      sqlTexts.push(text);
      if (text.includes('WHERE sequence_id >')) {
        const after = numberParam(params[0]);
        const limit = numberParam(params[1]);
        seekAfterValues.push(after);
        return Promise.resolve(rows
          .filter(row => Number(row.sequence_id) > after)
          .sort((left, right) => Number(left.sequence_id) - Number(right.sequence_id))
          .slice(0, limit));
      }
      if (text.includes('WHERE sequence_id <')) {
        const before = numberParam(params[0]);
        return Promise.resolve(rows
          .filter(row => Number(row.sequence_id) < before)
          .sort((left, right) => Number(right.sequence_id) - Number(left.sequence_id))
          .slice(0, 1));
      }
      if (text.includes('WHERE id =')) {
        return Promise.resolve(rows.filter(row => row.id === String(params[0])).slice(0, 1));
      }
      return Promise.resolve([]);
    }),
  };
}

function inspectSql(query: unknown): { readonly text: string; readonly params: readonly unknown[] } {
  const chunks = (query as { readonly queryChunks?: readonly unknown[] }).queryChunks ?? [];
  const params: unknown[] = [];
  const text = chunks.map(chunk => {
    if (isStringChunk(chunk)) return chunk.value.join('');
    params.push(chunk);
    return '?';
  }).join('');
  return { text, params };
}

function isStringChunk(chunk: unknown): chunk is { readonly value: readonly string[] } {
  return typeof chunk === 'object' && chunk !== null && Array.isArray((chunk as { value?: unknown }).value);
}

function numberParam(value: unknown): number {
  if (typeof value !== 'number') throw new TypeError(`expected numeric SQL param, got ${typeof value}`);
  return value;
}

interface AdminAuditDbRowFixture {
  readonly id: string;
  readonly sequence_id: number;
  readonly occurred_at: Date;
  readonly actor_user_id: string;
  readonly actor_sub: string;
  readonly actor_role: null;
  readonly actor_capability_role: string;
  readonly actor_console_session_hash: Buffer;
  readonly capability: string;
  readonly elevation_acr: string;
  readonly elevation_amr: readonly string[];
  readonly elevation_auth_time: Date;
  readonly endpoint: string;
  readonly operation: string;
  readonly resource_kind: string;
  readonly resource_id: string;
  readonly target_user_id: string;
  readonly args_redacted: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly error_code: null;
  readonly result_detail_redacted: Readonly<Record<string, unknown>>;
  readonly correlation_id: string;
  readonly client_ip: string;
  readonly user_agent: string;
  readonly chain_key_id: string;
  readonly chain_prev: Buffer | null;
  readonly chain_hmac: Buffer;
}
