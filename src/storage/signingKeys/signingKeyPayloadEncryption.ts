import { env } from '../../config/env.js';
import { isValidEnvelopeKeyId } from '../../security/envelopeKeyId.js';
import {
  AeadSecretEncryptionService,
  type ISecretEncryptionService,
} from '../../web-console/security/SecretEncryption.js';
import type { SigningKeyKind } from './ISigningKeyStore.js';

const ENVELOPE_MARKER = 'dollhouse-signing-key-aead-v1';
const SECRET_CLASS = 'auth-signing-key-payload';

interface EncryptedSigningKeyPayload {
  readonly format: typeof ENVELOPE_MARKER;
  readonly ciphertext: string;
}

export interface DecodedSigningKeyPayload {
  readonly payload: Record<string, unknown>;
  readonly legacyPlaintext: boolean;
  readonly rewrapRequired: boolean;
}

export class SigningKeyPayloadEncryption {
  constructor(
    private readonly encryption: ISecretEncryptionService,
    private readonly activeKeyId?: string,
  ) {}

  encrypt(payload: Record<string, unknown>, kind: SigningKeyKind, kid: string): Record<string, unknown> {
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      const record = this.encryption.encrypt(plaintext, context(kind, kid));
      return { format: ENVELOPE_MARKER, ciphertext: record.toString('base64') };
    } finally {
      plaintext.fill(0);
    }
  }

  decrypt(value: unknown, kind: SigningKeyKind, kid: string): DecodedSigningKeyPayload {
    if (!isEncryptedPayload(value)) {
      return { payload: coerceObject(value), legacyPlaintext: true, rewrapRequired: true };
    }
    const record = Buffer.from(value.ciphertext, 'base64');
    const plaintext = this.encryption.decrypt(record, context(kind, kid));
    try {
      const envelopeKeyId = readAeadKeyId(record);
      let payload: Record<string, unknown>;
      try {
        payload = coerceObject(JSON.parse(plaintext.toString('utf8')));
      } catch {
        throw new Error('Signing-key payload is malformed');
      }
      return {
        payload,
        legacyPlaintext: false,
        rewrapRequired: this.activeKeyId !== undefined && envelopeKeyId !== this.activeKeyId,
      };
    } finally {
      plaintext.fill(0);
    }
  }
}

export function createDefaultSigningKeyPayloadEncryption(): SigningKeyPayloadEncryption {
  const encoded = env.DOLLHOUSE_MASTER_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error(
      'PostgreSQL signing-key storage requires DOLLHOUSE_MASTER_ENCRYPTION_KEY ' +
      'to encrypt private signing material at rest',
    );
  }
  const activeKeyId = env.DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID;
  const activeKey = decodeMasterKey(encoded, 'DOLLHOUSE_MASTER_ENCRYPTION_KEY');
  const retainedKeys = decodeRetainedMasterKeys(
    env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED,
    activeKeyId,
  );
  try {
    return new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService({ keyId: activeKeyId, key: activeKey }, retainedKeys),
      activeKeyId,
    );
  } finally {
    activeKey.fill(0);
    retainedKeys.forEach(({ key }) => key.fill(0));
  }
}

function context(kind: SigningKeyKind, kid: string) {
  return { secretClass: SECRET_CLASS, ownerId: `${kind}:${kid}` };
}

function isEncryptedPayload(value: unknown): value is EncryptedSigningKeyPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<EncryptedSigningKeyPayload>;
  return candidate.format === ENVELOPE_MARKER &&
    typeof candidate.ciphertext === 'string' && candidate.ciphertext.length > 0;
}

function readAeadKeyId(record: Buffer): string {
  if (record.length < 3) throw new Error('Invalid signing-key ciphertext record');
  const keyIdLength = record[2];
  const keyIdEnd = 3 + keyIdLength;
  if (keyIdLength === 0 || record.length < keyIdEnd) {
    throw new Error('Invalid signing-key ciphertext key ID');
  }
  return record.subarray(3, keyIdEnd).toString('utf8');
}

function decodeMasterKey(encoded: string, name: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    key.fill(0);
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return key;
}

function decodeRetainedMasterKeys(
  value: string | undefined,
  activeKeyId: string,
): { keyId: string; key: Buffer }[] {
  if (!value) return [];
  const retained: { keyId: string; key: Buffer }[] = [];
  const seen = new Set([activeKeyId]);
  try {
    for (const [index, rawEntry] of value.split(',').entries()) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const separator = entry.indexOf('=');
      if (separator <= 0) {
        throw new Error(
          `DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry ${index + 1} must be 'keyId=base64key'`,
        );
      }
      const keyId = entry.slice(0, separator).trim();
      if (!isValidEnvelopeKeyId(keyId)) {
        throw new Error(
          `DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry ${index + 1} has an invalid key ID`,
        );
      }
      if (seen.has(keyId)) {
        throw new Error(
          `DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry ${index + 1} has a duplicate or active key ID`,
        );
      }
      seen.add(keyId);
      retained.push({
        keyId,
        key: decodeMasterKey(
          entry.slice(separator + 1).trim(),
          `DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry ${index + 1}`,
        ),
      });
    }
    return retained;
  } catch (error) {
    retained.forEach(({ key }) => key.fill(0));
    throw error;
  }
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Signing-key payload must decode to an object');
}
