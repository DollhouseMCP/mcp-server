import { describe, expect, it, jest } from '@jest/globals';

let transaction: {
  readonly insert: jest.Mock;
};
const withSystemContextMock = jest.fn((
  _db: unknown,
  callback: (tx: typeof transaction) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const { InviteTokenStore } = await import('../../../../src/auth/embedded-as/inviteTokens.js');
const { InMemorySigningKeyStore } = await import('../../../../src/storage/signingKeys/InMemorySigningKeyStore.js');
const { PostgresConsoleAccountInviteIssuer } = await import(
  '../../../../src/web-console/modules/account-admin/PostgresConsoleAccountInviteIssuer.js'
);

const USER_ID = '3d017fae-3c8e-47d3-9cb7-d391c19eb9e7';
const ACTOR_USER_ID = '6c93d545-cd3b-44d9-a2ea-066c7e40d620';
const ISSUED_AT = new Date('2026-05-31T12:00:00.000Z');
const EMAIL = 'alice@example.test';

describe('PostgresConsoleAccountInviteIssuer', () => {
  it('creates a canonical principal, pre-links the local auth account, and returns a signed invite URL', async () => {
    const insertedValues: unknown[] = [];
    transaction = {
      insert: jest.fn(() => ({
        values: jest.fn((value: unknown) => {
          insertedValues.push(value);
          if (isRecord(value) && 'username' in value) {
            return { returning: jest.fn(() => Promise.resolve([{ id: USER_ID }])) };
          }
          return Promise.resolve([]);
        }),
      })),
    };
    const signingKeyStore = new InMemorySigningKeyStore();
    const issuer = new PostgresConsoleAccountInviteIssuer({
      db: {} as never,
      signingKeyStore,
      publicBaseUrl: 'https://console.example.test/app/',
    });

    const result = await issuer.issueInvite({
      username: 'Alice',
      email: EMAIL,
      ttlMinutes: 15,
      roles: [],
      actorUserId: ACTOR_USER_ID,
      issuedAt: ISSUED_AT,
    });

    expect(result).toMatchObject({
      userId: USER_ID,
      primarySub: 'local_alice',
    });
    expect(result.inviteUrl).toMatch(/^https:\/\/console\.example\.test\/auth\/local\/invite\?invite=/u);
    const token = new URL(result.inviteUrl).searchParams.get('invite');
    expect(token).toEqual(expect.any(String));
    const activeInviteKey = await signingKeyStore.getActive('invite');
    const secret = Buffer.from(String(activeInviteKey?.payload.secret), 'base64');
    expect(new InviteTokenStore(secret).verify(token ?? '')).toMatchObject({
      ok: true,
      payload: {
        sub: 'local_alice',
        email: EMAIL,
        purpose: 'invite',
      },
    });
    expect(insertedValues).toEqual([
      expect.objectContaining({
        username: 'alice',
        email: EMAIL,
        displayName: EMAIL,
      }),
      expect.objectContaining({
        provider: 'local',
        externalSub: 'alice',
        sub: 'local_alice',
        userId: USER_ID,
        email: EMAIL,
        passwordHash: null,
      }),
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
