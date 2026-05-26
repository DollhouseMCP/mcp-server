import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const MINIMUM_HMAC_KEY_BYTES = 32;
const OPAQUE_VALUE_BYTES = 32;

export interface IConsoleOpaqueValueService {
  createOpaqueValue(): string;
  hashOpaqueValue(value: string): Buffer;
  matchesHash(value: string, expectedHash: Buffer): boolean;
}

export class HmacConsoleOpaqueValueService implements IConsoleOpaqueValueService {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length < MINIMUM_HMAC_KEY_BYTES) {
      throw new Error('Console opaque-value HMAC key must be at least 32 bytes');
    }
    this.key = Buffer.from(key);
  }

  createOpaqueValue(): string {
    return randomBytes(OPAQUE_VALUE_BYTES).toString('base64url');
  }

  hashOpaqueValue(value: string): Buffer {
    return createHmac('sha256', this.key).update(value, 'utf8').digest();
  }

  matchesHash(value: string, expectedHash: Buffer): boolean {
    const hash = this.hashOpaqueValue(value);
    return expectedHash.length === hash.length && timingSafeEqual(hash, expectedHash);
  }
}
