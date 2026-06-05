import { describe, expect, it } from '@jest/globals';

import {
  AeadSecretEncryptionService,
  HmacConsoleOpaqueValueService,
} from '../../../../src/web-console/security/index.js';

describe('HmacConsoleOpaqueValueService', () => {
  it('creates opaque values and persists only stable keyed hashes', () => {
    const service = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 1));
    const value = service.createOpaqueValue();
    const hash = service.hashOpaqueValue(value);

    expect(value).not.toEqual(hash.toString('base64url'));
    expect(hash).toHaveLength(32);
    expect(service.matchesHash(value, hash)).toBe(true);
    expect(service.matchesHash('wrong-value', hash)).toBe(false);
  });

  it('requires a sufficiently strong HMAC key', () => {
    expect(() => new HmacConsoleOpaqueValueService(Buffer.alloc(31)))
      .toThrow('at least 32 bytes');
  });
});

describe('AeadSecretEncryptionService', () => {
  const context = { secretClass: 'pkce_verifier', ownerId: 'transaction-1' };
  const activeKey = { keyId: 'key-current', key: Buffer.alloc(32, 2) };

  it('emits versioned authenticated ciphertext and decrypts with matching context', () => {
    const service = new AeadSecretEncryptionService(activeKey);
    const plaintext = Buffer.from('server-side-pkce-verifier');
    const record = service.encrypt(plaintext, context);

    expect(record[0]).toBe(1);
    expect(record.includes(plaintext)).toBe(false);
    expect(service.decrypt(record, context)).toEqual(plaintext);
  });

  it('rejects wrong resource binding, unknown keys, and malformed records', () => {
    const writer = new AeadSecretEncryptionService(activeKey);
    const record = writer.encrypt(Buffer.from('secret'), context);
    const reader = new AeadSecretEncryptionService({
      keyId: 'key-next',
      key: Buffer.alloc(32, 3),
    });

    expect(() => writer.decrypt(record, { ...context, ownerId: 'transaction-2' }))
      .toThrow('authentication failed');
    expect(() => reader.decrypt(record, context)).toThrow('Unknown secret encryption key ID');
    expect(() => writer.decrypt(Buffer.from([1]), context)).toThrow('Invalid secret ciphertext');
  });

  it('decrypts retained key versions during rotation', () => {
    const oldKey = { keyId: 'key-old', key: Buffer.alloc(32, 4) };
    const oldService = new AeadSecretEncryptionService(oldKey);
    const record = oldService.encrypt(Buffer.from('retained-secret'), context);
    const rotated = new AeadSecretEncryptionService({
      keyId: 'key-current',
      key: Buffer.alloc(32, 5),
    }, [oldKey]);

    expect(rotated.decrypt(record, context)).toEqual(Buffer.from('retained-secret'));
  });

  it('rejects tampering with ciphertext authentication inputs and record metadata', () => {
    const service = new AeadSecretEncryptionService(activeKey);
    const record = service.encrypt(Buffer.from('non-empty-secret'), context);
    const keyIdLength = record[2];
    const nonceStart = 3 + keyIdLength;
    const tagStart = nonceStart + 12;
    const ciphertextStart = tagStart + 16;

    for (const offset of [nonceStart, tagStart, ciphertextStart]) {
      const altered = Buffer.from(record);
      altered[offset] ^= 1;
      expect(() => service.decrypt(altered, context)).toThrow('authentication failed');
    }

    const wrongVersion = Buffer.from(record);
    wrongVersion[0] ^= 1;
    expect(() => service.decrypt(wrongVersion, context)).toThrow('format version');

    const wrongAlgorithm = Buffer.from(record);
    wrongAlgorithm[1] ^= 1;
    expect(() => service.decrypt(wrongAlgorithm, context)).toThrow('algorithm');

    const wrongKeyId = Buffer.from(record);
    wrongKeyId[3] ^= 1;
    expect(() => service.decrypt(wrongKeyId, context)).toThrow('Unknown secret encryption key ID');
  });

  it('uses fresh nonces for repeated encryption of the same value', () => {
    const service = new AeadSecretEncryptionService(activeKey);
    const plaintext = Buffer.from('repeatable-value');

    expect(service.encrypt(plaintext, context)).not.toEqual(service.encrypt(plaintext, context));
  });

  it('validates key configuration and context framing without separator collisions', () => {
    expect(() => new AeadSecretEncryptionService({ keyId: '', key: Buffer.alloc(32) }))
      .toThrow('key ID');
    expect(() => new AeadSecretEncryptionService({ keyId: 'short', key: Buffer.alloc(31) }))
      .toThrow('exactly 32 bytes');

    const oversizedKeyId = new AeadSecretEncryptionService({
      keyId: 'x'.repeat(256),
      key: Buffer.alloc(32),
    });
    expect(() => oversizedKeyId.encrypt(Buffer.from('secret'), context)).toThrow('exceeds 255 bytes');
    expect(() => new AeadSecretEncryptionService(activeKey).encrypt(Buffer.from('secret'), {
      secretClass: '',
      ownerId: 'owner',
    })).toThrow('requires class and owner ID');

    const service = new AeadSecretEncryptionService(activeKey);
    const framed = service.encrypt(Buffer.from('secret'), {
      secretClass: 'pkce_verifier\0tenant',
      ownerId: 'owner',
    });
    expect(() => service.decrypt(framed, {
      secretClass: 'pkce_verifier',
      ownerId: 'tenant\0owner',
    })).toThrow('authentication failed');
  });
});
