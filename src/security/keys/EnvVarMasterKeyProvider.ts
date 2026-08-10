import type { MasterKey, MasterKeyProvider } from './MasterKeyProvider.js';

const KEY_LENGTH = 32;

export class EnvVarMasterKeyProvider implements MasterKeyProvider {
  private readonly key: Buffer;
  private readonly version: number;

  constructor(encodedKey: string | undefined, version = 1) {
    if (!encodedKey || encodedKey.trim().length === 0) {
      throw new Error(
        'DOLLHOUSE_STORAGE_BACKEND=database requires DOLLHOUSE_MASTER_ENCRYPTION_KEY ' +
        'to be set to a base64-encoded 32-byte key',
      );
    }

    const decoded = Buffer.from(encodedKey, 'base64');
    if (decoded.length !== KEY_LENGTH) {
      throw new Error(
        'DOLLHOUSE_MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256',
      );
    }

    this.key = Buffer.from(decoded);
    this.version = version;
  }

  async getCurrentKey(): Promise<MasterKey> {
    return { key: Buffer.from(this.key), version: this.version };
  }

  async getKey(version: number): Promise<MasterKey> {
    if (version !== this.version) {
      throw new Error(`Master encryption key version ${version} is not available`);
    }
    return this.getCurrentKey();
  }
}
