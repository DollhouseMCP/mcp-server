import { describe, expect, it } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  type ISecretEncryptionService,
  type SecretEncryptionContext,
} from '../../../src/web-console/security/SecretEncryption.js';
import { env } from '../../../src/config/env.js';
import {
  createDefaultSigningKeyPayloadEncryption,
  SigningKeyPayloadEncryption,
} from '../../../src/storage/signingKeys/signingKeyPayloadEncryption.js';

function encryption(): SigningKeyPayloadEncryption {
  return new SigningKeyPayloadEncryption(
    new AeadSecretEncryptionService({ keyId: 'signing-key-test', key: Buffer.alloc(32, 0x5a) }),
    'signing-key-test',
  );
}

describe('SigningKeyPayloadEncryption', () => {
  it('stores private signing material only inside an authenticated ciphertext envelope', () => {
    const service = encryption();
    const payload = { d: 'private-jwk-component', secret: 'cookie-secret' };
    const encrypted = service.encrypt(payload, 'jwks', 'kid-a');

    expect(JSON.stringify(encrypted)).not.toContain('private-jwk-component');
    expect(JSON.stringify(encrypted)).not.toContain('cookie-secret');
    expect(service.decrypt(encrypted, 'jwks', 'kid-a')).toEqual({
      payload,
      legacyPlaintext: false,
      rewrapRequired: false,
    });
  });

  it('binds ciphertext to both key kind and kid through AEAD context', () => {
    const service = encryption();
    const encrypted = service.encrypt({ secret: 'sensitive' }, 'invite', 'invite-a');

    expect(() => service.decrypt(encrypted, 'cookie', 'invite-a')).toThrow(/authentication failed/);
    expect(() => service.decrypt(encrypted, 'invite', 'invite-b')).toThrow(/authentication failed/);
  });

  it('identifies legacy plaintext rows so the PostgreSQL store can rewrap them on read', () => {
    expect(encryption().decrypt({ secret: 'legacy-secret' }, 'cookie', 'legacy-kid')).toEqual({
      payload: { secret: 'legacy-secret' },
      legacyPlaintext: true,
      rewrapRequired: true,
    });
  });

  it('decrypts retained-key envelopes and marks them for safe active-key rewrap', () => {
    const oldKey = { keyId: 'master-v1', key: Buffer.alloc(32, 0x11) };
    const newKey = { keyId: 'master-v2', key: Buffer.alloc(32, 0x22) };
    const oldService = new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService(oldKey),
      oldKey.keyId,
    );
    const encrypted = oldService.encrypt({ secret: 'persisted-secret' }, 'cookie', 'cookie-a');
    const rotatedService = new SigningKeyPayloadEncryption(
      new AeadSecretEncryptionService(newKey, [oldKey]),
      newKey.keyId,
    );

    const decoded = rotatedService.decrypt(encrypted, 'cookie', 'cookie-a');
    expect(decoded).toEqual({
      payload: { secret: 'persisted-secret' },
      legacyPlaintext: false,
      rewrapRequired: true,
    });

    const rewrapped = rotatedService.encrypt(decoded.payload, 'cookie', 'cookie-a');
    expect(rotatedService.decrypt(rewrapped, 'cookie', 'cookie-a').rewrapRequired).toBe(false);
  });

  it('zeros temporary serialized and decrypted signing-key plaintext buffers', () => {
    const encryption = new CapturingEncryptionService();
    const service = new SigningKeyPayloadEncryption(encryption, 'capture-key');

    service.encrypt({ d: 'private-material' }, 'jwks', 'kid-zero');
    expect(encryption.encryptPlaintext?.every(byte => byte === 0)).toBe(true);

    const envelope = {
      format: 'dollhouse-signing-key-aead-v1',
      ciphertext: aeadHeader('capture-key').toString('base64'),
    };
    expect(service.decrypt(envelope, 'jwks', 'kid-zero').payload).toEqual({ d: 'private-material' });
    expect(encryption.decryptPlaintext?.every(byte => byte === 0)).toBe(true);
  });

  it('rejects malformed decrypted payloads without disclosing plaintext', () => {
    const encryption = new MalformedPlaintextEncryptionService();
    const service = new SigningKeyPayloadEncryption(encryption, 'capture-key');
    const envelope = {
      format: 'dollhouse-signing-key-aead-v1',
      ciphertext: aeadHeader('capture-key').toString('base64'),
    };

    expect(() => service.decrypt(envelope, 'jwks', 'kid-malformed')).toThrow(
      'Signing-key payload is malformed',
    );
    try {
      service.decrypt(envelope, 'jwks', 'kid-malformed');
    } catch (error) {
      expect((error as Error).message).not.toContain('SENSITIVE-DECRYPTED-MARKER');
    }
    expect(encryption.decryptPlaintext?.every(byte => byte === 0)).toBe(true);
  });

  it('does not disclose malformed retained-key configuration values in errors', () => {
    const originalKey = env.DOLLHOUSE_MASTER_ENCRYPTION_KEY;
    const originalRetired = env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED;
    const secretValue = 'sensitive-retired-key-material-without-a-separator';
    try {
      env.DOLLHOUSE_MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 0x44).toString('base64');
      env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED = secretValue;

      expect(() => createDefaultSigningKeyPayloadEncryption()).toThrow(
        "DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry 1 must be 'keyId=base64key'",
      );
      try {
        createDefaultSigningKeyPayloadEncryption();
      } catch (error) {
        expect((error as Error).message).not.toContain(secretValue);
      }
    } finally {
      env.DOLLHOUSE_MASTER_ENCRYPTION_KEY = originalKey;
      env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED = originalRetired;
    }
  });

  it.each(['retired key', 'retired-$(id)', 'retired;id', 'retired-é'])(
    'rejects a retained envelope key with a non-portable ID: %s',
    invalidKeyId => {
      const originalKey = env.DOLLHOUSE_MASTER_ENCRYPTION_KEY;
      const originalKeyId = env.DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID;
      const originalRetired = env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED;
      try {
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 0x44).toString('base64');
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID = 'master-v2';
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED =
          `${invalidKeyId}=${Buffer.alloc(32, 0x33).toString('base64')}`;

        expect(() => createDefaultSigningKeyPayloadEncryption()).toThrow(
          'DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED entry 1 has an invalid key ID',
        );
      } finally {
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEY = originalKey;
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID = originalKeyId;
        env.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED = originalRetired;
      }
    },
  );

  it('rejects envelope-key IDs that cannot fit in the ciphertext header', () => {
    expect(() => new AeadSecretEncryptionService({
      keyId: 'é'.repeat(128),
      key: Buffer.alloc(32, 0x44),
    })).toThrow(/at most 255 UTF-8 bytes/);
    expect(() => new AeadSecretEncryptionService(
      { keyId: 'master-v2', key: Buffer.alloc(32, 0x44) },
      [{ keyId: 'r'.repeat(256), key: Buffer.alloc(32, 0x33) }],
    )).toThrow(/at most 255 UTF-8 bytes/);
  });

  it.each(['master key', 'master-$(id)', 'master;id', 'master,key', 'master=key', 'master-é'])(
    'rejects a non-portable envelope-key ID: %s',
    keyId => {
      expect(() => new AeadSecretEncryptionService({
        keyId,
        key: Buffer.alloc(32, 0x44),
      })).toThrow(/use only ASCII letters/);
    },
  );

  it('accepts the full portable grammar at the 255-byte boundary', () => {
    const keyId = `${'a'.repeat(251)}._:-`;
    const service = new AeadSecretEncryptionService({ keyId, key: Buffer.alloc(32, 0x44) });
    const record = service.encrypt(Buffer.from('secret'), { secretClass: 'test', ownerId: 'owner' });

    expect(service.decrypt(record, { secretClass: 'test', ownerId: 'owner' }).toString()).toBe('secret');
  });
});

class CapturingEncryptionService implements ISecretEncryptionService {
  encryptPlaintext: Buffer | null = null;
  decryptPlaintext: Buffer | null = null;

  encrypt(plaintext: Buffer, _context: SecretEncryptionContext): Buffer {
    this.encryptPlaintext = plaintext;
    return aeadHeader('capture-key');
  }

  decrypt(_record: Buffer, _context: SecretEncryptionContext): Buffer {
    this.decryptPlaintext = Buffer.from(JSON.stringify({ d: 'private-material' }), 'utf8');
    return this.decryptPlaintext;
  }
}

class MalformedPlaintextEncryptionService implements ISecretEncryptionService {
  decryptPlaintext: Buffer | null = null;

  encrypt(_plaintext: Buffer, _context: SecretEncryptionContext): Buffer {
    return aeadHeader('capture-key');
  }

  decrypt(_record: Buffer, _context: SecretEncryptionContext): Buffer {
    this.decryptPlaintext = Buffer.from('{"secret":"SENSITIVE-DECRYPTED-MARKER"', 'utf8');
    return this.decryptPlaintext;
  }
}

function aeadHeader(keyId: string): Buffer {
  const encoded = Buffer.from(keyId, 'utf8');
  return Buffer.concat([Buffer.from([1, 1, encoded.length]), encoded, Buffer.alloc(28)]);
}
