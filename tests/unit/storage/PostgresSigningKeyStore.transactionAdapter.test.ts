import { describe, expect, it, jest } from '@jest/globals';

import type { DatabaseInstance } from '../../../src/database/connection.js';
import type { DrizzleTx } from '../../../src/database/db-utils.js';
import type { SigningKeyWrite } from '../../../src/storage/signingKeys/ISigningKeyStore.js';
import { PostgresSigningKeyStore } from '../../../src/storage/signingKeys/PostgresSigningKeyStore.js';
import { SigningKeyPayloadEncryption } from '../../../src/storage/signingKeys/signingKeyPayloadEncryption.js';
import { AeadSecretEncryptionService } from '../../../src/web-console/security/SecretEncryption.js';

interface SigningKeyRow {
  kid: string;
  kind: string;
  payload: unknown;
  active: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  retiredAt: Date | null;
}

describe('PostgresSigningKeyStore transaction adapter', () => {
  it('keeps custom-encrypted key material readable after admin rotation and retirement', async () => {
    const database = {} as DatabaseInstance;
    const encryption = new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService({
        keyId: 'custom-admin-key',
        key: Buffer.alloc(32, 0x5a),
      }),
      'custom-admin-key',
    );
    const store = new PostgresSigningKeyStore({ db: database, payloadEncryption: encryption });
    const retiredAt = 1_799_999_999_000;
    const fixture = createSigningKeyTransactionFixture(retiredAt);
    const adapter = store.createPostgresTransactionAdapter(database);
    const write: SigningKeyWrite = {
      kid: 'custom-encrypted-admin-key',
      kind: 'invite',
      payload: { secret: 'custom-private-material', length: 32 },
    };

    await expect(adapter.rotate(fixture.tx, write)).resolves.toMatchObject({
      kid: write.kid,
      payload: write.payload,
      active: true,
    });
    expect(encryption.decrypt(fixture.row()?.payload, write.kind, write.kid).payload)
      .toEqual(write.payload);

    await expect(adapter.retire(fixture.tx, write.kid, retiredAt)).resolves.toMatchObject({
      kid: write.kid,
      payload: write.payload,
      active: false,
      retiredAt,
    });
    await expect(adapter.getByKid(fixture.tx, write.kid)).resolves.toMatchObject({
      kid: write.kid,
      payload: write.payload,
      retiredAt,
    });
  });

  it('rejects transaction composition against a different database', () => {
    const store = new PostgresSigningKeyStore({
      db: {} as DatabaseInstance,
      payloadEncryption: new SigningKeyPayloadEncryption(
        new AeadSecretEncryptionService({ keyId: 'custom-key', key: Buffer.alloc(32, 0x31) }),
        'custom-key',
      ),
    });

    expect(() => store.createPostgresTransactionAdapter({} as DatabaseInstance))
      .toThrow('requires the store database');
  });
});

function createSigningKeyTransactionFixture(retiredAt: number): {
  readonly tx: DrizzleTx;
  readonly row: () => SigningKeyRow | null;
} {
  let row: SigningKeyRow | null = null;
  const tx = {
    execute: jest.fn(async () => []),
    select: jest.fn(() => {
      const chain: Record<string, jest.Mock> = {};
      chain.from = jest.fn(() => chain);
      chain.where = jest.fn(() => chain);
      chain.limit = jest.fn(() => chain);
      chain.for = jest.fn(async () => row ? [row] : []);
      return chain;
    }),
    update: jest.fn(() => {
      let values: Record<string, unknown> = {};
      const chain: Record<string, jest.Mock> = {};
      chain.set = jest.fn((next: Record<string, unknown>) => {
        values = next;
        return chain;
      });
      chain.where = jest.fn(() => {
        if (row && typeof values.active === 'boolean') row.active = values.active;
        if (row && values.rotatedAt instanceof Date) row.rotatedAt = values.rotatedAt;
        return chain;
      });
      chain.returning = jest.fn(async () => {
        if (row && Object.hasOwn(values, 'retiredAt')) {
          row = {
            ...row,
            active: false,
            rotatedAt: new Date(retiredAt),
            retiredAt: new Date(retiredAt),
          };
        }
        return row ? [row] : [];
      });
      return chain;
    }),
    insert: jest.fn(() => {
      const chain: Record<string, jest.Mock> = {};
      chain.values = jest.fn((values: SigningKeyRow) => {
        row = {
          ...values,
          active: values.active,
          createdAt: values.createdAt,
          rotatedAt: null,
          retiredAt: null,
        };
        return chain;
      });
      chain.returning = jest.fn(async () => row ? [row] : []);
      return chain;
    }),
    delete: jest.fn(() => {
      const chain: Record<string, jest.Mock> = {};
      chain.where = jest.fn(() => chain);
      chain.returning = jest.fn(async () => {
        const deleted = row;
        row = null;
        return deleted ? [{ kid: deleted.kid }] : [];
      });
      return chain;
    }),
  };
  return {
    tx: tx as unknown as DrizzleTx,
    row: () => row,
  };
}
