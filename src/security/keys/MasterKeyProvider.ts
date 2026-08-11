export interface MasterKey {
  key: Buffer;
  version: number;
}

/**
 * Source of the process master key used to wrap token DEKs.
 *
 * The interface is intentionally small so a future KMS-backed provider can
 * replace the env-var provider without changing DatabaseTokenStore.
 */
export interface MasterKeyProvider {
  getCurrentKey(): Promise<MasterKey>;
  getKey(version: number): Promise<MasterKey>;
}
