import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { DatabaseInstance } from '../../../../src/database/connection.js';
import type { IAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';

let transaction: Record<string, jest.Mock>;
const withSystemContextMock = jest.fn(async (
  _db: unknown,
  callback: (tx: Record<string, jest.Mock>) => Promise<unknown>,
) => callback(transaction));

jest.unstable_mockModule('../../../../src/database/admin.js', () => ({
  withSystemContext: withSystemContextMock,
}));

const {
  ConsoleOAuthGrantRevocationDependencyError,
  ConsoleOAuthGrantRevocationService,
  InMemoryConsoleOAuthSubjectResolver,
  PostgresConsoleOAuthSubjectResolver,
} = await import('../../../../src/web-console/services/oauth/index.js');

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const REVOKED_AT = new Date('2026-05-27T14:00:00.000Z');

beforeEach(() => {
  transaction = {};
  withSystemContextMock.mockClear();
});

describe('ConsoleOAuthGrantRevocationService', () => {
  it('resolves linked subjects, revokes each unique grant family, and returns bounded counts', async () => {
    const revokedGrantIds: string[] = [];
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([
        { userId: USER_ID, sub: 'github_42' },
        { userId: USER_ID, sub: 'local_alice' },
        { userId: SECOND_USER_ID, sub: 'github_other' },
      ]),
      authStorage({
        grantsBySub: new Map([
          ['github_42', ['grant-a', 'grant-b']],
          ['local_alice', ['grant-b', 'grant-c']],
        ]),
        revokedGrantIds,
      }),
    );

    await expect(service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .resolves.toEqual({
        userId: USER_ID,
        revokedAt: REVOKED_AT,
        linkedSubjectsProcessed: 2,
        oauthGrantFamiliesDiscovered: 3,
        oauthGrantFamiliesRevoked: 3,
        subjects: [
          { sub: 'github_42', grantsDiscovered: 2, grantsRevoked: 2 },
          { sub: 'local_alice', grantsDiscovered: 2, grantsRevoked: 1 },
        ],
      });
    expect(revokedGrantIds).toEqual(expect.arrayContaining(['grant-a', 'grant-b', 'grant-c']));
  });

  it('deduplicates grant families across more than two linked subjects', async () => {
    const revokedGrantIds: string[] = [];
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([
        { userId: USER_ID, sub: 'subject-a' },
        { userId: USER_ID, sub: 'subject-b' },
        { userId: USER_ID, sub: 'subject-c' },
      ]),
      authStorage({
        grantsBySub: new Map([
          ['subject-a', ['grant-ab', 'grant-ac']],
          ['subject-b', ['grant-ab', 'grant-bc']],
          ['subject-c', ['grant-ac', 'grant-bc']],
        ]),
        revokedGrantIds,
      }),
    );

    const result = await service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT });

    expect(result.oauthGrantFamiliesDiscovered).toBe(3);
    expect(result.oauthGrantFamiliesRevoked).toBe(3);
    expect(revokedGrantIds).toEqual(expect.arrayContaining(['grant-ab', 'grant-ac', 'grant-bc']));
    expect(new Set(revokedGrantIds).size).toBe(3);
  });

  it('returns zero counts when the principal has no linked subjects or a linked subject has no grants', async () => {
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver(),
      authStorage(),
    );

    await expect(service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .resolves.toMatchObject({
        linkedSubjectsProcessed: 0,
        oauthGrantFamiliesDiscovered: 0,
        oauthGrantFamiliesRevoked: 0,
        subjects: [],
      });

    const linkedSubjectService = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([{ userId: USER_ID, sub: 'github_42' }]),
      authStorage(),
    );
    await expect(linkedSubjectService.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .resolves.toMatchObject({
        linkedSubjectsProcessed: 1,
        oauthGrantFamiliesDiscovered: 0,
        oauthGrantFamiliesRevoked: 0,
        subjects: [{ sub: 'github_42', grantsDiscovered: 0, grantsRevoked: 0 }],
      });
  });

  it('throws on first grant lookup failure without returning partial summaries', async () => {
    const revokedGrantIds: string[] = [];
    const storage = authStorage({
      grantsBySub: new Map([['github_42', ['grant-a']]]),
      revokedGrantIds,
      failFindForSub: 'local_alice',
    });
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([
        { userId: USER_ID, sub: 'github_42' },
        { userId: USER_ID, sub: 'local_alice' },
      ]),
      storage,
    );

    await expect(service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .rejects.toThrow('grant lookup failed');
    expect(revokedGrantIds).toEqual(['grant-a']);
  });

  it('throws on first grant revocation failure after preserving earlier revocations', async () => {
    const revokedGrantIds: string[] = [];
    const storage = authStorage({
      grantsBySub: new Map([['github_42', ['grant-a', 'grant-b', 'grant-c']]]),
      revokedGrantIds,
      failRevokeForGrantId: 'grant-b',
    });
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([{ userId: USER_ID, sub: 'github_42' }]),
      storage,
    );

    await expect(service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .rejects.toThrow('grant revocation failed');
    expect(revokedGrantIds).toEqual(['grant-a']);
  });

  it('fails closed when auth storage cannot revoke grant families', async () => {
    const storage = {
      findGrantsByAccountId: jest.fn<() => Promise<string[]>>(),
    } as unknown as IAuthStorageLayer;
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver([{ userId: USER_ID, sub: 'github_42' }]),
      storage,
    );

    await expect(service.revokePrincipalGrants({ userId: USER_ID, revokedAt: REVOKED_AT }))
      .rejects.toThrow(ConsoleOAuthGrantRevocationDependencyError);
    expect(storage.findGrantsByAccountId).not.toHaveBeenCalled();
  });

  it('validates the target principal and revocation timestamp', async () => {
    const service = new ConsoleOAuthGrantRevocationService(
      new InMemoryConsoleOAuthSubjectResolver(),
      authStorage(),
    );

    await expect(service.revokePrincipalGrants({
      userId: 'not-a-uuid',
      revokedAt: REVOKED_AT,
    })).rejects.toThrow('userId must be a UUID');
    await expect(service.revokePrincipalGrants({
      userId: USER_ID,
      revokedAt: new Date(Number.NaN),
    })).rejects.toThrow('revokedAt must be a valid date');
  });
});

describe('InMemoryConsoleOAuthSubjectResolver', () => {
  it('validates constructor links and deduplicates duplicate subject links', async () => {
    expect(() => new InMemoryConsoleOAuthSubjectResolver([
      { userId: 'not-a-uuid', sub: 'github_42' },
    ])).toThrow('userId must be a UUID');
    expect(() => new InMemoryConsoleOAuthSubjectResolver([
      { userId: USER_ID, sub: ' ' },
    ])).toThrow('sub must be non-empty');

    const resolver = new InMemoryConsoleOAuthSubjectResolver([
      { userId: USER_ID, sub: 'github_42' },
      { userId: USER_ID, sub: 'github_42' },
      { userId: USER_ID, sub: 'local_alice' },
    ]);
    await expect(resolver.listLinkedSubjects(USER_ID)).resolves.toEqual(['github_42', 'local_alice']);
  });
});

describe('PostgresConsoleOAuthSubjectResolver', () => {
  it('lists linked auth account subjects for a canonical user id', async () => {
    const chain = selectingChain([
      { sub: 'github_42' },
      { sub: 'local_alice' },
    ]);
    transaction.select = jest.fn(() => chain);
    const resolver = new PostgresConsoleOAuthSubjectResolver({} as DatabaseInstance);

    await expect(resolver.listLinkedSubjects(USER_ID)).resolves.toEqual(['github_42', 'local_alice']);
    expect(withSystemContextMock).toHaveBeenCalledTimes(1);
    expect(transaction.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('returns empty for unknown principals and rejects malformed UUIDs', async () => {
    transaction.select = jest.fn(() => selectingChain([]));
    const resolver = new PostgresConsoleOAuthSubjectResolver({} as DatabaseInstance);

    await expect(resolver.listLinkedSubjects(USER_ID)).resolves.toEqual([]);
    await expect(resolver.listLinkedSubjects('not-a-uuid')).rejects.toThrow('userId must be a UUID');
  });
});

function authStorage(options: {
  grantsBySub?: Map<string, readonly string[]>;
  revokedGrantIds?: string[];
  failFindForSub?: string;
  failRevokeForGrantId?: string;
} = {}): IAuthStorageLayer {
  const grantsBySub = options.grantsBySub ?? new Map<string, readonly string[]>();
  const revokedGrantIds = options.revokedGrantIds ?? [];
  return {
    findGrantsByAccountId: (sub: string) => {
      if (sub === options.failFindForSub) {
        return Promise.reject(new Error('grant lookup failed'));
      }
      return Promise.resolve([...(grantsBySub.get(sub) ?? [])]);
    },
    genericRevokeByGrantId: (grantId: string) => {
      if (grantId === options.failRevokeForGrantId) {
        return Promise.reject(new Error('grant revocation failed'));
      }
      revokedGrantIds.push(grantId);
      return Promise.resolve();
    },
  } as unknown as IAuthStorageLayer;
}

function selectingChain(rows: unknown[]): {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
} {
  const orderBy = jest.fn(() => Promise.resolve(rows));
  const where = jest.fn(() => ({ orderBy }));
  const from = jest.fn(() => ({ where }));
  return { from, where, orderBy };
}
