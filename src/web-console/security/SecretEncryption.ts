import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const ALGORITHM_ID = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

export interface SecretEncryptionContext {
  readonly secretClass: string;
  readonly ownerId: string;
}

export interface ISecretEncryptionService {
  encrypt(plaintext: Buffer, context: SecretEncryptionContext): Buffer;
  decrypt(record: Buffer, context: SecretEncryptionContext): Buffer;
}

export interface AeadSecretKey {
  readonly keyId: string;
  readonly key: Buffer;
}

/**
 * Binary v1 record: version | algorithm | key-id length | key-id | nonce | tag | ciphertext.
 * Keys remain external to persisted ciphertext records.
 */
export class AeadSecretEncryptionService implements ISecretEncryptionService {
  private readonly activeKey: AeadSecretKey;
  private readonly decryptKeys: ReadonlyMap<string, Buffer>;

  constructor(activeKey: AeadSecretKey, retainedDecryptKeys: readonly AeadSecretKey[] = []) {
    validateKey(activeKey);
    const keys = new Map<string, Buffer>();
    for (const key of [activeKey, ...retainedDecryptKeys]) {
      validateKey(key);
      keys.set(key.keyId, Buffer.from(key.key));
    }
    this.activeKey = { keyId: activeKey.keyId, key: Buffer.from(activeKey.key) };
    this.decryptKeys = keys;
  }

  encrypt(plaintext: Buffer, context: SecretEncryptionContext): Buffer {
    validateContext(context);
    const keyId = Buffer.from(this.activeKey.keyId, 'utf8');
    if (keyId.length > 255) throw new Error('Secret encryption key ID exceeds 255 bytes');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.activeKey.key, nonce);
    cipher.setAAD(additionalAuthenticatedData(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([
      Buffer.from([FORMAT_VERSION, ALGORITHM_ID, keyId.length]),
      keyId,
      nonce,
      tag,
      ciphertext,
    ]);
  }

  decrypt(record: Buffer, context: SecretEncryptionContext): Buffer {
    validateContext(context);
    if (!Buffer.isBuffer(record) || record.length < 3 + NONCE_BYTES + TAG_BYTES) {
      throw new Error('Invalid secret ciphertext record');
    }
    const version = record[0];
    if (version !== FORMAT_VERSION) throw new Error('Unsupported secret ciphertext format version');
    if (record[1] !== ALGORITHM_ID) throw new Error('Unsupported secret ciphertext algorithm');
    const keyIdLength = record[2];
    const dataStart = 3 + keyIdLength;
    if (record.length < dataStart + NONCE_BYTES + TAG_BYTES) {
      throw new Error('Invalid secret ciphertext record');
    }
    const keyId = record.subarray(3, dataStart).toString('utf8');
    const key = this.decryptKeys.get(keyId);
    if (!key) throw new Error('Unknown secret encryption key ID');
    const nonce = record.subarray(dataStart, dataStart + NONCE_BYTES);
    const tag = record.subarray(dataStart + NONCE_BYTES, dataStart + NONCE_BYTES + TAG_BYTES);
    const ciphertext = record.subarray(dataStart + NONCE_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAAD(additionalAuthenticatedData(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('Secret ciphertext authentication failed');
    }
  }
}

function additionalAuthenticatedData(context: SecretEncryptionContext): Buffer {
  const secretClass = Buffer.from(context.secretClass, 'utf8');
  const ownerId = Buffer.from(context.ownerId, 'utf8');
  const header = Buffer.allocUnsafe(10);
  header.writeUInt16BE(FORMAT_VERSION, 0);
  header.writeUInt32BE(secretClass.length, 2);
  header.writeUInt32BE(ownerId.length, 6);
  return Buffer.concat([header, secretClass, ownerId]);
}

function validateContext(context: SecretEncryptionContext): void {
  if (context.secretClass.trim() === '' || context.ownerId.trim() === '') {
    throw new Error('Secret encryption context requires class and owner ID');
  }
}

function validateKey(key: AeadSecretKey): void {
  if (key.keyId.trim() === '' || key.key.length !== 32) {
    throw new Error('Secret encryption keys require a key ID and exactly 32 bytes');
  }
}
