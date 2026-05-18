import * as crypto from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { DatabaseInstance } from '../../database/connection.js';
import { withUserContext, withUserRead } from '../../database/rls.js';
import { userOauthTokens } from '../../database/schema/index.js';
import type { MasterKeyProvider } from '../keys/MasterKeyProvider.js';
import type { ITokenStore } from './ITokenStore.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

interface TokenRow {
  userId: string;
  tokenCiphertext: Buffer;
  tokenIv: Buffer;
  tokenTag: Buffer;
  wrappedDek: Buffer;
  dekIv: Buffer;
  dekTag: Buffer;
  keyVersion: number;
}

export class DatabaseTokenStore implements ITokenStore {
  constructor(
    private readonly db: DatabaseInstance,
    private readonly masterKeyProvider: MasterKeyProvider,
  ) {}

  async storeToken(userId: string, token: string): Promise<void> {
    assertUuid(userId);

    const dek = crypto.randomBytes(KEY_LENGTH);
    const tokenEncrypted = encrypt(Buffer.from(token, 'utf8'), dek);
    const masterKey = await this.masterKeyProvider.getCurrentKey();
    const wrappedDek = encrypt(dek, masterKey.key);
    const now = new Date();

    await withUserContext(this.db, userId, async (tx) => {
      await tx
        .insert(userOauthTokens)
        .values({
          userId,
          tokenCiphertext: tokenEncrypted.ciphertext,
          tokenIv: tokenEncrypted.iv,
          tokenTag: tokenEncrypted.tag,
          wrappedDek: wrappedDek.ciphertext,
          dekIv: wrappedDek.iv,
          dekTag: wrappedDek.tag,
          keyVersion: masterKey.version,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: userOauthTokens.userId,
          set: {
            tokenCiphertext: tokenEncrypted.ciphertext,
            tokenIv: tokenEncrypted.iv,
            tokenTag: tokenEncrypted.tag,
            wrappedDek: wrappedDek.ciphertext,
            dekIv: wrappedDek.iv,
            dekTag: wrappedDek.tag,
            keyVersion: masterKey.version,
            updatedAt: now,
          },
        });
    });
  }

  async retrieveToken(userId: string): Promise<string | null> {
    assertUuid(userId);

    const rows = await withUserRead(this.db, userId, (tx) =>
      tx.select().from(userOauthTokens).where(eq(userOauthTokens.userId, userId)).limit(1),
    );
    if (rows.length === 0) return null;

    const row = rows[0] as TokenRow;
    const masterKey = await this.masterKeyProvider.getKey(row.keyVersion);
    const dek = decrypt(
      {
        ciphertext: Buffer.from(row.wrappedDek),
        iv: Buffer.from(row.dekIv),
        tag: Buffer.from(row.dekTag),
      },
      masterKey.key,
    );

    return decrypt(
      {
        ciphertext: Buffer.from(row.tokenCiphertext),
        iv: Buffer.from(row.tokenIv),
        tag: Buffer.from(row.tokenTag),
      },
      dek,
    ).toString('utf8');
  }

  async deleteToken(userId: string): Promise<void> {
    assertUuid(userId);
    await withUserContext(this.db, userId, async (tx) => {
      await tx.delete(userOauthTokens).where(eq(userOauthTokens.userId, userId));
    });
  }
}

function encrypt(plaintext: Buffer, key: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(payload: { ciphertext: Buffer; iv: Buffer; tag: Buffer }, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.tag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(userId: string): void {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    const got = typeof userId === 'string' ? `"${userId}"` : typeof userId;
    throw new Error(`DatabaseTokenStore: userId must be a UUID; got ${got}`);
  }
}

